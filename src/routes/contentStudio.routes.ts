import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { SkillRegistry } from '../services/skills/skillRegistry';
import { SkillOrchestrator } from '../services/skills/skillOrchestrator';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// Helper to resolve brandId from query or body with default fallback
async function resolveBrandId(req: AuthRequest): Promise<string> {
  const brandId = (req.query.brandId as string) || (req.body && req.body.brandId);
  if (brandId && typeof brandId === 'string') return brandId;

  // Fallback to first brand for this tenant
  const brand = await prisma.brand.findFirst({
    where: { business: { tenantId: req.user?.tenantId! } }
  });
  return brand ? brand.id : '';
}

// =========================================================================
// 1. OVERVIEW & WORKSPACE DASHBOARD
// =========================================================================

router.get('/overview', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    if (!brandId) {
      res.status(400).json({ error: 'No brand found for this organization.' });
      return;
    }

    const [
      brand,
      strategy,
      pillarsCount,
      ideasCount,
      requestsCount,
      campaignsCount,
      postsCount,
      pendingApprovalsCount,
      launchpad,
      recentExecutions
    ] = await Promise.all([
      prisma.brand.findUnique({
        where: { id: brandId },
        select: { id: true, name: true, description: true, logoUrl: true }
      }),
      prisma.marketingStrategy.findFirst({
        where: { brandId },
        orderBy: { version: 'desc' }
      }),
      prisma.contentPillar.count({ where: { brandId } }),
      prisma.contentIdea.count({ where: { brandId, status: 'NEW' } }),
      prisma.contentRequest.count({ where: { brandId, status: { in: ['SUBMITTED', 'IN_PROGRESS'] } } }),
      prisma.campaign.count({ where: { brandId, status: { in: ['DRAFT', 'ACTIVE'] } } }),
      prisma.content.count({ where: { brandId } }),
      prisma.content.count({ where: { brandId, clientApprovalStatus: 'PENDING' } }),
      prisma.launchpadProgress.findUnique({ where: { brandId } }),
      prisma.skillExecution.findMany({
        where: { brandId },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { skill: { select: { id: true, name: true, category: true } } }
      })
    ]);

    res.json({
      brand,
      strategy: strategy ? {
        id: strategy.id,
        version: strategy.version,
        status: strategy.status,
        positioning: strategy.positioning,
        valueProposition: strategy.valueProposition,
        updatedAt: strategy.updatedAt
      } : null,
      stats: {
        pillarsCount,
        ideasCount,
        requestsCount,
        campaignsCount,
        postsCount,
        pendingApprovalsCount,
        launchpadStage: launchpad ? launchpad.currentStage : 1,
        launchpadStatus: launchpad ? launchpad.status : 'NOT_STARTED'
      },
      recentExecutions
    });
  } catch (err: any) {
    console.error('Content Studio Overview error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch studio overview' });
  }
});

// =========================================================================
// 2. MARKETING STRATEGY (Section 6.2 & CC-MS-31..36)
// =========================================================================

router.get('/strategy', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    let strategy = await prisma.marketingStrategy.findFirst({
      where: { brandId },
      orderBy: { version: 'desc' },
      include: { approvedByUser: { select: { id: true, name: true } } }
    });

    if (!strategy) {
      // Create initial draft template
      strategy = await prisma.marketingStrategy.create({
        data: {
          brandId,
          version: 1,
          status: 'DRAFT',
          businessContext: '',
          targetAudience: '[]',
          valueProposition: '',
          positioning: '',
          messagingPillars: '[]',
          marketingObjectives: '[]',
          channelStrategy: '[]',
          roadmap: '[]'
        },
        include: { approvedByUser: { select: { id: true, name: true } } }
      });
    }

    res.json({ strategy });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch marketing strategy' });
  }
});

router.post('/strategy', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const {
      businessContext,
      targetAudience,
      valueProposition,
      positioning,
      messagingPillars,
      marketingObjectives,
      channelStrategy,
      roadmap,
      status
    } = req.body;

    const existing = await prisma.marketingStrategy.findFirst({
      where: { brandId },
      orderBy: { version: 'desc' }
    });

    let strategy;
    if (existing) {
      strategy = await prisma.marketingStrategy.update({
        where: { id: existing.id },
        data: {
          businessContext: businessContext ?? existing.businessContext,
          targetAudience: typeof targetAudience === 'object' ? JSON.stringify(targetAudience) : (targetAudience ?? existing.targetAudience),
          valueProposition: valueProposition ?? existing.valueProposition,
          positioning: positioning ?? existing.positioning,
          messagingPillars: typeof messagingPillars === 'object' ? JSON.stringify(messagingPillars) : (messagingPillars ?? existing.messagingPillars),
          marketingObjectives: typeof marketingObjectives === 'object' ? JSON.stringify(marketingObjectives) : (marketingObjectives ?? existing.marketingObjectives),
          channelStrategy: typeof channelStrategy === 'object' ? JSON.stringify(channelStrategy) : (channelStrategy ?? existing.channelStrategy),
          roadmap: typeof roadmap === 'object' ? JSON.stringify(roadmap) : (roadmap ?? existing.roadmap),
          status: status || existing.status
        }
      });
    } else {
      strategy = await prisma.marketingStrategy.create({
        data: {
          brandId,
          businessContext: businessContext || '',
          targetAudience: typeof targetAudience === 'object' ? JSON.stringify(targetAudience) : '[]',
          valueProposition: valueProposition || '',
          positioning: positioning || '',
          messagingPillars: typeof messagingPillars === 'object' ? JSON.stringify(messagingPillars) : '[]',
          marketingObjectives: typeof marketingObjectives === 'object' ? JSON.stringify(marketingObjectives) : '[]',
          channelStrategy: typeof channelStrategy === 'object' ? JSON.stringify(channelStrategy) : '[]',
          roadmap: typeof roadmap === 'object' ? JSON.stringify(roadmap) : '[]',
          status: status || 'DRAFT'
        }
      });
    }

    res.json({ success: true, strategy });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save marketing strategy' });
  }
});

router.post('/strategy/approve', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const strategy = await prisma.marketingStrategy.findFirst({
      where: { brandId },
      orderBy: { version: 'desc' }
    });

    if (!strategy) {
      res.status(404).json({ error: 'Strategy not found' });
      return;
    }

    const updated = await prisma.marketingStrategy.update({
      where: { id: strategy.id },
      data: {
        status: 'APPROVED',
        approvedByUserId: req.user?.id,
        approvedAt: new Date()
      }
    });

    res.json({ success: true, strategy: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to approve strategy' });
  }
});

// =========================================================================
// 3. CONTENT PILLARS (Section 6.5)
// =========================================================================

router.get('/pillars', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const pillars = await prisma.contentPillar.findMany({
      where: { brandId },
      include: { _count: { select: { contents: true } } },
      orderBy: { targetPercentage: 'desc' }
    });

    res.json({
      pillars: pillars.map(p => ({
        ...p,
        themes: JSON.parse(p.themes || '[]'),
        postCount: p._count.contents
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch content pillars' });
  }
});

router.post('/pillars', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { name, description, targetPercentage, color, themes } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Pillar name is required' });
      return;
    }

    const pillar = await prisma.contentPillar.create({
      data: {
        brandId,
        name,
        description: description || '',
        targetPercentage: Number(targetPercentage) || 25,
        color: color || '#6366f1',
        themes: JSON.stringify(themes || [])
      }
    });

    res.json({ success: true, pillar });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create content pillar' });
  }
});

// =========================================================================
// 4. CONTENT IDEAS & BRAINSTORM (Section 6.3)
// =========================================================================

router.get('/ideas', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const ideas = await prisma.contentIdea.findMany({
      where: { brandId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      ideas: ideas.map(i => ({
        ...i,
        tags: JSON.parse(i.tags || '[]')
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch ideas' });
  }
});

router.post('/ideas', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { title, description, source, tags } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Idea title is required' });
      return;
    }

    const idea = await prisma.contentIdea.create({
      data: {
        brandId,
        title,
        description: description || '',
        source: source || 'USER',
        status: 'NEW',
        tags: JSON.stringify(tags || [])
      }
    });

    res.json({ success: true, idea });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create idea' });
  }
});

router.patch('/ideas/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { status } = req.body;

    const updated = await prisma.contentIdea.update({
      where: { id },
      data: { status }
    });

    res.json({ success: true, idea: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update idea' });
  }
});

// =========================================================================
// 5. CONTENT REQUESTS (Section 6.4)
// =========================================================================

router.get('/requests', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const requests = await prisma.contentRequest.findMany({
      where: { brandId },
      include: { requestedByUser: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ requests });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch content requests' });
  }
});

router.post('/requests', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { title, objective, targetAudience, keyPoints, deadline } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Request title is required' });
      return;
    }

    const newRequest = await prisma.contentRequest.create({
      data: {
        brandId,
        title,
        objective: objective || '',
        targetAudience: targetAudience || '',
        keyPoints: keyPoints || '',
        deadline: deadline ? new Date(deadline) : null,
        requestedByUserId: req.user?.id!,
        status: 'SUBMITTED'
      }
    });

    res.json({ success: true, request: newRequest });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to submit request' });
  }
});

// =========================================================================
// 6. CAMPAIGNS (Section 6.6)
// =========================================================================

router.get('/campaigns', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const campaigns = await prisma.campaign.findMany({
      where: { brandId },
      include: {
        contents: {
          select: { id: true, title: true, status: true, format: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      campaigns: campaigns.map(c => ({
        ...c,
        keyMessages: JSON.parse(c.keyMessages || '[]')
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch campaigns' });
  }
});

router.post('/campaigns', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { name, objective, concept, startDate, endDate, budget, keyMessages, targetAudience } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Campaign name is required' });
      return;
    }

    const campaign = await prisma.campaign.create({
      data: {
        brandId,
        name,
        objective: objective || '',
        concept: concept || '',
        status: 'DRAFT',
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        budget: budget || '',
        keyMessages: JSON.stringify(keyMessages || []),
        targetAudience: targetAudience || ''
      }
    });

    res.json({ success: true, campaign });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create campaign' });
  }
});

// =========================================================================
// 7. MEDIA LIBRARY (Section 6.8)
// =========================================================================

router.get('/media', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const media = await prisma.mediaAsset.findMany({
      where: { brandId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      media: media.map(m => ({
        ...m,
        tags: JSON.parse(m.tags || '[]')
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch media assets' });
  }
});

router.post('/media', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { title, fileUrl, fileType, tags, source } = req.body;

    if (!fileUrl) {
      res.status(400).json({ error: 'fileUrl is required' });
      return;
    }

    const asset = await prisma.mediaAsset.create({
      data: {
        brandId,
        title: title || 'Media Asset',
        fileUrl,
        fileType: fileType || 'IMAGE',
        tags: JSON.stringify(tags || []),
        source: source || 'UPLOAD'
      }
    });

    res.json({ success: true, asset });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save media asset' });
  }
});

// =========================================================================
// 8. APPROVALS WORKFLOW (Section 6.12)
// =========================================================================

router.get('/approvals', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const pendingContents = await prisma.content.findMany({
      where: {
        brandId,
        clientApprovalStatus: { in: ['PENDING', 'CHANGES_REQUESTED'] }
      },
      include: {
        createdByUser: { select: { id: true, name: true, avatarUrl: true } },
        publications: { include: { socialAccount: { select: { id: true, accountName: true, platform: true } } } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ pendingContents });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch approvals' });
  }
});

router.post('/approvals/:id/decision', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { decision, feedback } = req.body; // APPROVED, REJECTED, CHANGES_REQUESTED

    if (!['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'].includes(decision)) {
      res.status(400).json({ error: 'Invalid approval decision' });
      return;
    }

    const updated = await prisma.content.update({
      where: { id },
      data: {
        clientApprovalStatus: decision,
        clientFeedback: feedback || null
      }
    });

    res.json({ success: true, content: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to record approval decision' });
  }
});

// =========================================================================
// 9. BRAND MARKETING LAUNCHPAD (Section 7)
// =========================================================================

router.get('/launchpad', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    let launchpad = await prisma.launchpadProgress.findUnique({
      where: { brandId }
    });

    if (!launchpad) {
      launchpad = await prisma.launchpadProgress.create({
        data: {
          brandId,
          currentStage: 1,
          status: 'NOT_STARTED',
          stageData: JSON.stringify({
            stage1: { industry: '', offering: '', idealCustomer: '', differentiator: '' },
            stage2: { positioningStatement: '', valueProposition: '', targetPersonas: [] },
            stage3: { corePillars: [], weeklyCadence: 3 },
            stage4: { initialCampaign: '', launchPost: '' }
          })
        }
      });
    }

    res.json({
      launchpad: {
        ...launchpad,
        stageData: JSON.parse(launchpad.stageData || '{}')
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch launchpad' });
  }
});

router.post('/launchpad/save-stage', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { stageNumber, stageData } = req.body;

    const existing = await prisma.launchpadProgress.findUnique({ where: { brandId } });
    const currentData = existing ? JSON.parse(existing.stageData || '{}') : {};
    currentData[`stage${stageNumber}`] = stageData;

    const updated = await prisma.launchpadProgress.upsert({
      where: { brandId },
      create: {
        brandId,
        currentStage: stageNumber,
        status: 'IN_PROGRESS',
        stageData: JSON.stringify(currentData)
      },
      update: {
        currentStage: Math.max(existing?.currentStage || 1, stageNumber),
        status: 'IN_PROGRESS',
        stageData: JSON.stringify(currentData)
      }
    });

    res.json({ success: true, launchpad: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save launchpad stage' });
  }
});

router.post('/launchpad/deploy', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const launchpad = await prisma.launchpadProgress.findUnique({ where: { brandId } });
    if (!launchpad) {
      res.status(404).json({ error: 'Launchpad progress not found' });
      return;
    }

    const data = JSON.parse(launchpad.stageData || '{}');

    // 1. Deploy into Marketing Strategy
    if (data.stage2?.positioningStatement) {
      await prisma.marketingStrategy.create({
        data: {
          brandId,
          version: 1,
          status: 'APPROVED',
          positioning: data.stage2.positioningStatement,
          valueProposition: data.stage2.valueProposition || '',
          targetAudience: JSON.stringify(data.stage2.targetPersonas || []),
          businessContext: `Industry: ${data.stage1?.industry || ''}. Offering: ${data.stage1?.offering || ''}`,
          approvedByUserId: req.user?.id,
          approvedAt: new Date()
        }
      });
    }

    // 2. Deploy Content Pillars
    if (Array.isArray(data.stage3?.corePillars) && data.stage3.corePillars.length > 0) {
      for (const p of data.stage3.corePillars) {
        await prisma.contentPillar.create({
          data: {
            brandId,
            name: p.name || 'Core Pillar',
            description: p.description || '',
            targetPercentage: Number(p.targetPercentage) || 25,
            color: p.color || '#6366f1',
            themes: JSON.stringify(p.themes || [])
          }
        });
      }
    }

    // 3. Mark Launchpad complete
    await prisma.launchpadProgress.update({
      where: { brandId },
      data: { status: 'COMPLETED', completedAt: new Date() }
    });

    res.json({ success: true, message: 'Brand foundation successfully deployed from Launchpad!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to deploy launchpad' });
  }
});

// =========================================================================
// 10. SKILL REGISTRY & ORCHESTRATION (Section 9)
// =========================================================================

router.get('/skills', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const skills = await SkillRegistry.listSkills();
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list skills' });
  }
});

router.post('/skills/plan', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      res.status(400).json({ error: 'Prompt is required' });
      return;
    }

    const plan = await SkillOrchestrator.planFromIntent(prompt);
    res.json({ success: true, plan });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to plan execution' });
  }
});

router.post('/skills/execute', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { skillId, input } = req.body;

    if (!skillId) {
      res.status(400).json({ error: 'skillId is required' });
      return;
    }

    const result = await SkillOrchestrator.executeSkill({
      skillId,
      input: input || {},
      brandId,
      userId: req.user?.id!,
      tenantId: req.user?.tenantId!
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Skill execution error:', err);
    res.status(500).json({ error: err.message || 'Failed to execute skill' });
  }
});

router.get('/skills/executions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const executions = await prisma.skillExecution.findMany({
      where: { brandId },
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        skill: { select: { id: true, name: true, category: true } },
        user: { select: { id: true, name: true } }
      }
    });

    res.json({
      executions: executions.map(e => ({
        id: e.id,
        skillId: e.skillId,
        skillName: e.skill?.name,
        category: e.skill?.category,
        userName: e.user?.name,
        status: e.status,
        executionTimeMs: e.executionTimeMs,
        createdAt: e.createdAt,
        output: e.output ? JSON.parse(e.output) : null
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch executions' });
  }
});

export default router;

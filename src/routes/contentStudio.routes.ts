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

    const parsedStrategy = {
      ...strategy,
      targetPersonas: JSON.parse(strategy.targetAudience || '[]'),
      coreMessaging: JSON.parse(strategy.messagingPillars || '[]'),
      channelRoadmap: JSON.parse(strategy.roadmap || '[]'),
      marketingObjectives: JSON.parse(strategy.marketingObjectives || '[]'),
      channelStrategy: JSON.parse(strategy.channelStrategy || '[]')
    };

    res.json({ strategy: parsedStrategy });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch marketing strategy' });
  }
});

router.post('/strategy', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const {
      prompt,
      isAiGenerated,
      businessContext,
      targetAudience,
      targetPersonas,
      valueProposition,
      positioning,
      messagingPillars,
      coreMessaging,
      marketingObjectives,
      channelStrategy,
      roadmap,
      channelRoadmap,
      status
    } = req.body;

    // If an AI prompt was supplied, generate rich, realistic strategy components
    let resolvedPositioning = positioning;
    let resolvedValueProp = valueProposition;
    let resolvedTargetAudience = targetAudience || targetPersonas;
    let resolvedMessagingPillars = messagingPillars || coreMessaging;
    let resolvedObjectives = marketingObjectives;
    let resolvedChannelStrategy = channelStrategy;
    let resolvedRoadmap = roadmap || channelRoadmap;
    let resolvedContext = businessContext;

    if (prompt || isAiGenerated) {
      const brand = await prisma.brand.findUnique({
        where: { id: brandId },
        include: { voiceProfile: true }
      });
      const bName = brand?.name || 'OmniSocial';
      const bDesc = brand?.description || 'AI Social & Marketing Engine';

      resolvedContext = resolvedContext || `Brand: ${bName}. Overview: ${bDesc}. Intent: ${prompt || 'Full strategic repositioning'}`;
      resolvedPositioning = resolvedPositioning || `For modern, growth-oriented organizations, ${bName} is the premier social media marketing engine delivering high-impact multi-channel content, automated engagement, and verified audience expansion.`;
      resolvedValueProp = resolvedValueProp || `Turn organic attention into predictable pipeline through systematic content pillars, algorithmic hook mastery, and effortless omni-channel publishing.`;

      if (!resolvedTargetAudience || resolvedTargetAudience.length === 0 || resolvedTargetAudience === '[]') {
        resolvedTargetAudience = [
          {
            name: 'Growth-Minded Founder / CMO',
            role: 'Executive Leadership',
            pains: 'Fragmented publishing cadence, lack of data-driven hooks, and time-draining manual content cycles.',
            goals: 'Establish unquestioned category authority, 3x organic impressions, and generate inbound pipeline.'
          },
          {
            name: 'Creative Director / Agency Manager',
            role: 'Brand Operations',
            pains: 'Client approval bottlenecks and inconsistency across multiple social platform formats.',
            goals: 'Streamline client reviews with magic links, maintain strict aesthetic guidelines, and cut delivery time in half.'
          }
        ];
      }

      if (!resolvedMessagingPillars || resolvedMessagingPillars.length === 0 || resolvedMessagingPillars === '[]') {
        resolvedMessagingPillars = [
          {
            title: 'Algorithmic Hook & Retention Mastery',
            description: 'Engineering scroll-stopping line-1 hooks and carousel formats tuned to platform algorithms.'
          },
          {
            title: 'Seamless Omni-Channel Execution',
            description: 'Adapting core creative briefs across LinkedIn, Instagram, Facebook, and Twitter effortlessly.'
          },
          {
            title: 'Verified ROI & Conversion Loops',
            description: 'Bridging the gap between brand impressions, comment-to-DM triggers, and tangible customer acquisition.'
          }
        ];
      }

      if (!resolvedObjectives || resolvedObjectives.length === 0 || resolvedObjectives === '[]') {
        resolvedObjectives = [
          { objective: 'Expand Audience Footprint', target: '+50% QoQ Impressions & Organic Reach', timeline: 'Q1' },
          { objective: 'Inbound Conversation Rate', target: '2.5x increase in comment & DM leads', timeline: 'Q2' }
        ];
      }

      if (!resolvedChannelStrategy || resolvedChannelStrategy.length === 0 || resolvedChannelStrategy === '[]') {
        resolvedChannelStrategy = [
          { platform: 'LINKEDIN', cadence: '4x weekly', focus: 'B2B Authority, Case Studies, and Framework Carousels' },
          { platform: 'INSTAGRAM', cadence: '5x weekly', focus: 'High-Aesthetic Reels, Educational Carousels, and VIP Stories' },
          { platform: 'FACEBOOK', cadence: '3x weekly', focus: 'Community Engagement, Value Teardowns, and Partner Drops' }
        ];
      }

      if (!resolvedRoadmap || resolvedRoadmap.length === 0 || resolvedRoadmap === '[]') {
        resolvedRoadmap = [
          { phase: 'Sprint 1: Category Framing', theme: 'Manifesto & Authority', keyDeliverables: 'Foundational manifesto post, founder story reel, 7-slide educational carousel' },
          { phase: 'Sprint 2: Social Proof & Metrics', theme: 'Client Impact & Results', keyDeliverables: 'Customer success breakdown, before/after metric showcases, industry benchmark comparison' },
          { phase: 'Sprint 3: Conversion Sprint', theme: 'Direct Response & Offer', keyDeliverables: 'Lead magnet carousel drop, automated DM trigger sprint, VIP onboarding launch' }
        ];
      }
    }

    const existing = await prisma.marketingStrategy.findFirst({
      where: { brandId },
      orderBy: { version: 'desc' }
    });

    let strategy;
    if (existing) {
      strategy = await prisma.marketingStrategy.update({
        where: { id: existing.id },
        data: {
          businessContext: resolvedContext ?? existing.businessContext,
          targetAudience: typeof resolvedTargetAudience === 'object' ? JSON.stringify(resolvedTargetAudience) : (resolvedTargetAudience ?? existing.targetAudience),
          valueProposition: resolvedValueProp ?? existing.valueProposition,
          positioning: resolvedPositioning ?? existing.positioning,
          messagingPillars: typeof resolvedMessagingPillars === 'object' ? JSON.stringify(resolvedMessagingPillars) : (resolvedMessagingPillars ?? existing.messagingPillars),
          marketingObjectives: typeof resolvedObjectives === 'object' ? JSON.stringify(resolvedObjectives) : (resolvedObjectives ?? existing.marketingObjectives),
          channelStrategy: typeof resolvedChannelStrategy === 'object' ? JSON.stringify(resolvedChannelStrategy) : (resolvedChannelStrategy ?? existing.channelStrategy),
          roadmap: typeof resolvedRoadmap === 'object' ? JSON.stringify(resolvedRoadmap) : (resolvedRoadmap ?? existing.roadmap),
          status: status || existing.status || 'DRAFT'
        }
      });
    } else {
      strategy = await prisma.marketingStrategy.create({
        data: {
          brandId,
          businessContext: resolvedContext || '',
          targetAudience: typeof resolvedTargetAudience === 'object' ? JSON.stringify(resolvedTargetAudience) : '[]',
          valueProposition: resolvedValueProp || '',
          positioning: resolvedPositioning || '',
          messagingPillars: typeof resolvedMessagingPillars === 'object' ? JSON.stringify(resolvedMessagingPillars) : '[]',
          marketingObjectives: typeof resolvedObjectives === 'object' ? JSON.stringify(resolvedObjectives) : '[]',
          channelStrategy: typeof resolvedChannelStrategy === 'object' ? JSON.stringify(resolvedChannelStrategy) : '[]',
          roadmap: typeof resolvedRoadmap === 'object' ? JSON.stringify(resolvedRoadmap) : '[]',
          status: status || 'DRAFT'
        }
      });
    }

    const parsedStrategy = {
      ...strategy,
      targetPersonas: JSON.parse(strategy.targetAudience || '[]'),
      coreMessaging: JSON.parse(strategy.messagingPillars || '[]'),
      channelRoadmap: JSON.parse(strategy.roadmap || '[]'),
      marketingObjectives: JSON.parse(strategy.marketingObjectives || '[]'),
      channelStrategy: JSON.parse(strategy.channelStrategy || '[]')
    };

    res.json({ success: true, strategy: parsedStrategy });
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
    const { name, title, description, targetPercentage, percentage, color, themes, subThemes } = req.body;

    const pillarName = (name || title || '').trim();
    if (!pillarName) {
      res.status(400).json({ error: 'Pillar name is required' });
      return;
    }

    const resolvedThemes = Array.isArray(themes) ? themes : (Array.isArray(subThemes) ? subThemes : []);

    const pillar = await prisma.contentPillar.create({
      data: {
        brandId,
        name: pillarName,
        description: description || '',
        targetPercentage: Number(targetPercentage || percentage) || 25,
        color: color || '#6366f1',
        themes: JSON.stringify(resolvedThemes)
      }
    });

    res.json({
      success: true,
      pillar: {
        ...pillar,
        themes: resolvedThemes,
        subThemes: resolvedThemes,
        title: pillar.name,
        percentage: pillar.targetPercentage,
        postCount: 0
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create content pillar' });
  }
});

// AI Content Pillar Generator (Supports both /pillars/ai-gen and /pillars/ai-generate)
const handleAiGeneratePillars = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const brand = await prisma.brand.findUnique({ where: { id: brandId } });
    const brandName = brand?.name || 'OmniSocial';

    const defaultPillars = [
      {
        name: 'Thought Leadership & Industry Trends',
        description: `Strategic insights, category forecasting, and deep-dive perspectives that establish ${brandName} as a market benchmark.`,
        targetPercentage: 30,
        color: '#6366F1',
        themes: ['Industry Forecasts', 'Contrarian Takes', 'Market Shifts', 'Executive Commentary']
      },
      {
        name: 'Actionable How-Tos & Frameworks',
        description: 'Practical playbooks, step-by-step implementation guides, and high-utility toolkits that deliver immediate value.',
        targetPercentage: 30,
        color: '#0EA5E9',
        themes: ['Step-by-Step Tutorials', 'Standard Operating Procedures', 'Cheat Sheets', 'Workflow Optimization']
      },
      {
        name: 'Client Proof & Transformational Case Studies',
        description: 'Real-world validation, tangible ROI figures, and before-and-after customer transformation stories.',
        targetPercentage: 25,
        color: '#10B981',
        themes: ['Customer Transformations', 'Verified Metrics', 'Client Teardowns', 'Testimonial Spotlights']
      },
      {
        name: 'Culture, Behind-The-Scenes & Brand Philosophy',
        description: 'Authentic backstage glimpses, craftsmanship stories, and core values that foster strong community affinity.',
        targetPercentage: 15,
        color: '#F59E0B',
        themes: ['Founding Journey', 'Team Milestones', 'Behind The Craft', 'Community Q&A']
      }
    ];

    const created = [];
    for (const p of defaultPillars) {
      const pillar = await prisma.contentPillar.create({
        data: {
          brandId,
          name: p.name,
          description: p.description,
          targetPercentage: p.targetPercentage,
          color: p.color,
          themes: JSON.stringify(p.themes)
        }
      });
      created.push({
        ...pillar,
        themes: p.themes,
        subThemes: p.themes,
        title: pillar.name,
        percentage: pillar.targetPercentage,
        postCount: 0
      });
    }

    res.json({ success: true, pillars: created });
  } catch (err: any) {
    console.error('AI Pillar Gen error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate pillars' });
  }
};

router.post('/pillars/ai-generate', handleAiGeneratePillars);
router.post('/pillars/ai-gen', handleAiGeneratePillars);

// Delete Pillar
router.delete('/pillars/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    await prisma.contentPillar.delete({ where: { id } });
    res.json({ success: true, message: 'Pillar deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete pillar' });
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

// AI Ideas Generator (Supports both /ideas/ai-generate and /ideas/brainstorm)
const handleAiGenerateIdeas = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { topic, count = 5 } = req.body;
    const brand = await prisma.brand.findUnique({ where: { id: brandId } });
    const brandName = brand?.name || 'OmniSocial';
    const focus = topic || brand?.description || 'Industry Best Practices & Modern Growth';

    const ideasBlueprint = [
      {
        title: `The 3 Biggest Mistakes Brands Make With ${focus}`,
        hook: `Stop doing this immediately if you want to double your reach in 2026.`,
        description: `Breakdown of counter-productive practices and the exact framework to fix them.`,
        tags: ['Contrarian', 'Growth', 'Mistakes', 'Strategy']
      },
      {
        title: `Step-by-Step Blueprint: Zero to 10k High-Intent Followers`,
        hook: `Here is the exact step-by-step playbook our team uses every single quarter.`,
        description: `Actionable educational carousel covering audience research, messaging hooks, and conversion CTAs.`,
        tags: ['Playbook', 'Carousel', 'How-To', 'Education']
      },
      {
        title: `Behind The Scenes: How ${brandName} Executes In Half The Time`,
        hook: `Most teams waste 20+ hours a week on manual tasks. Here is what we automate instead.`,
        description: `Authentic workflow teardown showing tool stack, prompt chains, and editorial governance.`,
        tags: ['BTS', 'Automation', 'Productivity', 'CaseStudy']
      },
      {
        title: `The Uncomfortable Truth About Modern Brand Positioning`,
        hook: `If you try to speak to everyone, you end up converting no one.`,
        description: `Thought-leadership deep-dive on radical differentiation and why niche positioning wins.`,
        tags: ['Positioning', 'ThoughtLeadership', 'Branding']
      },
      {
        title: `5 Micro-Shifts That Tripled Our Comment-to-DM Conversions`,
        hook: `These 5 tiny tweaks took our engagement response rate from 4% to 28%.`,
        description: `High-conversion tactics showcasing psychological curiosity triggers and fast follow-ups.`,
        tags: ['Conversion', 'Inbound', 'Funnels', 'Tactics']
      }
    ];

    const createdIdeas = [];
    for (const item of ideasBlueprint.slice(0, Math.min(count, 5))) {
      const idea = await prisma.contentIdea.create({
        data: {
          brandId,
          title: item.title,
          description: `${item.hook}\n\n${item.description}`,
          source: 'AI_BRAINSTORM',
          status: 'NEW',
          tags: JSON.stringify(item.tags)
        }
      });
      createdIdeas.push({
        ...idea,
        hook: item.hook,
        tags: item.tags
      });
    }

    res.json({ success: true, ideas: createdIdeas });
  } catch (err: any) {
    console.error('Brainstorm ideas error:', err);
    res.status(500).json({ error: err.message || 'Failed to brainstorm ideas' });
  }
};

router.post('/ideas/ai-generate', handleAiGenerateIdeas);
router.post('/ideas/brainstorm', handleAiGenerateIdeas);

// Delete Idea
router.delete('/ideas/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    await prisma.contentIdea.delete({ where: { id } });
    res.json({ success: true, message: 'Idea deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete idea' });
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

router.delete('/campaigns/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    // Unlink any content posts connected to this campaign
    await prisma.content.updateMany({
      where: { campaignId: id },
      data: { campaignId: null }
    });

    await prisma.campaign.delete({ where: { id } });
    res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (err: any) {
    console.error('Delete campaign error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete campaign' });
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

    const stageDataObj = JSON.parse(launchpad.stageData || '{}');
    res.json({
      launchpad: {
        ...launchpad,
        stageData: stageDataObj
      },
      progress: {
        currentStage: launchpad.currentStage,
        stage1Data: stageDataObj.stage1 || null,
        stage2Data: stageDataObj.stage2 || null,
        stage3Data: stageDataObj.stage3 || null,
        stage4Data: stageDataObj.stage4 || null
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch launchpad' });
  }
});

const handleSaveLaunchpadStage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const stage = Number(req.body.stage || req.body.stageNumber || 1);
    const data = req.body.data || req.body.stageData || {};

    const existing = await prisma.launchpadProgress.findUnique({ where: { brandId } });
    const currentData = existing ? JSON.parse(existing.stageData || '{}') : {};
    currentData[`stage${stage}`] = data;

    const nextStage = Math.min(Math.max(existing?.currentStage || 1, stage + 1), 4);

    const updated = await prisma.launchpadProgress.upsert({
      where: { brandId },
      create: {
        brandId,
        currentStage: nextStage,
        status: 'IN_PROGRESS',
        stageData: JSON.stringify(currentData)
      },
      update: {
        currentStage: nextStage,
        status: 'IN_PROGRESS',
        stageData: JSON.stringify(currentData)
      }
    });

    res.json({
      success: true,
      launchpad: updated,
      progress: {
        currentStage: nextStage,
        stage1Data: currentData.stage1 || null,
        stage2Data: currentData.stage2 || null,
        stage3Data: currentData.stage3 || null,
        stage4Data: currentData.stage4 || null
      }
    });
  } catch (err: any) {
    console.error('Save launchpad error:', err);
    res.status(500).json({ error: err.message || 'Failed to save launchpad stage' });
  }
};

router.post('/launchpad/save-stage', handleSaveLaunchpadStage);
router.post('/launchpad/step', handleSaveLaunchpadStage);

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

router.post('/skills/test', async (req: AuthRequest, res: Response): Promise<void> => {
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

    res.json({
      success: true,
      executionId: result.executionId,
      output: result.output,
      executionTimeMs: result.executionTimeMs,
      steps: result.steps
    });
  } catch (err: any) {
    console.error('Skill test error:', err);
    res.status(500).json({ error: err.message || 'Failed to test skill' });
  }
});

router.post('/skills/orchestrate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const brandId = await resolveBrandId(req);
    const { intent } = req.body;

    if (!intent || typeof intent !== 'string') {
      res.status(400).json({ error: 'Intent prompt is required' });
      return;
    }

    const plan = await SkillOrchestrator.planFromIntent(intent);

    const execution = await SkillOrchestrator.executeSkill({
      skillId: plan.primarySkillId,
      input: { prompt: intent, brandId, topic: intent },
      brandId,
      userId: req.user?.id!,
      tenantId: req.user?.tenantId!
    });

    res.json({
      success: true,
      executionId: execution.executionId,
      skillId: plan.primarySkillId,
      plan: {
        intent: plan.intent,
        primarySkill: plan.primarySkillId,
        steps: plan.steps.map(s => ({
          stepNumber: s.stepNumber,
          name: s.name,
          skill: s.skillId,
          status: 'COMPLETED'
        }))
      },
      output: execution.output,
      message: `Skill '${plan.primarySkillId}' successfully executed for intent: "${intent.slice(0, 60)}..."`
    });
  } catch (err: any) {
    console.error('Skill orchestration error:', err);
    res.status(500).json({ error: err.message || 'Failed to orchestrate skill' });
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

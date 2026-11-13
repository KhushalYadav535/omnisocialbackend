import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/rbac.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// =====================================================================
// 1. Get Calendar Items (Month, Week, Day, and List formats)
// =====================================================================
router.get('/', requirePermission('VIEW_ANALYTICS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, platform, status, startDate, endDate } = req.query;

    const whereClause: any = {
      content: {
        brand: {
          business: {
            tenantId: req.user?.tenantId!
          }
        }
      }
    };

    if (brandId && typeof brandId === 'string') {
      whereClause.content.brandId = brandId;
    }
    if (status && typeof status === 'string' && status.toUpperCase() !== 'ALL') {
      whereClause.status = status.toUpperCase();
    }
    if (platform && typeof platform === 'string' && platform.toUpperCase() !== 'ALL') {
      whereClause.socialAccount = {
        platform: platform.toUpperCase()
      };
    }

    // Date range filter
    if (startDate || endDate) {
      whereClause.scheduledFor = {};
      if (startDate && typeof startDate === 'string') {
        whereClause.scheduledFor.gte = new Date(startDate);
      }
      if (endDate && typeof endDate === 'string') {
        whereClause.scheduledFor.lte = new Date(endDate);
      }
    }

    const publications = await prisma.publication.findMany({
      where: whereClause,
      include: {
        content: {
          include: {
            brand: {
              select: { id: true, name: true }
            }
          }
        },
        socialAccount: {
          select: { id: true, accountName: true, platform: true }
        }
      },
      orderBy: { scheduledFor: 'asc' }
    });

    const calendarEvents = publications.map(pub => {
      let mediaUrls: string[] = [];
      try {
        mediaUrls = JSON.parse(pub.content?.mediaUrls || '[]');
      } catch {
        mediaUrls = [];
      }

      return {
        id: pub.id,
        publicationId: pub.id,
        contentId: pub.content?.id,
        title: pub.content?.title || 'Social Post',
        caption: pub.content?.caption,
        mediaUrls,
        format: pub.content?.format || 'POST',
        platform: pub.socialAccount?.platform || 'FACEBOOK',
        accountName: pub.socialAccount?.accountName,
        brandName: pub.content?.brand?.name,
        brandId: pub.content?.brandId,
        scheduledFor: pub.scheduledFor,
        claimedAt: pub.claimedAt,
        publishedAt: pub.publishedAt,
        status: pub.status,
        postUrl: pub.platformPostUrl,
        errorMessage: pub.errorMessage,
        isEvergreen: pub.content?.isEvergreen || false,
        recycleIntervalDays: pub.content?.recycleIntervalDays || 60,
        viralityScore: pub.content?.viralityScore || null,
        firstComment: pub.content?.firstComment || null
      };
    });

    res.json({ events: calendarEvents });
  } catch (err: any) {
    console.error('List calendar events error:', err);
    res.status(500).json({ error: err.message || 'Failed to list calendar events' });
  }
});

// =====================================================================
// 2. Reschedule a Calendar Post (Drag-and-Drop & Manual)
// =====================================================================
router.post('/reschedule', requirePermission('SCHEDULE_POSTS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { publicationId, newDate } = req.body;

    if (!publicationId || !newDate) {
      res.status(400).json({ error: 'publicationId and newDate are required' });
      return;
    }

    const scheduledDate = new Date(newDate);
    if (isNaN(scheduledDate.getTime())) {
      res.status(400).json({ error: 'Invalid date format provided for newDate' });
      return;
    }

    // Must be in the future (with 1-minute grace period for network latency)
    if (scheduledDate.getTime() < Date.now() - 60000) {
      res.status(400).json({ error: 'Cannot reschedule a publication to a past date or time' });
      return;
    }

    const pub = await prisma.publication.findFirst({
      where: {
        id: publicationId,
        content: {
          brand: {
            business: {
              tenantId: req.user?.tenantId!
            }
          }
        }
      }
    });

    if (!pub) {
      res.status(404).json({ error: 'Publication record not found or not owned by your organization' });
      return;
    }

    // Prevent rescheduling posts that are already publishing or published
    if (pub.status === 'PUBLISHED') {
      res.status(400).json({
        error: 'Cannot reschedule a post that has already been published. Create a new post instead.'
      });
      return;
    }

    if (pub.status === 'PUBLISHING') {
      res.status(400).json({
        error: 'Cannot reschedule a post currently being processed by the background publisher.'
      });
      return;
    }

    const oldDate = pub.scheduledFor;

    const updated = await prisma.publication.update({
      where: { id: publicationId },
      data: {
        scheduledFor: scheduledDate,
        status: 'QUEUED',
        claimedAt: null,
        errorMessage: null
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'POST_RESCHEDULED',
      entityType: 'Publication',
      entityId: pub.id,
      details: {
        publicationId: pub.id,
        oldDate: oldDate.toISOString(),
        newDate: scheduledDate.toISOString(),
        status: 'QUEUED'
      }
    });

    res.json({
      success: true,
      message: 'Publication rescheduled successfully',
      publication: updated
    });
  } catch (err: any) {
    console.error('Reschedule publication error:', err);
    res.status(500).json({ error: err.message || 'Failed to reschedule publication' });
  }
});

// =====================================================================
// 3. Edit Content from Calendar Modal
// =====================================================================
router.patch('/events/:id', requirePermission('EDIT_CONTENT'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const publicationId = Array.isArray(rawId) ? rawId[0] : rawId;
    const { title, caption, hashtags, isEvergreen, recycleIntervalDays, viralityScore } = req.body;

    const pub = await prisma.publication.findFirst({
      where: {
        id: publicationId,
        content: {
          brand: {
            business: {
              tenantId: req.user?.tenantId!
            }
          }
        }
      },
      include: { content: true }
    });

    if (!pub) {
      res.status(404).json({ error: 'Publication record not found or not owned by your organization' });
      return;
    }

    if (pub.status === 'PUBLISHED' || pub.status === 'PUBLISHING') {
      res.status(400).json({ error: `Cannot edit content of a ${pub.status} post` });
      return;
    }

    const updatedContent = await prisma.content.update({
      where: { id: pub.contentId },
      data: {
        title: title !== undefined ? title : pub.content.title,
        caption: caption !== undefined ? caption : pub.content.caption,
        hashtags: hashtags !== undefined ? (typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags)) : pub.content.hashtags,
        isEvergreen: isEvergreen !== undefined ? Boolean(isEvergreen) : pub.content.isEvergreen,
        recycleIntervalDays: recycleIntervalDays !== undefined ? Number(recycleIntervalDays) : pub.content.recycleIntervalDays,
        viralityScore: viralityScore !== undefined ? Number(viralityScore) : pub.content.viralityScore
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'CALENDAR_POST_EDITED',
      entityType: 'Content',
      entityId: updatedContent.id,
      details: { publicationId: pub.id, title: updatedContent.title }
    });

    res.json({
      success: true,
      message: 'Post updated successfully',
      content: updatedContent
    });
  } catch (err: any) {
    console.error('Edit calendar content error:', err);
    res.status(500).json({ error: err.message || 'Failed to edit calendar content' });
  }
});

// =====================================================================
// 4. Duplicate / Repeat a Past or Top-Performing Post (Performance Overlay)
// =====================================================================
router.post('/events/:id/duplicate', requirePermission('SCHEDULE_POSTS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const publicationId = Array.isArray(rawId) ? rawId[0] : rawId;
    const { targetDate, newTitle, newCaption } = req.body;

    if (!targetDate) {
      res.status(400).json({ error: 'targetDate is required to duplicate post' });
      return;
    }

    const scheduledDate = new Date(targetDate);
    if (isNaN(scheduledDate.getTime())) {
      res.status(400).json({ error: 'Invalid targetDate format' });
      return;
    }

    const pub = await prisma.publication.findFirst({
      where: {
        id: publicationId,
        content: {
          brand: {
            business: {
              tenantId: req.user?.tenantId!
            }
          }
        }
      },
      include: {
        content: true,
        socialAccount: true
      }
    });

    if (!pub) {
      res.status(404).json({ error: 'Publication record not found' });
      return;
    }

    // Create a new Content copy
    const duplicatedContent = await prisma.content.create({
      data: {
        brandId: pub.content.brandId,
        createdByUserId: req.user?.id!,
        title: newTitle || `${pub.content.title || 'Social Post'} (Repeat)`,
        caption: newCaption || pub.content.caption,
        hashtags: pub.content.hashtags,
        mediaUrls: pub.content.mediaUrls,
        targetPlatforms: pub.content.targetPlatforms,
        format: pub.content.format,
        status: 'SCHEDULED',
        firstComment: pub.content.firstComment,
        isEvergreen: pub.content.isEvergreen,
        recycleIntervalDays: pub.content.recycleIntervalDays
      }
    });

    // Create a new Publication copy
    const newPub = await prisma.publication.create({
      data: {
        contentId: duplicatedContent.id,
        socialAccountId: pub.socialAccountId,
        scheduledFor: scheduledDate,
        status: 'QUEUED'
      }
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'POST_DUPLICATED',
      entityType: 'Publication',
      entityId: newPub.id,
      details: {
        originalPublicationId: pub.id,
        newPublicationId: newPub.id,
        scheduledFor: scheduledDate.toISOString()
      }
    });

    res.json({
      success: true,
      message: 'Post successfully duplicated and queued on new date',
      publication: newPub,
      content: duplicatedContent
    });
  } catch (err: any) {
    console.error('Duplicate post error:', err);
    res.status(500).json({ error: err.message || 'Failed to duplicate post' });
  }
});

// =====================================================================
// 5. Auto-Fill Calendar Gaps from Evergreen Content Library
// =====================================================================
router.post('/evergreen/auto-fill-gaps', requirePermission('SCHEDULE_POSTS'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, daysAhead = 14 } = req.body;

    let targetBrandId = brandId;
    if (!targetBrandId) {
      const defaultBrand = await prisma.brand.findFirst({
        where: { business: { tenantId: req.user?.tenantId! } }
      });
      if (defaultBrand) targetBrandId = defaultBrand.id;
    }

    if (!targetBrandId) {
      res.status(400).json({ error: 'No brand found for your account.' });
      return;
    }

    // 1. Fetch all Evergreen posts for this brand
    const evergreenContents = await prisma.content.findMany({
      where: {
        brandId: targetBrandId,
        isEvergreen: true
      },
      orderBy: { updatedAt: 'asc' }
    });

    if (evergreenContents.length === 0) {
      res.status(400).json({
        error: 'No Evergreen posts found in your library. Mark posts as "Evergreen ♻️" in the post inspector or create one first!'
      });
      return;
    }

    // 2. Fetch active social accounts for this brand
    const socialAccounts = await prisma.socialAccount.findMany({
      where: {
        brandId: targetBrandId,
        status: 'CONNECTED'
      }
    });

    const fallbackAccount = socialAccounts[0] || (await prisma.socialAccount.findFirst({
      where: { brand: { business: { tenantId: req.user?.tenantId! } } }
    }));

    if (!fallbackAccount) {
      res.status(400).json({ error: 'No connected social accounts found to schedule posts.' });
      return;
    }

    // 3. Find empty days (gaps) in the next N days
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(daysAhead));

    const existingPubs = await prisma.publication.findMany({
      where: {
        content: { brandId: targetBrandId },
        scheduledFor: { gte: startDate, lte: endDate },
        status: { in: ['QUEUED', 'PUBLISHING', 'PUBLISHED'] }
      },
      select: { scheduledFor: true }
    });

    const scheduledDateStrings = new Set(
      existingPubs.map(p => p.scheduledFor.toISOString().split('T')[0])
    );

    const gapDates: Date[] = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      if (!scheduledDateStrings.has(dateStr)) {
        // Set standard optimal drop time: 18:30 (6:30 PM)
        const gapDate = new Date(d);
        gapDate.setHours(18, 30, 0, 0);
        gapDates.push(gapDate);
      }
    }

    if (gapDates.length === 0) {
      res.json({
        success: true,
        filledCount: 0,
        message: 'No empty calendar gaps found in the next 14 days! Your editorial schedule is fully packed.'
      });
      return;
    }

    // 4. Fill gaps round-robin using evergreen contents
    const createdPubs = [];
    for (let i = 0; i < gapDates.length; i++) {
      const gapDate = gapDates[i];
      const content = evergreenContents[i % evergreenContents.length];

      const pub = await prisma.publication.create({
        data: {
          contentId: content.id,
          socialAccountId: fallbackAccount.id,
          scheduledFor: gapDate,
          status: 'QUEUED'
        }
      });
      createdPubs.push(pub);

      // Update content recycled timestamp
      await prisma.content.update({
        where: { id: content.id },
        data: { lastRecycledAt: new Date() }
      });
    }

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'EVERGREEN_GAPS_AUTO_FILLED',
      entityType: 'Publication',
      details: {
        brandId: targetBrandId,
        filledCount: createdPubs.length,
        daysAhead
      }
    });

    res.json({
      success: true,
      filledCount: createdPubs.length,
      message: `Successfully auto-filled ${createdPubs.length} empty calendar gaps with Evergreen content!`
    });
  } catch (err: any) {
    console.error('Auto-fill evergreen gaps error:', err);
    res.status(500).json({ error: err.message || 'Failed to auto-fill evergreen gaps' });
  }
});

export default router;

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
        errorMessage: pub.errorMessage
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
    const { title, caption, hashtags } = req.body;

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
        hashtags: hashtags !== undefined ? (typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags)) : pub.content.hashtags
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

export default router;

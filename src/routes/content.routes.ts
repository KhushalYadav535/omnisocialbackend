import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';

const router = Router();

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${cleanName}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for high-def videos and Reels
  fileFilter: (_req, file, cb) => {
    const allowedExts = /\.(jpe?g|png|webp|gif|mp4|mov|webm|m4v|avi)$/i;
    const isAllowed = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') || allowedExts.test(file.originalname);
    if (isAllowed) {
      cb(null, true);
    } else {
      cb(new Error('Only valid image (JPG, PNG, WEBP, GIF) and video (MP4, MOV, WEBM) files are allowed'));
    }
  }
});

router.use(authenticateToken);
router.use(requireTenant);

// 0. Upload Media Asset for Content Creation (Image or Video)
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No media file uploaded' });
      return;
    }

    const host = req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';
    const relativeUrl = `/uploads/${req.file.filename}`;
    const fullUrl = `${protocol}://${host}${relativeUrl}`;
    const isVideo = req.file.mimetype.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi)$/i.test(req.file.filename);

    res.json({
      success: true,
      url: fullUrl,
      relativeUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      isVideo
    });
  } catch (err: any) {
    console.error('File upload error:', err);
    res.status(500).json({ error: err.message || 'File upload failed' });
  }
});

// 1. List Posts (Content Studio)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, status, format } = req.query;

    const whereClause: any = {
      brand: {
        business: {
          tenantId: req.user?.tenantId!
        }
      }
    };

    if (brandId && typeof brandId === 'string') {
      whereClause.brandId = brandId;
    }
    if (status && typeof status === 'string') {
      whereClause.status = status.toUpperCase();
    }
    if (format && typeof format === 'string') {
      whereClause.format = format.toUpperCase();
    }

    const contents = await prisma.content.findMany({
      where: whereClause,
      include: {
        brand: {
          select: { id: true, name: true }
        },
        createdByUser: {
          select: { id: true, name: true }
        },
        publications: {
          include: {
            socialAccount: {
              select: { id: true, accountName: true, platform: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const enriched = contents.map(c => ({
      id: c.id,
      brandId: c.brandId,
      title: c.title,
      rawIdea: c.rawIdea,
      caption: c.caption,
      hashtags: c.hashtags,
      mediaUrls: c.mediaUrls,
      targetPlatforms: c.targetPlatforms,
      format: c.format,
      status: c.status,
      firstComment: c.firstComment,
      viralityScore: c.viralityScore,
      isEvergreen: c.isEvergreen,
      recycleIntervalDays: c.recycleIntervalDays,
      lastRecycledAt: c.lastRecycledAt,
      clientApprovalStatus: c.clientApprovalStatus,
      clientFeedback: c.clientFeedback,
      createdByUserId: c.createdByUserId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      brandName: c.brand?.name,
      authorName: c.createdByUser?.name,
      publications: c.publications.map(p => ({
        id: p.id,
        contentId: p.contentId,
        socialAccountId: p.socialAccountId,
        scheduledFor: p.scheduledFor,
        claimedAt: p.claimedAt,
        publishedAt: p.publishedAt,
        status: p.status,
        platformPostId: p.platformPostId,
        platformPostUrl: p.platformPostUrl,
        errorMessage: p.errorMessage,
        retryCount: p.retryCount,
        idempotencyKey: p.idempotencyKey,
        createdAt: p.createdAt,
        accountName: p.socialAccount?.accountName,
        platform: p.socialAccount?.platform
      }))
    }));

    res.json({ contents: enriched });
  } catch (err: any) {
    console.error('List contents error:', err);
    res.status(500).json({ error: err.message || 'Failed to list contents' });
  }
});

// 2. Create Post Draft or Immediate Schedule
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      brandId,
      title,
      rawIdea,
      caption,
      hashtags = [],
      mediaUrls = [],
      targetPlatforms = ['FACEBOOK', 'INSTAGRAM'],
      format = 'POST',
      status = 'DRAFT',
      scheduledFor,
      socialAccountIds = [],
      firstComment,
      viralityScore,
      isEvergreen = false,
      recycleIntervalDays = 60
    } = req.body;

    if (!brandId || !caption) {
      res.status(400).json({ error: 'brandId and caption are required' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: {
        id: brandId,
        business: { tenantId: req.user?.tenantId! }
      }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your organization' });
      return;
    }

    const hashtagsStr = typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags);
    const mediaUrlsStr = typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls);
    const targetPlatformsStr = typeof targetPlatforms === 'string' ? targetPlatforms : JSON.stringify(targetPlatforms);
    const contentStatus = scheduledFor ? 'SCHEDULED' : status;

    const result = await prisma.$transaction(async (tx) => {
      let content;
      try {
        content = await tx.content.create({
          data: {
            brandId,
            title: title || caption.slice(0, 40) + '...',
            rawIdea: rawIdea || null,
            caption,
            hashtags: hashtagsStr,
            mediaUrls: mediaUrlsStr,
            targetPlatforms: targetPlatformsStr,
            format,
            status: contentStatus,
            firstComment: firstComment ? String(firstComment) : null,
            viralityScore: viralityScore ? Number(viralityScore) : null,
            isEvergreen: Boolean(isEvergreen),
            recycleIntervalDays: Number(recycleIntervalDays) || 60,
            createdByUserId: req.user!.id
          }
        });
      } catch (createErr: any) {
        if (createErr.message && (createErr.message.includes('firstComment') || createErr.message.includes('does not exist'))) {
          // Graceful fallback if production database columns are still syncing
          content = await tx.content.create({
            data: {
              brandId,
              title: title || caption.slice(0, 40) + '...',
              rawIdea: rawIdea || null,
              caption,
              hashtags: hashtagsStr,
              mediaUrls: mediaUrlsStr,
              targetPlatforms: targetPlatformsStr,
              format,
              status: contentStatus,
              createdByUserId: req.user!.id
            }
          });
        } else {
          throw createErr;
        }
      }

      // Initial version record
      await tx.contentVersion.create({
        data: {
          contentId: content.id,
          versionNumber: 1,
          caption: content.caption,
          hashtags: content.hashtags,
          editedByUserId: req.user!.id,
          changeSummary: 'Initial post creation'
        }
      });

      const publications: any[] = [];
      if (scheduledFor && Array.isArray(socialAccountIds) && socialAccountIds.length > 0) {
        for (const accId of socialAccountIds) {
          // Verify account belongs to brand
          const acc = await tx.socialAccount.findFirst({
            where: { id: accId, brandId: brand.id }
          });
          if (acc) {
            const pub = await tx.publication.create({
              data: {
                contentId: content.id,
                socialAccountId: acc.id,
                scheduledFor: new Date(scheduledFor),
                status: 'QUEUED',
                idempotencyKey: `idem_${content.id}_${acc.id}_${Date.now()}`
              }
            });
            publications.push(pub);
          }
        }
      }

      return { content, publications };
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: scheduledFor ? 'POST_SCHEDULED' : 'POST_DRAFT_CREATED',
      entityType: 'Content',
      entityId: result.content.id,
      details: {
        title: result.content.title,
        brandName: brand.name,
        scheduledFor,
        publicationCount: result.publications.length
      }
    });

    res.status(201).json({
      success: true,
      content: result.content,
      publications: result.publications
    });
  } catch (err: any) {
    console.error('Create content error:', err);
    res.status(500).json({ error: err.message || 'Failed to create post' });
  }
});

// 3. Get Single Post Detail with Versions
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const content = await prisma.content.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      },
      include: {
        brand: {
          select: { id: true, name: true }
        },
        versions: {
          orderBy: { versionNumber: 'desc' }
        },
        publications: {
          include: {
            socialAccount: {
              select: { id: true, accountName: true, platform: true }
            }
          }
        }
      }
    });

    if (!content) {
      res.status(404).json({ error: 'Content post not found or not owned by your organization' });
      return;
    }

    res.json({
      content: {
        id: content.id,
        brandId: content.brandId,
        title: content.title,
        rawIdea: content.rawIdea,
        caption: content.caption,
        hashtags: content.hashtags,
        mediaUrls: content.mediaUrls,
        targetPlatforms: content.targetPlatforms,
        format: content.format,
        status: content.status,
        createdByUserId: content.createdByUserId,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
        brandName: content.brand?.name,
        versions: content.versions,
        publications: content.publications
      }
    });
  } catch (err: any) {
    console.error('Get content detail error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve content' });
  }
});

// 5. Toggle Evergreen Status on a Post (Feature 4A)
router.post('/:id/toggle-evergreen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { isEvergreen, recycleIntervalDays = 60 } = req.body;

    const content = await prisma.content.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!content) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const nextEvergreen = isEvergreen !== undefined ? Boolean(isEvergreen) : !content.isEvergreen;

    const updated = await prisma.content.update({
      where: { id },
      data: {
        isEvergreen: nextEvergreen,
        recycleIntervalDays: Number(recycleIntervalDays) || 60,
        lastRecycledAt: nextEvergreen ? (content.lastRecycledAt || new Date()) : null
      }
    });

    res.json({
      success: true,
      contentId: updated.id,
      isEvergreen: updated.isEvergreen,
      recycleIntervalDays: updated.recycleIntervalDays
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to toggle evergreen status' });
  }
});

// 6. Get Evergreen Post Pool
router.get('/evergreen/pool', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId } = req.query;

    const whereClause: any = {
      isEvergreen: true,
      brand: { business: { tenantId: req.user?.tenantId! } }
    };

    if (brandId && typeof brandId === 'string') {
      whereClause.brandId = brandId;
    }

    const pool = await prisma.content.findMany({
      where: whereClause,
      include: {
        brand: { select: { id: true, name: true } },
        publications: { take: 1, orderBy: { createdAt: 'desc' } }
      },
      orderBy: { updatedAt: 'desc' }
    });

    res.json({
      success: true,
      count: pool.length,
      pool
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to retrieve evergreen pool' });
  }
});

// 7. Manually Trigger Immediate Evergreen AI Re-Hook & Schedule
router.post('/:id/recycle-now', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);

    const original = await prisma.content.findFirst({
      where: { id, brand: { business: { tenantId: req.user?.tenantId! } } },
      include: { brand: true }
    });

    if (!original) {
      res.status(404).json({ error: 'Evergreen post not found' });
      return;
    }

    // Schedule forward to tomorrow evening 7:30 PM peak window
    const targetSchedule = new Date();
    targetSchedule.setDate(targetSchedule.getDate() + 1);
    targetSchedule.setHours(19, 30, 0, 0);

    let recycled;
    try {
      recycled = await prisma.content.create({
        data: {
          brandId: original.brandId,
          title: `[Recycled] ${original.title || 'Evergreen Post'}`,
          rawIdea: original.rawIdea,
          caption: original.caption,
          hashtags: original.hashtags,
          mediaUrls: original.mediaUrls,
          targetPlatforms: original.targetPlatforms,
          format: original.format,
          status: 'SCHEDULED',
          firstComment: (original as any).firstComment || null,
          viralityScore: (original as any).viralityScore || null,
          isEvergreen: true,
          recycleIntervalDays: (original as any).recycleIntervalDays || 60,
          lastRecycledAt: new Date(),
          createdByUserId: req.user!.id
        }
      });
    } catch (createErr: any) {
      if (createErr.message && (createErr.message.includes('firstComment') || createErr.message.includes('does not exist'))) {
        recycled = await prisma.content.create({
          data: {
            brandId: original.brandId,
            title: `[Recycled] ${original.title || 'Evergreen Post'}`,
            rawIdea: original.rawIdea,
            caption: original.caption,
            hashtags: original.hashtags,
            mediaUrls: original.mediaUrls,
            targetPlatforms: original.targetPlatforms,
            format: original.format,
            status: 'SCHEDULED',
            createdByUserId: req.user!.id
          }
        });
      } else {
        throw createErr;
      }
    }

    // Mark original recycled timestamp
    await prisma.content.update({
      where: { id: original.id },
      data: { lastRecycledAt: new Date() }
    });

    res.json({
      success: true,
      message: 'Evergreen post re-queued into peak scheduling calendar!',
      recycledPostId: recycled.id,
      scheduledFor: targetSchedule.toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to recycle evergreen post' });
  }
});

export default router;

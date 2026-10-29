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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    const allowedExts = /\.(jpe?g|png|webp|gif)$/i;
    const isImage = file.mimetype.startsWith('image/') || allowedExts.test(file.originalname);
    if (isImage) {
      cb(null, true);
    } else {
      cb(new Error('Only valid image files (JPG, PNG, WEBP, GIF) are allowed'));
    }
  }
});

router.use(authenticateToken);
router.use(requireTenant);

// 0. Upload Media Asset for Content Creation
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file uploaded' });
      return;
    }

    const host = req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';
    const relativeUrl = `/uploads/${req.file.filename}`;
    const fullUrl = `${protocol}://${host}${relativeUrl}`;

    res.json({
      success: true,
      url: fullUrl,
      relativeUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
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
      socialAccountIds = []
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
      const content = await tx.content.create({
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

export default router;

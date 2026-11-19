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
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }
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

    const enriched = contents.map(c => {
      let platformCaptions: Record<string, string> | null = null;
      if (c.clientFeedback) {
        try {
          const parsed = JSON.parse(c.clientFeedback);
          if (parsed && parsed.platformCaptions) {
            platformCaptions = parsed.platformCaptions;
          }
        } catch {}
      }

      return {
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
        platformCaptions,
        createdByUserId: c.createdByUserId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        brandName: c.brand?.name,
        authorName: c.createdByUser?.name,
        scheduledFor: c.publications?.[0]?.scheduledFor || null,
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
      };
    });

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
    const contentStatus = scheduledFor ? 'SCHEDULED' : (status || 'DRAFT');
    const initialApprovalStatus = req.body.clientApprovalStatus || (scheduledFor ? 'PENDING' : (contentStatus === 'DRAFT' ? 'DRAFT' : 'PENDING'));

    const result = await prisma.$transaction(async (tx) => {
      let content;
      const existingDraftId = req.body.activeDraftId || req.body.id;

      // 1. If existing draft ID passed, update in-place to prevent duplicates
      if (existingDraftId) {
        const existing = await tx.content.findFirst({
          where: { id: existingDraftId, brandId }
        });
        if (existing) {
          try {
            content = await tx.content.update({
              where: { id: existingDraftId },
              data: {
                title: title || existing.title,
                rawIdea: rawIdea !== undefined ? rawIdea : existing.rawIdea,
                caption,
                hashtags: hashtagsStr,
                mediaUrls: mediaUrlsStr,
                targetPlatforms: targetPlatformsStr,
                format,
                status: contentStatus,
                clientApprovalStatus: initialApprovalStatus,
                clientFeedback: req.body.platformCaptions ? JSON.stringify({ platformCaptions: req.body.platformCaptions }) : undefined,
                firstComment: firstComment ? String(firstComment) : null,
                viralityScore: viralityScore ? Number(viralityScore) : null,
                isEvergreen: Boolean(isEvergreen),
                recycleIntervalDays: Number(recycleIntervalDays) || 60
              }
            });
          } catch {
            content = await tx.content.update({
              where: { id: existingDraftId },
              data: {
                title: title || existing.title,
                rawIdea: rawIdea !== undefined ? rawIdea : existing.rawIdea,
                caption,
                hashtags: hashtagsStr,
                mediaUrls: mediaUrlsStr,
                targetPlatforms: targetPlatformsStr,
                format,
                status: contentStatus,
                clientApprovalStatus: initialApprovalStatus
              }
            });
          }
        }
      }

      // 2. If saving a pure DRAFT without an ID, check if an identical draft was saved within the last 30 minutes
      if (!content && contentStatus === 'DRAFT') {
        const recentDuplicate = await tx.content.findFirst({
          where: {
            brandId,
            status: 'DRAFT',
            title: title || caption.slice(0, 40) + '...',
            createdByUserId: req.user!.id,
            createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }
          }
        });
        if (recentDuplicate) {
          content = await tx.content.update({
            where: { id: recentDuplicate.id },
            data: {
              rawIdea: rawIdea !== undefined ? rawIdea : recentDuplicate.rawIdea,
              caption,
              hashtags: hashtagsStr,
              mediaUrls: mediaUrlsStr,
              targetPlatforms: targetPlatformsStr,
              format,
              clientFeedback: req.body.platformCaptions ? JSON.stringify({ platformCaptions: req.body.platformCaptions }) : undefined
            }
          });
        }
      }

      if (!content) {
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
              clientApprovalStatus: initialApprovalStatus,
              clientFeedback: req.body.platformCaptions ? JSON.stringify({ platformCaptions: req.body.platformCaptions }) : undefined,
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
              clientApprovalStatus: initialApprovalStatus,
              createdByUserId: req.user!.id
            }
          });
        } else {
          throw createErr;
        }
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
      if (scheduledFor) {
        let targetAccountIds: string[] = Array.isArray(socialAccountIds) && socialAccountIds.length > 0 ? socialAccountIds : [];

        // If no social accounts provided, find existing or auto-provision a default sandbox channel
        if (targetAccountIds.length === 0) {
          const brandAccounts = await tx.socialAccount.findMany({
            where: { brandId: brand.id }
          });
          if (brandAccounts.length > 0) {
            targetAccountIds = brandAccounts.map(a => a.id);
          } else {
            const sandboxAccount = await tx.socialAccount.create({
              data: {
                brandId: brand.id,
                platform: 'INSTAGRAM',
                platformAccountId: `sandbox_${brand.id}_insta`,
                accountName: `${brand.name} (Official)`,
                username: brand.name.toLowerCase().replace(/\s+/g, '_'),
                accessToken: 'demo_sandbox_access_token',
                isConnected: true,
                capabilities: JSON.stringify(['COMMENTS', 'DIRECT_MESSAGES', 'PUBLISHING'])
              }
            });
            targetAccountIds = [sandboxAccount.id];
          }
        }

        for (const accId of targetAccountIds) {
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

// Update Existing Post / Draft
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { title, caption, hashtags, mediaUrls, format, status, clientApprovalStatus, scheduledFor, socialAccountIds, targetPlatforms } = req.body;

    const content = await prisma.content.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!content) {
      res.status(404).json({ error: 'Post not found or access denied' });
      return;
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (caption !== undefined) updateData.caption = caption;
    if (hashtags !== undefined) updateData.hashtags = typeof hashtags === 'string' ? hashtags : JSON.stringify(hashtags);
    if (mediaUrls !== undefined) updateData.mediaUrls = typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls);
    if (format !== undefined) updateData.format = format;
    if (status !== undefined) updateData.status = status;
    if (clientApprovalStatus !== undefined) updateData.clientApprovalStatus = clientApprovalStatus;
    if (targetPlatforms !== undefined) {
      updateData.targetPlatforms = typeof targetPlatforms === 'string' ? targetPlatforms : JSON.stringify(targetPlatforms);
    }
    if (req.body.platformCaptions !== undefined) {
      updateData.clientFeedback = JSON.stringify({ platformCaptions: req.body.platformCaptions });
    }

    if (scheduledFor) {
      updateData.status = 'SCHEDULED';
      if (!clientApprovalStatus) {
        updateData.clientApprovalStatus = 'APPROVED';
      }

      let targetAccountIds: string[] = Array.isArray(socialAccountIds) && socialAccountIds.length > 0 ? socialAccountIds : [];
      if (targetAccountIds.length === 0) {
        const brandAccounts = await prisma.socialAccount.findMany({
          where: { brandId: content.brandId }
        });
        if (brandAccounts.length > 0) {
          targetAccountIds = brandAccounts.map(a => a.id);
        }
      }

      // Remove non-published publications and re-create fresh with new schedule
      await prisma.publication.deleteMany({
        where: {
          contentId: id,
          status: { not: 'PUBLISHED' }
        }
      });

      for (const accId of targetAccountIds) {
        await prisma.publication.create({
          data: {
            contentId: id,
            socialAccountId: accId,
            scheduledFor: new Date(scheduledFor),
            status: 'QUEUED',
            idempotencyKey: `idem_${id}_${accId}_${Date.now()}`
          }
        });
      }
    } else if (scheduledFor === null || (status === 'DRAFT' && clientApprovalStatus === 'DRAFT')) {
      // If cleared or strictly draft, delete any non-published publications
      await prisma.publication.deleteMany({
        where: {
          contentId: id,
          status: { not: 'PUBLISHED' }
        }
      });
    }

    const updated = await prisma.content.update({
      where: { id },
      data: updateData,
      include: { publications: true }
    });

    res.json({ success: true, content: updated });
  } catch (err: any) {
    console.error('Update post error:', err);
    res.status(500).json({ error: err.message || 'Failed to update post' });
  }
});

// Explicitly submit a draft for client approval
router.post('/:id/submit-approval', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const content = await prisma.content.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!content) {
      res.status(404).json({ error: 'Post not found or access denied' });
      return;
    }

    const updated = await prisma.content.update({
      where: { id },
      data: {
        clientApprovalStatus: 'PENDING',
        status: 'SCHEDULED'
      }
    });

    res.json({ success: true, message: 'Post successfully submitted to Client Approvals queue!', content: updated });
  } catch (err: any) {
    console.error('Submit approval error:', err);
    res.status(500).json({ error: err.message || 'Failed to submit post for approval' });
  }
});

// Delete Content Post
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const content = await prisma.content.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!content) {
      res.status(404).json({ error: 'Post not found or access denied' });
      return;
    }

    await prisma.publication.deleteMany({ where: { contentId: id } });
    await prisma.contentVersion.deleteMany({ where: { contentId: id } });
    await prisma.content.delete({ where: { id } });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'CONTENT_POST_DELETED',
      entityType: 'Content',
      entityId: id,
      details: { title: content.title }
    });

    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (err: any) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete post' });
  }
});

export default router;

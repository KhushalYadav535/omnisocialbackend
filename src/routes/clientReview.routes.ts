import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../services/db.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

/**
 * 1. Generate or Get Magic Share Token for Brand Client Review (Protected)
 */
router.post('/generate-token', authenticateToken, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let { brandId, name = 'Client Review Portal' } = req.body;

    let targetBrandId = brandId;
    if (!targetBrandId) {
      const defaultBrand = await prisma.brand.findFirst({
        where: { business: { tenantId: req.user?.tenantId! } }
      });
      if (defaultBrand) targetBrandId = defaultBrand.id;
    }

    if (!targetBrandId) {
      res.status(400).json({ error: 'No brand found for your account. Please create a brand first.' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: { id: targetBrandId, business: { tenantId: req.user?.tenantId! } }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your organization' });
      return;
    }

    // Safety check: ensure ClientShareToken table & columns exist in database
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "ClientShareToken" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "brandId" TEXT NOT NULL,
          "token" TEXT NOT NULL UNIQUE,
          "name" TEXT NOT NULL DEFAULT 'Client Review Link',
          "canApprove" BOOLEAN NOT NULL DEFAULT true,
          "expiresAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );
        ALTER TABLE "ClientShareToken" 
          ADD COLUMN IF NOT EXISTS "name" TEXT DEFAULT 'Client Review Link',
          ADD COLUMN IF NOT EXISTS "canApprove" BOOLEAN DEFAULT true;
      `);
    } catch {
      // Ignored if table and columns already present
    }

    // Check if valid token already exists
    let shareToken = await prisma.clientShareToken.findFirst({
      where: { brandId: brand.id }
    });

    if (!shareToken) {
      const token = `rvw_${crypto.randomBytes(16).toString('hex')}`;
      shareToken = await prisma.clientShareToken.create({
        data: {
          brandId: brand.id,
          token,
          name,
          canApprove: true
        }
      });
    }

    // Determine the frontend origin (Next.js app), never the raw Express backend host
    let frontendOrigin = req.body?.origin || req.get('origin');
    if (!frontendOrigin && req.get('referer')) {
      try {
        const refUrl = new URL(req.get('referer')!);
        frontendOrigin = refUrl.origin;
      } catch {}
    }
    // Hard safeguard: never allow backend host or onrender domain to be used as client review portal URL
    if (!frontendOrigin || frontendOrigin.includes('onrender.com') || frontendOrigin.includes('backend') || frontendOrigin.includes('localhost:5000')) {
      frontendOrigin = process.env.FRONTEND_URL && !process.env.FRONTEND_URL.includes('onrender.com') && !process.env.FRONTEND_URL.includes('backend')
        ? process.env.FRONTEND_URL
        : 'https://omnisocial-l5uq.vercel.app';
    }

    const reviewUrl = `${frontendOrigin.replace(/\/$/, '')}/review/${shareToken.token}`;

    res.json({
      success: true,
      shareToken: shareToken.token,
      reviewUrl,
      brandName: brand.name
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate client review link' });
  }
});

/**
 * 2. Public Client Review Portal View (NO LOGIN REQUIRED)
 */
router.get('/public/:token', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token);

    const shareToken = await prisma.clientShareToken.findUnique({
      where: { token },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            description: true,
            slug: true
          }
        }
      }
    });

    if (!shareToken) {
      res.status(404).json({ error: 'Review link is invalid or has expired' });
      return;
    }

    if (shareToken.expiresAt && new Date() > shareToken.expiresAt) {
      res.status(410).json({ error: 'This client review link has expired' });
      return;
    }

    // Fetch posts awaiting review or recently approved/requested changes (exclude internal drafts)
    const contents = await prisma.content.findMany({
      where: {
        brandId: shareToken.brandId,
        clientApprovalStatus: { in: ['PENDING', 'APPROVED', 'CHANGES_REQUESTED'] }
      },
      include: {
        publications: {
          select: {
            id: true,
            scheduledFor: true,
            status: true,
            platformPostUrl: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    // Deduplicate posts by title to prevent repeated duplicate items in review portal
    const uniqueContents = contents.filter((c, i, arr) =>
      i === arr.findIndex(item => item.title?.trim().toLowerCase() === c.title?.trim().toLowerCase())
    );

    const formattedPosts = uniqueContents.map(c => {
      let rawTags: any[] = [];
      try {
        rawTags = typeof c.hashtags === 'string' ? JSON.parse(c.hashtags || '[]') : (c.hashtags || []);
      } catch {
        rawTags = [];
      }
      // Scrub any leftover #tesdy tags
      const cleanTags = rawTags.map((t: string) => /tesdy/i.test(t) ? '#SentientDigital' : t);

      let mediaUrls: string[] = [];
      try {
        mediaUrls = typeof c.mediaUrls === 'string' ? JSON.parse(c.mediaUrls || '[]') : (c.mediaUrls || []);
      } catch {
        mediaUrls = [];
      }
      // Scrub any leftover yellow sweatpants fallback
      mediaUrls = mediaUrls.filter(u => !u.includes('photo-1515886657613-9f3515b0c78f'));

      return {
        id: c.id,
        title: c.title,
        caption: c.caption?.replace(/tesdy/gi, 'Sentient Digital'),
        hashtags: cleanTags,
        mediaUrls,
        targetPlatforms: typeof c.targetPlatforms === 'string' ? JSON.parse(c.targetPlatforms || '[]') : c.targetPlatforms,
        format: c.format,
        status: c.status,
        clientApprovalStatus: c.clientApprovalStatus || 'PENDING',
        clientFeedback: c.clientFeedback || null,
        scheduledFor: c.publications?.[0]?.scheduledFor || null,
        createdAt: c.createdAt
      };
    });

    res.json({
      success: true,
      brand: (shareToken as any).brand,
      canApprove: shareToken.canApprove,
      posts: formattedPosts
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load client review portal' });
  }
});

/**
 * 3. Public Client Action (1-Click Approve or Request Changes) (NO LOGIN REQUIRED)
 */
router.post('/public/:token/action', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token);
    const { contentId, action, feedback } = req.body;

    if (!contentId || !action) {
      res.status(400).json({ error: 'contentId and action (APPROVE or REQUEST_CHANGES) are required' });
      return;
    }

    const shareToken = await prisma.clientShareToken.findUnique({
      where: { token }
    });

    if (!shareToken) {
      res.status(404).json({ error: 'Invalid review token' });
      return;
    }

    const content = await prisma.content.findFirst({
      where: { id: contentId, brandId: shareToken.brandId }
    });

    if (!content) {
      res.status(404).json({ error: 'Post not found for this client brand' });
      return;
    }

    const newApprovalStatus = action === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';

    const updated = await prisma.content.update({
      where: { id: contentId },
      data: {
        clientApprovalStatus: newApprovalStatus,
        clientFeedback: feedback ? feedback.trim() : (action === 'APPROVE' ? 'Approved by Client via Magic Link' : 'Changes requested'),
        status: action === 'APPROVE' ? 'SCHEDULED' : 'DRAFT'
      }
    });

    if (action === 'APPROVE') {
      const pubs = await prisma.publication.findMany({ where: { contentId } });
      const now = new Date();
      for (const pub of pubs) {
        // Never roll forward or revert already-published publications
        if (pub.status === 'PUBLISHED') continue;

        if (!pub.scheduledFor || pub.scheduledFor < now) {
          const nextDay = new Date();
          nextDay.setDate(nextDay.getDate() + 1);
          nextDay.setHours(10, 0, 0, 0);
          await prisma.publication.update({
            where: { id: pub.id },
            data: { scheduledFor: nextDay, status: 'QUEUED' }
          });
        } else {
          await prisma.publication.update({
            where: { id: pub.id },
            data: { status: 'QUEUED' }
          });
        }
      }
    } else {
      await prisma.publication.deleteMany({
        where: { contentId, status: 'QUEUED' }
      });
    }

    res.json({
      success: true,
      contentId,
      approvalStatus: updated.clientApprovalStatus,
      clientFeedback: updated.clientFeedback
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to submit client review action' });
  }
});

export default router;

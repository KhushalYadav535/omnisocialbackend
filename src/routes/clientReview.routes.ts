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

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const reviewUrl = `${protocol}://${host}/review/${shareToken.token}`;

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

    // Fetch posts awaiting review or recently scheduled
    const contents = await prisma.content.findMany({
      where: {
        brandId: shareToken.brandId
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

    const formattedPosts = contents.map(c => ({
      id: c.id,
      title: c.title,
      caption: c.caption,
      hashtags: typeof c.hashtags === 'string' ? JSON.parse(c.hashtags || '[]') : c.hashtags,
      mediaUrls: typeof c.mediaUrls === 'string' ? JSON.parse(c.mediaUrls || '[]') : c.mediaUrls,
      targetPlatforms: typeof c.targetPlatforms === 'string' ? JSON.parse(c.targetPlatforms || '[]') : c.targetPlatforms,
      format: c.format,
      status: c.status,
      clientApprovalStatus: c.clientApprovalStatus || 'PENDING',
      clientFeedback: c.clientFeedback || null,
      scheduledFor: c.publications?.[0]?.scheduledFor || null,
      createdAt: c.createdAt
    }));

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
        clientFeedback: feedback ? feedback.trim() : (action === 'APPROVE' ? 'Approved by Client via Magic Link' : 'Changes requested')
      }
    });

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

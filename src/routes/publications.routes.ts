import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { MetaService, MetaApiError } from '../services/meta.service';
import { CryptoService } from '../services/crypto.service';
import { AuditService } from '../services/audit.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 1. Instant Publish Now (PUB-01)
router.post('/publish-now', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contentId, socialAccountId } = req.body;

    if (!contentId || !socialAccountId) {
      res.status(400).json({ error: 'contentId and socialAccountId are required' });
      return;
    }

    const [content, account] = await Promise.all([
      prisma.content.findFirst({
        where: {
          id: contentId,
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      }),
      prisma.socialAccount.findFirst({
        where: {
          id: socialAccountId,
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      })
    ]);

    if (!content) {
      res.status(404).json({ error: 'Content post not found or not owned by your organization' });
      return;
    }

    if (!account) {
      res.status(404).json({ error: 'Social account not found or not owned by your organization' });
      return;
    }

    let mediaUrl: string | undefined;
    try {
      const parsed = JSON.parse(content.mediaUrls || '[]');
      mediaUrl = parsed[0];
    } catch {
      mediaUrl = undefined;
    }

    // Decrypt stored access token
    let rawAccessToken: string;
    try {
      rawAccessToken = CryptoService.isEncrypted(account.accessToken)
        ? CryptoService.decrypt(account.accessToken)
        : account.accessToken;
    } catch (decryptErr: any) {
      res.status(500).json({ error: `Account token decryption failed: ${decryptErr.message}` });
      return;
    }

    const now = new Date();
    const idempotencyKey = `idem_instant_${content.id}_${account.id}_${Date.now()}`;

    // Publish to Facebook or Instagram via Meta Graph API
    let result: { success: true; postId: string; postUrl: string };
    try {
      if (account.platform === 'FACEBOOK') {
        result = await MetaService.publishToFacebookPage(
          account.platformAccountId,
          rawAccessToken,
          content.caption,
          mediaUrl
        );
      } else if (account.platform === 'INSTAGRAM') {
        result = await MetaService.publishToInstagram(
          account.platformAccountId,
          rawAccessToken,
          content.caption,
          mediaUrl || 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=1080&h=1080&fit=crop'
        );
      } else {
        throw new Error(`Unsupported publishing platform: ${account.platform}`);
      }
    } catch (publishErr: any) {
      console.error('Meta publishing error:', publishErr);

      // If token expired, update account status
      if (publishErr instanceof MetaApiError && publishErr.isTokenExpired) {
        await prisma.socialAccount.update({
          where: { id: account.id },
          data: { tokenStatus: 'EXPIRED' }
        });
      }

      // Record failed publication in database
      const failedPub = await prisma.publication.create({
        data: {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledFor: now,
          status: 'FAILED',
          errorMessage: publishErr.message || 'Meta API publishing failed',
          idempotencyKey
        }
      });

      res.status(422).json({
        success: false,
        error: publishErr.message || 'Publishing failed on Meta Graph API',
        code: publishErr.code,
        isTokenExpired: publishErr.isTokenExpired,
        publication: failedPub
      });
      return;
    }

    // On confirmed publication success, update database records atomically
    const publication = await prisma.$transaction(async (tx) => {
      const pub = await tx.publication.create({
        data: {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledFor: now,
          publishedAt: now,
          status: 'PUBLISHED',
          platformPostId: result.postId,
          platformPostUrl: result.postUrl,
          idempotencyKey
        }
      });

      await tx.content.update({
        where: { id: content.id },
        data: { status: 'PUBLISHED' }
      });

      return pub;
    });

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'POST_PUBLISHED_INSTANTLY',
      entityType: 'Publication',
      entityId: publication.id,
      details: {
        contentTitle: content.title,
        platform: account.platform,
        accountName: account.accountName,
        postUrl: result.postUrl,
        postId: result.postId
      }
    });

    res.json({
      success: true,
      message: `Successfully published to ${account.platform} (${account.accountName})`,
      publication
    });
  } catch (err: any) {
    console.error('Publish now error:', err);
    res.status(500).json({ error: err.message || 'Publishing failed' });
  }
});

// 2. Retry Failed Publication
router.post('/:id/retry', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const pub = await prisma.publication.findFirst({
      where: {
        id,
        content: {
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      }
    });

    if (!pub) {
      res.status(404).json({ error: 'Publication not found or not owned by your organization' });
      return;
    }

    if (pub.retryCount >= 5) {
      res.status(400).json({ error: 'Publication has exceeded maximum retry attempts (5)' });
      return;
    }

    const updated = await prisma.publication.update({
      where: { id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
        scheduledFor: new Date(),
        retryCount: { increment: 1 },
        errorMessage: null
      }
    });

    res.json({
      success: true,
      message: 'Publication queued for immediate retry',
      publication: updated
    });
  } catch (err: any) {
    console.error('Retry publication error:', err);
    res.status(500).json({ error: err.message || 'Failed to retry publication' });
  }
});

export default router;

import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { MetaService, MetaApiError } from '../services/meta.service';
import { CryptoService } from '../services/crypto.service';
import { AuditService } from '../services/audit.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 1. Instant Publish Now (PUB-01) - Supports single or multi-channel broadcasting
router.post('/publish-now', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { contentId, socialAccountId, socialAccountIds } = req.body;
    const targetAccountIds: string[] = Array.isArray(socialAccountIds) && socialAccountIds.length > 0
      ? socialAccountIds
      : socialAccountId
        ? [socialAccountId]
        : [];

    if (!contentId || targetAccountIds.length === 0) {
      res.status(400).json({ error: 'contentId and at least one socialAccountId are required' });
      return;
    }

    const [content, accounts] = await Promise.all([
      prisma.content.findFirst({
        where: {
          id: contentId,
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      }),
      prisma.socialAccount.findMany({
        where: {
          id: { in: targetAccountIds },
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      })
    ]);

    if (!content) {
      res.status(404).json({ error: 'Content post not found or not owned by your organization' });
      return;
    }

    if (!accounts || accounts.length === 0) {
      res.status(404).json({ error: 'No matching social accounts found for your organization' });
      return;
    }

    let mediaUrl: string | undefined;
    try {
      const parsed = JSON.parse(content.mediaUrls || '[]');
      mediaUrl = parsed[0];
      if (mediaUrl && mediaUrl.startsWith('http://') && !mediaUrl.includes('localhost')) {
        mediaUrl = mediaUrl.replace('http://', 'https://');
      }
    } catch {
      mediaUrl = undefined;
    }

    const publications: any[] = [];
    const errors: string[] = [];

    for (const account of accounts) {
      // Decrypt stored access token
      let rawAccessToken: string;
      try {
        rawAccessToken = CryptoService.isEncrypted(account.accessToken)
          ? CryptoService.decrypt(account.accessToken)
          : account.accessToken;
      } catch (decryptErr: any) {
        errors.push(`Account ${account.platform} token decryption failed: ${decryptErr.message}`);
        continue;
      }

      const now = new Date();
      const idempotencyKey = `idem_instant_${content.id}_${account.id}_${Date.now()}`;

      try {
        let result: { success: true; postId: string; postUrl: string };
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

        const pub = await prisma.publication.create({
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

        await AuditService.record({
          tenantId: req.user?.tenantId,
          userId: req.user?.id,
          action: 'POST_PUBLISHED_INSTANTLY',
          entityType: 'Publication',
          entityId: pub.id,
          details: {
            contentTitle: content.title,
            platform: account.platform,
            accountName: account.accountName,
            postUrl: result.postUrl,
            postId: result.postId
          }
        });

        publications.push({
          ...pub,
          platform: account.platform,
          accountName: account.accountName
        });
      } catch (publishErr: any) {
        console.error(`Meta publishing error for ${account.platform}:`, publishErr);

        if (publishErr instanceof MetaApiError && publishErr.isTokenExpired) {
          await prisma.socialAccount.update({
            where: { id: account.id },
            data: { tokenStatus: 'EXPIRED' }
          });
        }

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

        errors.push(`${account.platform}: ${publishErr.message || 'Publishing failed'}`);
        publications.push({
          ...failedPub,
          platform: account.platform,
          accountName: account.accountName
        });
      }
    }

    const publishedList = publications.filter(p => p.status === 'PUBLISHED');
    if (publishedList.length > 0) {
      await prisma.content.update({
        where: { id: content.id },
        data: { status: 'PUBLISHED' }
      });
    }

    if (publishedList.length === 0 && publications.length > 0) {
      res.status(422).json({
        success: false,
        error: errors.join('; ') || 'Publishing failed on all selected channels',
        publications,
        publication: publications[0]
      });
      return;
    }

    res.json({
      success: true,
      message: `Successfully published to ${publishedList.length} channel(s): ${publishedList.map(p => p.platform).join(', ')}`,
      publications,
      publication: publishedList[0] || publications[0]
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

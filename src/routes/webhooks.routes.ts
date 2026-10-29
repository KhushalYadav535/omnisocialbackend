import { Router, Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../services/db.service';
import { AiService } from '../services/ai.service';
import { CryptoService } from '../services/crypto.service';

const router = Router();

// 1. Meta Webhook Verification Endpoint (Handshake)
router.get('/meta', (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
    console.log('✅ Meta Webhook subscription handshake verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Meta Webhook verification failed: verify_token mismatch or invalid mode');
    res.status(403).json({ error: 'Webhook verification token mismatch' });
  }
});

// 2. Meta Event Ingestion (Comments, DMs, Feed updates)
// Protected by HMAC-SHA256 signature verification over raw body bytes
router.post('/meta', async (req: Request, res: Response): Promise<void> => {
  const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);

  // Signature verification using constant-time comparison
  const isValidSignature = CryptoService.verifyMetaWebhookSignature(
    rawBody,
    signatureHeader,
    config.meta.appSecret
  );

  if (!isValidSignature) {
    console.warn('❌ Meta Webhook rejected: Invalid or missing X-Hub-Signature-256');
    res.status(403).json({ error: 'Invalid webhook signature' });
    return;
  }

  // Acknowledge receipt to Meta immediately within 20s window
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (!body || !body.entry) return;

  try {
    if (body.object === 'page' || body.object === 'instagram') {
      for (const entry of body.entry) {
        const pageOrIgId = entry.id;

        // Check entry changes
        if (entry.changes && Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            // Facebook page comment or Instagram comment
            const isFbComment = change.field === 'feed' && change.value?.item === 'comment';
            const isIgComment = change.field === 'comments' || (change.field === 'feed' && change.value?.item === 'comment');

            if (isFbComment || isIgComment) {
              const value = change.value;
              const commentId = value.comment_id || value.id;
              if (!commentId) continue;

              // Find associated SocialAccount by platform account ID, resolving brand and business tenant
              const account = await prisma.socialAccount.findFirst({
                where: { platformAccountId: pageOrIgId },
                include: {
                  brand: {
                    include: {
                      business: true
                    }
                  }
                }
              });

              if (!account) {
                console.log(`[WEBHOOK] No registered social account found for platform ID ${pageOrIgId}`);
                continue;
              }

              // Resolve tenant strictly through the SocialAccount -> Brand -> Business relationship
              const resolvedTenantId = account.brand?.business?.tenantId || null;

              console.log(`[WEBHOOK DEBUG] Found account: id=${account.id}, brandId=${account.brandId}, platform=${account.platform}, platformAccountId=${account.platformAccountId}`);

              // Event Deduplication: check if interaction already exists
              const existing = await prisma.interaction.findUnique({
                where: { platformInteractionId: commentId }
              });

              if (existing) {
                console.log(`[WEBHOOK] Duplicate event ignored for interaction ID ${commentId}`);
                continue;
              }

              const contentText = value.message || value.text || '';
              const authorId = value.from?.id || 'unknown_author';
              const authorName = value.from?.name || value.from?.username || 'Social User';
              const authorUsername = value.from?.username || authorName.toLowerCase().replace(/\s+/g, '_');

              const createdTime = value.created_time
                ? new Date(typeof value.created_time === 'number' ? value.created_time * 1000 : value.created_time)
                : new Date();

              const isQuestion = contentText.includes('?');
              const priority = isQuestion ? 'HIGH' : 'MEDIUM';

              // 1. Immediately persist Interaction and baseline Classification in PostgreSQL
              const interaction = await prisma.$transaction(async (tx) => {
                const inter = await tx.interaction.create({
                  data: {
                    brand: { connect: { id: account.brandId } },
                    socialAccount: { connect: { id: account.id } },
                    platform: account.platform,
                    type: 'COMMENT',
                    platformInteractionId: commentId,
                    parentPlatformId: value.post_id || value.media?.id || null,
                    authorId,
                    authorName,
                    authorUsername,
                    authorAvatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
                    contentText,
                    mediaUrls: '[]',
                    permalinkUrl: null,
                    platformCreatedAt: createdTime,
                    isRead: false,
                    replyStatus: 'NEEDS_RESPONSE',
                    priority
                  }
                });

                await tx.classification.create({
                  data: {
                    interaction: { connect: { id: inter.id } },
                    sentiment: 'NEUTRAL',
                    sentimentScore: 0.5,
                    isQuestion,
                    isPricingInquiry: false,
                    isLeadIntent: false,
                    isSensitiveOrComplaint: false,
                    urgencyScore: isQuestion ? 4 : 2,
                    rawAnalysis: 'Instant baseline webhook ingestion classification',
                    isOverridden: false
                  }
                });

                return inter;
              });

              console.log(`📥 [WEBHOOK] Instantly persisted comment on ${account.accountName}: "${contentText}"`);

              // 2. Asynchronously enrich classification with OpenRouter AI with resolved tenant attribution
              AiService.classifyInteraction(contentText, resolvedTenantId, account.brandId)
                .then(async (aiRes) => {
                  const latest = await prisma.interaction.findUnique({
                    where: { id: interaction.id }
                  });
                  if (!latest) return;

                  await prisma.classification.updateMany({
                    where: { interactionId: interaction.id },
                    data: {
                      sentiment: aiRes.sentiment,
                      sentimentScore: aiRes.sentimentScore,
                      isQuestion: aiRes.isQuestion,
                      isPricingInquiry: aiRes.isPricingInquiry,
                      isLeadIntent: aiRes.isLeadIntent,
                      isSensitiveOrComplaint: aiRes.isSensitiveOrComplaint,
                      urgencyScore: aiRes.urgencyScore,
                      rawAnalysis: aiRes.reasoning
                    }
                  });

                  // Only adjust priority if still untouched by a human agent
                  if (latest.replyStatus === 'NEEDS_RESPONSE' && !latest.isRead && aiRes.urgencyScore >= 4) {
                    await prisma.interaction.update({
                      where: { id: interaction.id },
                      data: { priority: 'HIGH' }
                    });
                  }
                })
                .catch((aiErr) => {
                  console.log(`[WEBHOOK AI Enrichment note]: ${aiErr.message}`);
                });
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.error('Webhook processing error:', err);
  }
});

export default router;

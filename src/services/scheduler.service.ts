import { prisma } from './db.service';
import { MetaService, MetaApiError } from './meta.service';
import { CryptoService } from './crypto.service';
import { AuditService } from './audit.service';

export class SchedulerService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isProcessing = false;

  static startWorker() {
    if (this.intervalId) return;

    console.log('⏰ Starting Social Media Publishing & Sync background worker...');

    // Run crash recovery immediately upon worker boot
    this.recoverStalePublishingJobs().catch((err) => {
      console.error('Error recovering stale publishing jobs on worker boot:', err);
    });

    // Check every 20 seconds for scheduled publications in database
    this.intervalId = setInterval(async () => {
      try {
        await this.runWorkerCycle();
      } catch (err) {
        console.error('Error in publication worker cycle:', err);
      }
    }, 20000);

    // Continuous background synchronization of Facebook comments & interactions (every 45 seconds)
    setInterval(async () => {
      try {
        await this.runCommentSyncCycle();
      } catch (err) {
        console.error('Error in background comment sync cycle:', err);
      }
    }, 45000);
  }

  static stopWorker() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Recovers stale jobs left in PUBLISHING state by a worker crash or server restart.
   * Stale threshold defaults to 5 minutes.
   * Ensures publishedAt is never set or modified on recovered/failed jobs.
   */
  static async recoverStalePublishingJobs(staleThresholdMs: number = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);

    const stalePubs = await prisma.publication.findMany({
      where: {
        status: 'PUBLISHING',
        OR: [
          { claimedAt: { lte: cutoff } },
          { claimedAt: null, updatedAt: { lte: cutoff } }
        ]
      }
    });

    let recovered = 0;
    for (const pub of stalePubs) {
      if (pub.retryCount < 3) {
        // Safe to reset to QUEUED with incremental backoff; claimedAt reset to null; publishedAt remains null
        await prisma.publication.update({
          where: { id: pub.id },
          data: {
            status: 'QUEUED',
            claimedAt: null,
            scheduledFor: new Date(Date.now() + 60000), // Backoff 1 minute
            retryCount: { increment: 1 },
            errorMessage: 'Recovered from interrupted PUBLISHING state (worker crash or restart recovery)'
          }
        });
      } else {
        // Exceeded retries, mark as FAILED; publishedAt remains null
        await prisma.publication.update({
          where: { id: pub.id },
          data: {
            status: 'FAILED',
            errorMessage: 'Publication stalled in PUBLISHING state and exceeded max retry attempts (3)'
          }
        });
      }
      recovered++;
    }

    if (recovered > 0) {
      console.log(`🛡️ [SCHEDULER] Recovered ${recovered} stale publication(s) stuck in PUBLISHING state`);
    }

    return recovered;
  }

  /**
   * Executes a single publishing worker cycle.
   * Can be called periodically or triggered explicitly by test runners.
   */
  static async runWorkerCycle(): Promise<{ processed: number; successCount: number; failCount: number; recovered: number }> {
    if (this.isProcessing) {
      return { processed: 0, successCount: 0, failCount: 0, recovered: 0 };
    }

    this.isProcessing = true;
    let successCount = 0;
    let failCount = 0;
    let recoveredCount = 0;
    const now = new Date();

    try {
      // 1. Recover any stale publishing jobs from previous worker interruptions
      recoveredCount = await this.recoverStalePublishingJobs();

      // 2. Query scheduled publications from PostgreSQL that are due
      const pendingPubs = await prisma.publication.findMany({
        where: {
          status: 'QUEUED',
          scheduledFor: { lte: now },
          retryCount: { lt: 3 } // Retry limit of 3
        },
        include: {
          content: true,
          socialAccount: true
        }
      });

      for (const pub of pendingPubs) {
        const claimTime = new Date();

        // Atomic status transition to PUBLISHING to prevent duplicate processing across instances.
        // Sets claimedAt to track processing start; publishedAt is STRICTLY NOT SET here.
        const updated = await prisma.publication.updateMany({
          where: {
            id: pub.id,
            status: 'QUEUED'
          },
          data: {
            status: 'PUBLISHING',
            claimedAt: claimTime
          }
        });

        if (updated.count === 0) {
          // Another worker cycle or process already acquired this publication
          continue;
        }

        const content = pub.content;
        const account = pub.socialAccount;

        if (!content || !account) {
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'FAILED',
              errorMessage: 'Content or Social Account not found in database'
            }
          });
          failCount++;
          continue;
        }

        let mediaUrl: string | undefined;
        try {
          const parsed = JSON.parse(content.mediaUrls || '[]');
          mediaUrl = parsed[0];
        } catch {
          mediaUrl = undefined;
        }

        // Decrypt stored access token using AES-256-GCM
        let rawAccessToken: string;
        try {
          rawAccessToken = CryptoService.isEncrypted(account.accessToken)
            ? CryptoService.decrypt(account.accessToken)
            : account.accessToken;
        } catch (decryptErr: any) {
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'FAILED',
              errorMessage: `Token decryption failure: ${decryptErr.message}`
            }
          });
          failCount++;
          continue;
        }

        try {
          let res: { success: true; postId: string; postUrl: string };

          if (account.platform === 'FACEBOOK') {
            res = await MetaService.publishToFacebookPage(
              account.platformAccountId,
              rawAccessToken,
              content.caption,
              mediaUrl
            );
          } else if (account.platform === 'INSTAGRAM') {
            res = await MetaService.publishToInstagram(
              account.platformAccountId,
              rawAccessToken,
              content.caption,
              mediaUrl || 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=1080&h=1080&fit=crop'
            );
          } else {
            throw new Error(`Unsupported publishing platform: ${account.platform}`);
          }

          if (!res || !res.postId) {
            throw new Error('Meta API returned empty or invalid platform post ID');
          }

          // Set publishedAt ONLY after Meta API returns a confirmed external platform post ID
          const confirmedPublishedAt = new Date();

          await prisma.$transaction([
            prisma.publication.update({
              where: { id: pub.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: confirmedPublishedAt,
                platformPostId: res.postId,
                platformPostUrl: res.postUrl,
                errorMessage: null
              }
            }),
            prisma.content.update({
              where: { id: content.id },
              data: { status: 'PUBLISHED' }
            })
          ]);

          await AuditService.record({
            tenantId: null,
            action: 'POST_PUBLISHED_AUTOMATICALLY',
            entityType: 'Publication',
            entityId: pub.id,
            details: {
              contentTitle: content.title,
              platform: account.platform,
              accountName: account.accountName,
              postId: res.postId,
              publishedAt: confirmedPublishedAt.toISOString()
            }
          });

          console.log(`🚀 [SCHEDULER] Successfully published "${content.title}" to ${account.platform} (${account.accountName})`);
          successCount++;
        } catch (err: any) {
          const isTimeout = err.code === 'ECONNABORTED' || (err.message && err.message.toLowerCase().includes('timeout'));

          // If token expired (code 190), update account status
          if (err instanceof MetaApiError && err.isTokenExpired) {
            await prisma.socialAccount.update({
              where: { id: account.id },
              data: { tokenStatus: 'EXPIRED' }
            });
          }

          let errorMessage = err.message || 'Meta API publishing failed';
          if (isTimeout) {
            errorMessage = 'Meta API request timed out. Please check Facebook Page or Instagram feed before retrying to prevent duplicate posts.';
          }

          // If timeout, do NOT automatically retry immediately (ambiguous timeout duplicate protection)
          // For other retryable errors, apply exponential backoff
          const nextScheduled = isTimeout
            ? new Date()
            : new Date(Date.now() + Math.pow(2, pub.retryCount + 1) * 30000);

          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'FAILED',
              errorMessage,
              scheduledFor: nextScheduled,
              retryCount: isTimeout ? pub.retryCount : { increment: 1 }
            }
          });

          console.error(`❌ [SCHEDULER] Failed to publish "${content.title}":`, errorMessage);
          failCount++;
        }
      }

      return {
        processed: pendingPubs.length,
        successCount,
        failCount,
        recovered: recoveredCount
      };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Autonomous background synchronization of Facebook & Instagram comments
   */
  static async runCommentSyncCycle(): Promise<number> {
    try {
      const accounts = await prisma.socialAccount.findMany({
        where: { tokenStatus: 'VALID' },
        include: { brand: { include: { business: true } } }
      });

      let totalImported = 0;

      for (const acc of accounts) {
        if (!acc.accessToken) continue;

        let rawToken: string;
        try {
          rawToken = CryptoService.isEncrypted(acc.accessToken)
            ? CryptoService.decrypt(acc.accessToken)
            : acc.accessToken;
        } catch {
          continue;
        }

        let comments: any[] = [];
        let messages: any[] = [];
        if (acc.platform === 'FACEBOOK') {
          comments = await MetaService.syncFacebookPageComments(acc.platformAccountId, rawToken);
          messages = await MetaService.syncFacebookPageMessages(acc.platformAccountId, rawToken);
        } else if (acc.platform === 'INSTAGRAM') {
          comments = await MetaService.syncInstagramComments(acc.platformAccountId, rawToken);
        }

        for (const item of comments) {
          const existing = await prisma.interaction.findUnique({
            where: { platformInteractionId: item.id }
          });

          if (!existing) {
            const isQuestion = item.message.includes('?');
            const priority = isQuestion ? 'HIGH' : 'MEDIUM';

            const created = await prisma.interaction.create({
              data: {
                brandId: acc.brandId,
                socialAccountId: acc.id,
                platform: acc.platform,
                type: 'COMMENT',
                platformInteractionId: item.id,
                parentPlatformId: item.postId || null,
                authorId: item.authorId || 'fb_user',
                authorName: item.authorName || 'Facebook User',
                authorUsername: item.authorUsername || 'fb_user',
                authorAvatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(item.authorName || 'User')}&background=6366f1&color=fff&bold=true&size=128`,
                contentText: item.message,
                mediaUrls: '[]',
                permalinkUrl: item.permalinkUrl || null,
                platformCreatedAt: item.createdTime,
                isRead: false,
                replyStatus: 'NEEDS_RESPONSE',
                priority
              }
            });

            await prisma.classification.create({
              data: {
                interactionId: created.id,
                sentiment: 'NEUTRAL',
                sentimentScore: 0.5,
                isQuestion,
                isPricingInquiry: false,
                isLeadIntent: false,
                isSensitiveOrComplaint: false,
                urgencyScore: isQuestion ? 4 : 2,
                rawAnalysis: 'Background synchronization ingestion',
                isOverridden: false
              }
            });

            totalImported++;
          }
        }

        for (const msg of messages) {
          const existing = await prisma.interaction.findUnique({
            where: { platformInteractionId: msg.id }
          });

          if (!existing) {
            const isQuestion = msg.message.includes('?');
            const priority = isQuestion ? 'HIGH' : 'MEDIUM';

            const created = await prisma.interaction.create({
              data: {
                brandId: acc.brandId,
                socialAccountId: acc.id,
                platform: acc.platform,
                type: 'DIRECT_MESSAGE',
                platformInteractionId: msg.id,
                parentPlatformId: msg.conversationId || null,
                authorId: msg.authorId || 'fb_user',
                authorName: msg.authorName || 'Facebook User',
                authorUsername: msg.authorUsername || 'fb_user',
                authorAvatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.authorName || 'User')}&background=6366f1&color=fff&bold=true&size=128`,
                contentText: msg.message,
                mediaUrls: '[]',
                permalinkUrl: null,
                platformCreatedAt: msg.createdTime,
                isRead: false,
                replyStatus: 'NEEDS_RESPONSE',
                priority
              }
            });

            await prisma.classification.create({
              data: {
                interactionId: created.id,
                sentiment: 'NEUTRAL',
                sentimentScore: 0.5,
                isQuestion,
                isPricingInquiry: false,
                isLeadIntent: true,
                isSensitiveOrComplaint: false,
                urgencyScore: isQuestion ? 4 : 2,
                rawAnalysis: 'Background Messenger synchronization ingestion',
                isOverridden: false
              }
            });

            totalImported++;
          }
        }
      }

      if (totalImported > 0) {
        console.log(`📥 [SCHEDULER SYNC] Auto-synced ${totalImported} new social interaction(s) from connected accounts.`);
      }

      return totalImported;
    } catch (err: any) {
      console.warn('Background comment sync warning:', err.message);
      return 0;
    }
  }
}

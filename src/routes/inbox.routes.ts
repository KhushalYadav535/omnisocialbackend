import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { MetaService } from '../services/meta.service';
import { CryptoService } from '../services/crypto.service';
import { AiService } from '../services/ai.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 0. Active Meta API Comments Synchronization
router.post('/sync', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user?.tenantId!;
    const { brandId } = req.body;

    const whereAccount: any = {
      brand: { business: { tenantId } },
      tokenStatus: 'VALID'
    };
    if (brandId) whereAccount.brandId = brandId;

    const accounts = await prisma.socialAccount.findMany({
      where: whereAccount,
      include: { brand: true }
    });

    let totalFound = 0;
    let newItems = 0;

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

      let fetchedComments: Array<{
        id: string;
        postId: string;
        message: string;
        createdTime: Date;
        authorId: string;
        authorName: string;
        authorUsername: string;
        permalinkUrl?: string;
      }> = [];

      let fetchedMessages: Array<{
        id: string;
        conversationId: string;
        message: string;
        createdTime: Date;
        authorId: string;
        authorName: string;
        authorUsername: string;
      }> = [];

      if (acc.platform === 'FACEBOOK') {
        fetchedComments = await MetaService.syncFacebookPageComments(acc.platformAccountId, rawToken);
        fetchedMessages = await MetaService.syncFacebookPageMessages(acc.platformAccountId, rawToken);
      } else if (acc.platform === 'INSTAGRAM') {
        fetchedComments = await MetaService.syncInstagramComments(acc.platformAccountId, rawToken);
      }

      totalFound += fetchedComments.length + fetchedMessages.length;

      for (const item of fetchedComments) {
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
              rawAnalysis: 'Active Meta API synchronization ingestion',
              isOverridden: false
            }
          });

          // Run background AI classification
          AiService.classifyInteraction(item.message, tenantId, acc.brandId)
            .then(async (aiRes) => {
              await prisma.classification.updateMany({
                where: { interactionId: created.id },
                data: {
                  sentiment: aiRes.sentiment || 'NEUTRAL',
                  sentimentScore: aiRes.sentimentScore || 0.5,
                  isQuestion: aiRes.isQuestion || isQuestion,
                  isPricingInquiry: aiRes.isPricingInquiry || false,
                  isLeadIntent: aiRes.isLeadIntent || false,
                  isSensitiveOrComplaint: aiRes.isSensitiveOrComplaint || false,
                  urgencyScore: aiRes.urgencyScore || 2,
                  rawAnalysis: aiRes.reasoning || 'AI classified'
                }
              });
            })
            .catch(() => {});

          newItems++;
        }
      }

      // Ingest Direct Messages (DMs)
      for (const msg of fetchedMessages) {
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
              rawAnalysis: 'Active Meta Messenger synchronization ingestion',
              isOverridden: false
            }
          });

          AiService.classifyInteraction(msg.message, tenantId, acc.brandId)
            .then(async (aiRes) => {
              await prisma.classification.updateMany({
                where: { interactionId: created.id },
                data: {
                  sentiment: aiRes.sentiment || 'NEUTRAL',
                  sentimentScore: aiRes.sentimentScore || 0.5,
                  isQuestion: aiRes.isQuestion || isQuestion,
                  isPricingInquiry: aiRes.isPricingInquiry || false,
                  isLeadIntent: aiRes.isLeadIntent ?? true,
                  isSensitiveOrComplaint: aiRes.isSensitiveOrComplaint || false,
                  urgencyScore: aiRes.urgencyScore || 2,
                  rawAnalysis: aiRes.reasoning || 'AI classified DM'
                }
              });
            })
            .catch(() => {});

          newItems++;
        }
      }
    }

    res.json({
      success: true,
      totalFound,
      newItems,
      message: `Sync completed: ${newItems} new interaction(s) (comments & messages) imported from connected channels.`
    });
  } catch (err: any) {
    console.error('Inbox sync error:', err);
    res.status(500).json({ error: err.message || 'Failed to sync interactions from Meta' });
  }
});

// 1. List Interactions for Unified Inbox
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, platform, type, status, priority, sentiment, search } = req.query;

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
    if (platform && typeof platform === 'string') {
      whereClause.platform = platform.toUpperCase();
    }
    if (type && typeof type === 'string') {
      whereClause.type = type.toUpperCase();
    }
    if (status && typeof status === 'string') {
      whereClause.replyStatus = status.toUpperCase();
    }
    if (priority && typeof priority === 'string') {
      whereClause.priority = priority.toUpperCase();
    }
    if (search && typeof search === 'string') {
      const q = search.trim();
      whereClause.OR = [
        { contentText: { contains: q, mode: 'insensitive' } },
        { authorName: { contains: q, mode: 'insensitive' } },
        { authorUsername: { contains: q, mode: 'insensitive' } }
      ];
    }
    if (sentiment && typeof sentiment === 'string') {
      whereClause.classifications = {
        some: {
          sentiment: sentiment.toUpperCase()
        }
      };
    }

    // SQL Pagination parameters (default page=1, limit=50, max limit=100)
    const rawPage = parseInt(req.query.page as string, 10);
    const rawLimit = parseInt(req.query.limit as string, 10);
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const skip = (page - 1) * limit;

    // Execute paginated query and total count at database level
    const [total, interactions, unreadCount, needsResponseCount, commentsCount, dmsCount] = await Promise.all([
      prisma.interaction.count({ where: whereClause }),
      prisma.interaction.findMany({
        where: whereClause,
        skip,
        take: limit,
        include: {
          brand: {
            select: { id: true, name: true }
          },
          socialAccount: {
            select: { id: true, accountName: true, platform: true, username: true }
          },
          classifications: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          },
          replies: {
            orderBy: { createdAt: 'desc' }
          },
          assignedUser: {
            select: { id: true, name: true, avatarUrl: true }
          }
        },
        orderBy: { platformCreatedAt: 'desc' }
      }),
      prisma.interaction.count({
        where: {
          brand: { business: { tenantId: req.user?.tenantId! } },
          isRead: false
        }
      }),
      prisma.interaction.count({
        where: {
          brand: { business: { tenantId: req.user?.tenantId! } },
          replyStatus: { in: ['NEEDS_RESPONSE', 'DRAFT_READY'] }
        }
      }),
      prisma.interaction.count({
        where: {
          brand: { business: { tenantId: req.user?.tenantId! } },
          type: 'COMMENT'
        }
      }),
      prisma.interaction.count({
        where: {
          brand: { business: { tenantId: req.user?.tenantId! } },
          type: 'DIRECT_MESSAGE'
        }
      })
    ]);

    const enriched = interactions.map(item => ({
      id: item.id,
      brandId: item.brandId,
      socialAccountId: item.socialAccountId,
      platform: item.platform,
      type: item.type,
      platformInteractionId: item.platformInteractionId,
      parentPlatformId: item.parentPlatformId,
      authorId: item.authorId,
      authorName: item.authorName,
      authorUsername: item.authorUsername,
      authorAvatarUrl: item.authorAvatarUrl,
      contentText: item.contentText,
      mediaUrls: item.mediaUrls,
      permalinkUrl: item.permalinkUrl,
      platformCreatedAt: item.platformCreatedAt,
      isRead: item.isRead,
      replyStatus: item.replyStatus,
      priority: item.priority,
      assignedUserId: item.assignedUserId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      brandName: item.brand?.name,
      accountName: item.socialAccount?.accountName,
      classification: item.classifications[0] || null,
      replies: item.replies,
      assignedUser: item.assignedUser
    }));

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      items: enriched,
      interactions: enriched,
      total,
      page,
      limit,
      totalPages,
      unreadCount,
      needsResponseCount,
      commentsCount,
      dmsCount
    });
  } catch (err: any) {
    console.error('List inbox interactions error:', err);
    res.status(500).json({ error: err.message || 'Failed to list interactions' });
  }
});

// 2. Get Single Interaction Detail
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const interaction = await prisma.interaction.findFirst({
      where: {
        id,
        brand: {
          business: {
            tenantId: req.user?.tenantId!
          }
        }
      },
      include: {
        brand: {
          include: {
            voiceProfile: true
          }
        },
        socialAccount: {
          select: { id: true, accountName: true, platform: true, username: true }
        },
        classifications: {
          take: 1,
          orderBy: { createdAt: 'desc' }
        },
        replies: {
          orderBy: { createdAt: 'desc' }
        },
        assignedUser: {
          select: { id: true, name: true, avatarUrl: true }
        }
      }
    });

    if (!interaction) {
      res.status(404).json({ error: 'Interaction not found or does not belong to your organization' });
      return;
    }

    // Automatically mark read when viewed
    if (!interaction.isRead) {
      await prisma.interaction.update({
        where: { id },
        data: { isRead: true }
      }).catch(err => console.error('Failed to update isRead on view:', err));
    }

    res.json({
      interaction: {
        id: interaction.id,
        brandId: interaction.brandId,
        socialAccountId: interaction.socialAccountId,
        platform: interaction.platform,
        type: interaction.type,
        platformInteractionId: interaction.platformInteractionId,
        parentPlatformId: interaction.parentPlatformId,
        authorId: interaction.authorId,
        authorName: interaction.authorName,
        authorUsername: interaction.authorUsername,
        authorAvatarUrl: interaction.authorAvatarUrl,
        contentText: interaction.contentText,
        mediaUrls: interaction.mediaUrls,
        permalinkUrl: interaction.permalinkUrl,
        platformCreatedAt: interaction.platformCreatedAt,
        isRead: true,
        replyStatus: interaction.replyStatus,
        priority: interaction.priority,
        assignedUserId: interaction.assignedUserId,
        createdAt: interaction.createdAt,
        updatedAt: interaction.updatedAt,
        brandName: interaction.brand?.name,
        accountName: interaction.socialAccount?.accountName,
        brandVoice: interaction.brand?.voiceProfile || null,
        classification: interaction.classifications[0] || null,
        replies: interaction.replies,
        assignedUser: interaction.assignedUser
      }
    });
  } catch (err: any) {
    console.error('Get interaction detail error:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve interaction' });
  }
});

// 3. Mark Read / Unread
router.patch('/:id/read', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { isRead = true } = req.body;

    const interaction = await prisma.interaction.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!interaction) {
      res.status(404).json({ error: 'Interaction not found' });
      return;
    }

    const updated = await prisma.interaction.update({
      where: { id },
      data: { isRead: Boolean(isRead) }
    });

    res.json({ success: true, isRead: updated.isRead });
  } catch (err: any) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: err.message || 'Failed to update read status' });
  }
});

// 4. Assign Team Member to Interaction
router.patch('/:id/assign', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { userId } = req.body;

    const interaction = await prisma.interaction.findFirst({
      where: {
        id,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!interaction) {
      res.status(404).json({ error: 'Interaction not found' });
      return;
    }

    let assignedUser = null;
    if (userId) {
      assignedUser = await prisma.user.findFirst({
        where: { id: userId, tenantId: req.user?.tenantId! },
        select: { id: true, name: true, avatarUrl: true }
      });
      if (!assignedUser) {
        res.status(400).json({ error: 'Assigned user does not belong to your organization' });
        return;
      }
    }

    const updated = await prisma.interaction.update({
      where: { id },
      data: { assignedUserId: userId || null }
    });

    res.json({
      success: true,
      assignedUserId: updated.assignedUserId,
      assignedUser
    });
  } catch (err: any) {
    console.error('Assign user error:', err);
    res.status(500).json({ error: err.message || 'Failed to assign user' });
  }
});

export default router;

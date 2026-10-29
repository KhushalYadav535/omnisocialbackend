import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { AuditService } from '../services/audit.service';
import { MetaService, MetaApiError } from '../services/meta.service';
import { CryptoService } from '../services/crypto.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

// 1. Save or Update Draft Reply
router.post('/draft', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { interactionId, replyText, aiSuggestion, aiPrompt } = req.body;

    if (!interactionId || !replyText) {
      res.status(400).json({ error: 'interactionId and replyText are required' });
      return;
    }

    const interaction = await prisma.interaction.findFirst({
      where: {
        id: interactionId,
        brand: { business: { tenantId: req.user?.tenantId! } }
      }
    });

    if (!interaction) {
      res.status(404).json({ error: 'Interaction not found or does not belong to your organization' });
      return;
    }

    const existingDraft = await prisma.reply.findFirst({
      where: {
        interactionId,
        status: 'DRAFT'
      }
    });

    let reply;
    if (existingDraft) {
      reply = await prisma.reply.update({
        where: { id: existingDraft.id },
        data: {
          finalContent: replyText,
          ...(aiSuggestion ? { aiSuggestion } : {})
        }
      });
    } else {
      reply = await prisma.reply.create({
        data: {
          interactionId,
          generatedByAi: Boolean(aiSuggestion),
          aiPrompt: aiPrompt || null,
          aiSuggestion: aiSuggestion || null,
          finalContent: replyText,
          status: 'DRAFT'
        }
      });
    }

    // Update parent interaction status
    await prisma.interaction.update({
      where: { id: interactionId },
      data: { replyStatus: 'DRAFT_READY' }
    });

    res.json({ success: true, reply });
  } catch (err: any) {
    console.error('Save reply draft error:', err);
    res.status(500).json({ error: err.message || 'Failed to save reply draft' });
  }
});

// 2. Explicit Human Approval & Send Workflow (SAFE-01 & AI-06)
router.post('/:id/approve-and-send', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { editedText } = req.body;

    const reply = await prisma.reply.findFirst({
      where: {
        id,
        interaction: {
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      },
      include: {
        interaction: {
          include: {
            socialAccount: true
          }
        }
      }
    });

    if (!reply) {
      res.status(404).json({ error: 'Reply not found or not owned by your organization' });
      return;
    }

    const finalContent = editedText || reply.finalContent;
    const socialAccount = reply.interaction.socialAccount;

    let platformReplyId = `reply_${Date.now()}`;

    // Publish reply to Meta Graph API if social account credentials exist
    if (socialAccount && socialAccount.accessToken) {
      try {
        const rawToken = CryptoService.isEncrypted(socialAccount.accessToken)
          ? CryptoService.decrypt(socialAccount.accessToken)
          : socialAccount.accessToken;

        if (reply.interaction.type === 'DIRECT_MESSAGE') {
          const fbRes = await MetaService.sendFacebookMessage(
            socialAccount.platformAccountId,
            rawToken,
            reply.interaction.authorId || '',
            finalContent
          );
          platformReplyId = fbRes.messageId;
        } else if (reply.interaction.platform === 'FACEBOOK') {
          const fbRes = await MetaService.replyToFacebookComment(
            reply.interaction.platformInteractionId,
            rawToken,
            finalContent
          );
          platformReplyId = fbRes.replyId;
        } else if (reply.interaction.platform === 'INSTAGRAM') {
          const igRes = await MetaService.replyToInstagramComment(
            reply.interaction.platformInteractionId,
            rawToken,
            finalContent
          );
          platformReplyId = igRes.replyId;
        }
      } catch (metaErr: any) {
        console.error('Meta comment reply dispatch error:', metaErr);
        if (metaErr instanceof MetaApiError && metaErr.isTokenExpired) {
          await prisma.socialAccount.update({
            where: { id: socialAccount.id },
            data: { tokenStatus: 'EXPIRED' }
          });
        }
        res.status(422).json({
          error: `Failed to post reply to Meta Graph API: ${metaErr.message}`,
          code: metaErr.code
        });
        return;
      }
    }

    // Execute atomic update across reply and interaction
    const result = await prisma.$transaction(async (tx) => {
      const updatedReply = await tx.reply.update({
        where: { id: reply.id },
        data: {
          finalContent,
          status: 'SENT',
          approvedByUserId: req.user?.id || null,
          sentAt: new Date(),
          platformReplyId
        }
      });

      await tx.interaction.update({
        where: { id: reply.interactionId },
        data: {
          replyStatus: 'SENT',
          isRead: true
        }
      });

      return updatedReply;
    });

    // Record immutable audit trail
    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'AI_REPLY_APPROVED_AND_SENT',
      entityType: 'Reply',
      entityId: reply.id,
      details: {
        interactionId: reply.interaction.id,
        recipient: reply.interaction.authorName,
        platform: reply.interaction.platform,
        finalText: finalContent,
        wasAiGenerated: reply.generatedByAi,
        approverName: req.user?.name
      }
    });

    res.json({
      success: true,
      message: 'Reply approved and sent successfully',
      reply: result
    });
  } catch (err: any) {
    console.error('Approve and send reply error:', err);
    res.status(500).json({ error: err.message || 'Failed to approve and send reply' });
  }
});

// 3. Reject AI Suggestion
router.post('/:id/reject', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;

    const reply = await prisma.reply.findFirst({
      where: {
        id,
        interaction: {
          brand: { business: { tenantId: req.user?.tenantId! } }
        }
      }
    });

    if (!reply) {
      res.status(404).json({ error: 'Reply not found or not owned by your organization' });
      return;
    }

    await prisma.$transaction([
      prisma.reply.update({
        where: { id: reply.id },
        data: { status: 'REJECTED' }
      }),
      prisma.interaction.update({
        where: { id: reply.interactionId },
        data: { replyStatus: 'NEEDS_RESPONSE' }
      })
    ]);

    await AuditService.record({
      tenantId: req.user?.tenantId,
      userId: req.user?.id,
      action: 'AI_REPLY_REJECTED',
      entityType: 'Reply',
      entityId: reply.id
    });

    res.json({ success: true, message: 'Suggestion rejected' });
  } catch (err: any) {
    console.error('Reject reply error:', err);
    res.status(500).json({ error: err.message || 'Failed to reject suggestion' });
  }
});

export default router;

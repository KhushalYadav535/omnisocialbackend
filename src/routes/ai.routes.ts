import { Router, Response } from 'express';
import { prisma } from '../services/db.service';
import { AiService } from '../services/ai.service';
import {
  OpenRouterConfigurationError,
  OpenRouterAuthError,
  OpenRouterRateLimitError
} from '../services/openrouter.service';
import { authenticateToken, requireTenant, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(requireTenant);

/**
 * Common error handler for OpenRouter AI operations
 */
function handleAiError(err: any, res: Response, defaultMessage: string) {
  console.error(`[AI Route Error] ${defaultMessage}:`, err.message);

  if (err instanceof OpenRouterConfigurationError) {
    res.status(503).json({
      error: 'AI_CONFIGURATION_ERROR',
      message: err.message,
      configured: false
    });
    return;
  }

  if (err instanceof OpenRouterAuthError) {
    res.status(502).json({
      error: 'AI_AUTH_ERROR',
      message: err.message
    });
    return;
  }

  if (err instanceof OpenRouterRateLimitError) {
    res.status(429).json({
      error: 'AI_RATE_LIMIT_ERROR',
      message: err.message
    });
    return;
  }

  res.status(500).json({
    error: 'AI_OPERATION_FAILED',
    message: err.message || defaultMessage
  });
}

// 1. Generate Contextual Reply Suggestions for an Interaction
router.post('/suggest-replies', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { interactionId } = req.body;

    if (!interactionId) {
      res.status(400).json({ error: 'interactionId is required' });
      return;
    }

    const interaction = await prisma.interaction.findFirst({
      where: {
        id: interactionId,
        brand: { business: { tenantId: req.user?.tenantId! } }
      },
      include: {
        brand: {
          include: {
            voiceProfile: true
          }
        }
      }
    });

    if (!interaction) {
      res.status(404).json({ error: 'Interaction not found or not owned by your organization' });
      return;
    }

    const voice = interaction.brand?.voiceProfile || null;

    // Call centralized AI service with brand and tenant context
    const suggestions = await AiService.generateReplySuggestions(
      voice,
      interaction.contentText,
      interaction.authorName,
      interaction.platform,
      interaction.brandId,
      req.user?.tenantId,
      req.user?.id
    );

    res.json({
      success: true,
      interactionId,
      gateway: 'OpenRouter',
      brandVoiceUsed: {
        brandName: interaction.brand?.name,
        tone: voice?.tone,
        writingStyle: voice?.writingStyle
      },
      suggestions
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to generate contextual reply suggestions');
  }
});

// 2. Classify Interaction (Sentiment, Intent, Urgency)
router.post('/classify', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { text, brandId } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const classification = await AiService.classifyInteraction(
      text,
      req.user?.tenantId,
      brandId || null,
      req.user?.id
    );

    res.json({
      success: true,
      gateway: 'OpenRouter',
      classification
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to classify interaction text');
  }
});

// 3. AI Content Studio Post Generator
router.post('/generate-post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, rawIdea, targetPlatforms = ['FACEBOOK', 'INSTAGRAM'], format = 'POST' } = req.body;

    if (!brandId || !rawIdea) {
      res.status(400).json({ error: 'brandId and rawIdea are required' });
      return;
    }

    const brand = await prisma.brand.findFirst({
      where: {
        id: brandId,
        business: { tenantId: req.user?.tenantId! }
      },
      include: { voiceProfile: true }
    });

    if (!brand) {
      res.status(404).json({ error: 'Brand not found or not owned by your organization' });
      return;
    }

    const generated = await AiService.generateContent(
      brand.voiceProfile,
      rawIdea,
      targetPlatforms,
      format,
      brand.id,
      req.user?.tenantId,
      req.user?.id
    );

    res.json({
      success: true,
      brandId,
      brandName: brand.name,
      format,
      gateway: 'OpenRouter',
      generated
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to generate social media content');
  }
});

// 4. Centralized AI Usage & Metrics
router.get('/usage', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSuperAdmin = req.user?.role === 'SUPER_ADMIN';
    const tenantScope = isSuperAdmin ? (req.query.tenantId as string) || null : req.user?.tenantId;

    const summary = await AiService.getPlatformUsage(tenantScope);
    res.json({ success: true, usage: summary });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve AI usage metrics', details: err.message });
  }
});

export default router;

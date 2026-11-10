import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { prisma } from '../services/db.service';
import { AiService } from '../services/ai.service';
import {
  OpenRouterService,
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
  const responseData = err.response?.data;
  const rawMsg = responseData?.error?.message || responseData?.message || err.message || defaultMessage;
  console.error(`[AI Route Error] ${defaultMessage}:`, rawMsg);

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

  // 402 Payment Required / Credits Insufficient or In-Flight Request Lock
  if (err.response?.status === 402 || responseData?.error?.code === 402 || rawMsg.includes('credits') || rawMsg.includes('402')) {
    let friendly = rawMsg;
    if (rawMsg.includes('in-flight') || rawMsg.includes('in_flight_budget')) {
      friendly = 'OpenRouter In-Flight Cooldown: Your previous generation job is settling. Please wait 1-2 minutes before submitting another video, or add credits at https://openrouter.ai/settings/credits.';
    } else if (rawMsg.includes('exceeds your available credits') || rawMsg.includes('Insufficient credits')) {
      friendly = 'OpenRouter Credit Limit: This model/duration exceeds your available credits balance (~$0.94 remaining). Please select a 4-second duration or add credits at https://openrouter.ai/settings/credits.';
    }
    res.status(402).json({
      error: 'INSUFFICIENT_CREDITS',
      message: friendly,
      details: rawMsg
    });
    return;
  }

  res.status(err.response?.status || 500).json({
    error: 'AI_OPERATION_FAILED',
    message: rawMsg
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

// 5. Curated AI Media Models for Content Studio
router.get('/media-models', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      success: true,
      videoModels: OpenRouterService.getCuratedVideoModels(),
      imageModels: OpenRouterService.getCuratedImageModels()
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch media models', details: err.message });
  }
});

// 6. Submit AI Video / Reel Generation Job
router.post('/generate-video', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { prompt, model, aspectRatio, duration, resolution, generateAudio } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required for video generation' });
      return;
    }

    const job = await OpenRouterService.submitVideoGeneration({
      prompt,
      model,
      aspectRatio,
      duration: duration ? Number(duration) : undefined,
      resolution,
      generateAudio: generateAudio !== false
    });

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      pollingUrl: job.pollingUrl
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to submit video generation job');
  }
});

// 7. Poll Video Status and Persist Finished MP4 to Local Uploads
router.get('/video-status/:jobId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawJobId = req.params.jobId;
    const jobId = typeof rawJobId === 'string' ? rawJobId : Array.isArray(rawJobId) ? rawJobId[0] : '';
    if (!jobId) {
      res.status(400).json({ error: 'jobId is required' });
      return;
    }

    const poll = await OpenRouterService.pollVideoStatus(jobId);

    if (poll.status === 'completed') {
      const cleanId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `reel_ai_${cleanId}.mp4`;
      const uploadsDir = path.join(process.cwd(), 'uploads');
      const filePath = path.join(uploadsDir, filename);

      const host = req.get('host') || 'localhost:5000';
      const protocol = req.protocol || 'http';
      const localUrl = `${protocol}://${host}/uploads/${filename}`;

      // Check if file already downloaded
      if (!fs.existsSync(filePath) && poll.unsignedUrls && poll.unsignedUrls.length > 0) {
        try {
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }
          const videoBuffer = await OpenRouterService.downloadVideoBuffer(poll.unsignedUrls[0]);
          fs.writeFileSync(filePath, videoBuffer);
        } catch (downloadErr: any) {
          console.warn('[OpenRouter] Could not save video buffer locally, using direct content URL:', downloadErr.message);
        }
      }

      res.json({
        success: true,
        status: 'completed',
        videoUrl: fs.existsSync(filePath) ? localUrl : poll.unsignedUrls?.[0] || localUrl,
        rawUrl: poll.unsignedUrls?.[0]
      });
      return;
    }

    res.json({
      success: true,
      status: poll.status,
      error: poll.error
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to poll video generation status');
  }
});

// 8. Generate Photorealistic Image with OpenRouter (FLUX 3)
router.post('/generate-image', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { prompt, model, aspectRatio } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required for image generation' });
      return;
    }

    const result = await OpenRouterService.generateImage({
      prompt,
      model,
      aspectRatio
    });

    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const host = req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';

    let imageUrl: string;

    if (result.b64_json) {
      const filename = `image_ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
      const filePath = path.join(uploadsDir, filename);
      const buffer = Buffer.from(result.b64_json, 'base64');
      fs.writeFileSync(filePath, buffer);
      imageUrl = `${protocol}://${host}/uploads/${filename}`;
    } else if (result.url) {
      imageUrl = result.url;
    } else {
      throw new Error('Image generation did not return image data');
    }

    res.json({
      success: true,
      imageUrl
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to generate photorealistic image');
  }
});

export default router;

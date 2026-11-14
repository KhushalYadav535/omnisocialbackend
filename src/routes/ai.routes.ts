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
import { CarouselService } from '../services/carousel.service';
import { TimingService } from '../services/timing.service';
import { RepurposeService } from '../services/repurpose.service';
import { ViralityService } from '../services/virality.service';
import { CampaignArchitectService } from '../services/campaignArchitect.service';

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
      let protocol = req.protocol || 'http';
      if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
        protocol = 'https';
      }
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
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }

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

// 9. Generate AI LinkedIn Carousel / Slide-Deck & Render PDF
router.post('/generate-carousel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { topic, theme = 'midnight', slideCount = 5, brandId } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      res.status(400).json({ error: 'topic is required to generate a carousel' });
      return;
    }

    // Determine brand name for slide branding
    let brandName = 'OmniSocial';
    if (brandId) {
      const brand = await prisma.brand.findFirst({
        where: { id: brandId, business: { tenantId: req.user?.tenantId! } }
      });
      if (brand?.name) {
        brandName = brand.name;
      }
    }

    const validThemes = ['midnight', 'royal', 'minimal', 'sunset'] as const;
    const selectedTheme = validThemes.includes(theme) ? theme : 'midnight';
    const count = Math.min(Math.max(Number(slideCount) || 5, 3), 10);

    // 1. Generate Structured Slide Deck JSON via OpenRouter LLM
    const carouselContent = await CarouselService.generateCarouselContent(
      topic.trim(),
      selectedTheme,
      count,
      brandName
    );

    // 2. Render High-Resolution Square PDF Document (LinkedIn Carousel format)
    const host = req.get('host') || 'localhost:5000';
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }
    const pdfResult = await CarouselService.renderCarouselPdf(
      carouselContent,
      brandName,
      host,
      protocol
    );

    const fullCarousel = {
      ...carouselContent,
      pdfUrl: pdfResult.pdfUrl,
      pdfPath: pdfResult.pdfPath,
      filename: pdfResult.filename,
      brandName
    };

    res.json({
      success: true,
      carousel: fullCarousel
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to generate LinkedIn carousel');
  }
});

// 10. AI "Best Time to Post" Optimal Timing Slots
router.get('/optimal-timing', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const platform = (req.query.platform as string) || 'ALL';
    const tzOffset = req.query.tzOffset ? Number(req.query.tzOffset) : -330;

    const slots = TimingService.getOptimalSlots(platform, tzOffset);

    res.json({
      success: true,
      platform,
      slots
    });
  } catch (err: any) {
    res.status(500).json({
      error: 'OPTIMAL_TIMING_FAILED',
      message: err.message || 'Failed to calculate optimal post timing slots'
    });
  }
});

// 11. Feature 1A: 1-Click "URL / Blog to Multi-Platform Campaign" Auto-Repurposer
router.post('/repurpose-url', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { url, rawText, brandId } = req.body;

    if (!url && !rawText) {
      res.status(400).json({ error: 'url or rawText is required to repurpose content' });
      return;
    }

    let brandName = 'OmniSocial';
    if (brandId) {
      const brand = await prisma.brand.findFirst({
        where: { id: brandId, business: { tenantId: req.user?.tenantId! } }
      });
      if (brand?.name) brandName = brand.name;
    }

    const campaign = await RepurposeService.repurposeContent(url, rawText, brandName);

    res.json({
      success: true,
      campaign
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to repurpose article content');
  }
});

// 12. Feature 1C: AI Virality Score Meter & Hook Suggestions
router.post('/virality-score', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { caption, platform = 'LINKEDIN', hashtags = [], hasMedia = true, mediaType = 'IMAGE' } = req.body;

    const analysis = await ViralityService.evaluatePost(
      caption,
      platform,
      Array.isArray(hashtags) ? hashtags : [],
      hasMedia,
      mediaType
    );

    res.json({
      success: true,
      analysis
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to analyze virality score');
  }
});

// 12B. Feature 1C: 1-Click AI Fix & Boost (Elevates post to 90+ Score)
router.post('/boost-post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { caption, platform = 'INSTAGRAM' } = req.body;
    if (!caption || !caption.trim()) {
      res.status(400).json({ error: 'Caption is required to boost' });
      return;
    }
    const result = await ViralityService.boostPost(caption, platform);
    res.json({
      success: true,
      ...result
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to boost post with AI');
  }
});

// 13. "Start From Zero" Campaign Architect: Generate Full Marketing Roadmap
router.post('/campaign-roadmap', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      productDescription,
      businessType = 'PHYSICAL_PRODUCT',
      campaignGoal = 'SALES',
      durationDays = 7,
      startDate,
      platforms = ['INSTAGRAM', 'LINKEDIN'],
      brandId,
      targetAudience,
      tone = 'URGENT_DIRECT',
      language = 'ENGLISH'
    } = req.body;

    if (!productDescription) {
      res.status(400).json({ error: 'productDescription is required to architect a campaign' });
      return;
    }

    let brandName = 'OmniSocial';
    if (brandId) {
      const brand = await prisma.brand.findFirst({
        where: { id: brandId, business: { tenantId: req.user?.tenantId! } }
      });
      if (brand?.name) brandName = brand.name;
    }

    const roadmap = await CampaignArchitectService.generateRoadmap({
      productDescription,
      businessType,
      campaignGoal,
      durationDays: Number(durationDays) as 7 | 14 | 30,
      startDate,
      platforms,
      brandName,
      targetAudience,
      tone,
      language
    });

    res.json({
      success: true,
      roadmap
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to generate campaign roadmap');
  }
});

// 13.1 Campaign Architect: Regenerate Single Post Dynamically
router.post('/campaign-roadmap/regenerate-post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { post, instruction, tone, language, brandName, productDescription } = req.body;
    if (!post) {
      res.status(400).json({ error: 'post object is required' });
      return;
    }

    const updatedPost = await CampaignArchitectService.regenerateSinglePost({
      post,
      instruction,
      tone,
      language,
      brandName,
      productDescription
    });

    res.json({
      success: true,
      post: updatedPost
    });
  } catch (err: any) {
    handleAiError(err, res, 'Failed to dynamically regenerate post');
  }
});

// 14. "Start From Zero" Campaign Architect: 1-Click Deploy to Calendar
router.post('/deploy-campaign', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { brandId, campaignName, posts } = req.body;

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      res.status(400).json({ error: 'posts array is required to deploy campaign' });
      return;
    }

    // Resolve brandId: if not provided or doesn't exist, find first active brand
    let targetBrandId = brandId;
    if (!targetBrandId) {
      const firstBrand = await prisma.brand.findFirst({
        where: { business: { tenantId: req.user?.tenantId! } }
      });
      targetBrandId = firstBrand?.id;
    }

    if (!targetBrandId) {
      // Auto-create a default brand for this tenant if none exists
      const business = await prisma.business.findFirst({
        where: { tenantId: req.user?.tenantId! }
      });
      if (!business) {
        res.status(400).json({ error: 'No business found for tenant' });
        return;
      }
      const newBrand = await prisma.brand.create({
        data: {
          businessId: business.id,
          name: 'My Brand',
          slug: `brand-${Date.now()}`
        }
      });
      targetBrandId = newBrand.id;
    }

    const result = await CampaignArchitectService.deployCampaignToCalendar({
      tenantId: req.user?.tenantId!,
      userId: req.user?.id!,
      brandId: targetBrandId,
      campaignName: campaignName || 'Start From Zero Campaign',
      posts
    });

    res.json({
      success: true,
      result
    });
  } catch (err: any) {
    console.error('[Deploy Campaign Error]:', err);
    res.status(500).json({
      error: 'DEPLOY_CAMPAIGN_FAILED',
      message: err.message || 'Failed to deploy campaign into calendar'
    });
  }
});

// 15. "Start From Zero" Campaign: 1-Click Generate AI Product Photo or Reel Visual
router.post('/generate-campaign-media', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      prompt,
      mediaType = 'IMAGE',
      productDescription,
      businessType,
      phase,
      dayNumber
    } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required to generate media' });
      return;
    }

    const host = req.get('host') || 'localhost:5000';
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }

    const media = await CampaignArchitectService.generateCampaignMedia({
      prompt,
      mediaType,
      productDescription,
      businessType,
      phase,
      dayNumber: Number(dayNumber) || 1,
      host,
      protocol
    });

    res.json({
      success: true,
      media
    });
  } catch (err: any) {
    console.error('[Generate Campaign Media Error]:', err);
    res.status(500).json({
      error: 'GENERATE_CAMPAIGN_MEDIA_FAILED',
      message: err.message || 'Failed to generate campaign media'
    });
  }
});

// 16. Instant 1-Click Single Post or Reel Generator (Start From Zero for Interns)
router.post('/instant-post', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      brandId,
      productOrTopic,
      postType = 'REEL',
      preset = 'PROBLEM_SOLUTION',
      targetPlatform = 'INSTAGRAM',
      scheduledDate
    } = req.body;

    if (!productOrTopic) {
      res.status(400).json({ error: 'productOrTopic is required to generate instant post' });
      return;
    }

    let brandName = 'OmniSocial';
    if (brandId) {
      const brand = await prisma.brand.findFirst({
        where: { id: brandId, business: { tenantId: req.user?.tenantId! } }
      });
      if (brand?.name) brandName = brand.name;
    }

    const host = req.get('host') || 'localhost:5000';
    let protocol = req.protocol || 'http';
    if (host.includes('onrender.com') || req.headers['x-forwarded-proto'] === 'https') {
      protocol = 'https';
    }

    const post = await CampaignArchitectService.generateInstantPost({
      brandName,
      productOrTopic,
      postType,
      preset,
      targetPlatform,
      scheduledDate,
      host,
      protocol
    });

    res.json({
      success: true,
      post
    });
  } catch (err: any) {
    console.error('[Instant Post Error]:', err);
    res.status(500).json({
      error: 'INSTANT_POST_FAILED',
      message: err.message || 'Failed to generate instant post'
    });
  }
});

export default router;

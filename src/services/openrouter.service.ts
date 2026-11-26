import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { prisma } from './db.service';
import { OpenRouterChatMessage, OpenRouterResponse, OpenRouterUsage, TokenUsageRecord } from './aiSchemas';

export class OpenRouterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterConfigurationError';
  }
}

export class OpenRouterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterAuthError';
  }
}

export class OpenRouterRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterRateLimitError';
  }
}

export class OpenRouterProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterProviderError';
  }
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormatJson?: boolean;
  tenantId?: string | null;
  brandId?: string | null;
  userId?: string | null;
  taskType?: 'REPLY_GENERATION' | 'CONTENT_STUDIO' | 'CLASSIFICATION';
}

export class OpenRouterService {
  private static usageHistory: TokenUsageRecord[] = [];
  private static totalTokensTracked = 0;
  private static totalRequestsTracked = 0;

  /**
   * Check if centralized OpenRouter API key is configured
   */
  static isConfigured(): boolean {
    const key = config.openrouter.apiKey;
    return !!key && key.trim().length > 0 && !key.includes('placeholder');
  }

  /**
   * Central chat completion method connecting to OpenRouter API
   */
  static async createChatCompletion(
    messages: OpenRouterChatMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<{ content: string; model: string; usage: OpenRouterUsage }> {
    const apiKey = config.openrouter.apiKey;

    if (!this.isConfigured()) {
      throw new OpenRouterConfigurationError(
        'Centralized OpenRouter API key is not configured on the platform. The Platform Super Admin must set OPENROUTER_API_KEY in the backend deployment environment.'
      );
    }

    const primaryModel = options.model || config.openrouter.defaultModel;
    const fallbackModel = config.openrouter.fallbackModel;
    const timeoutMs = config.openrouter.timeoutMs || 30000;

    try {
      return await this.executeWithRetry(primaryModel, messages, options, timeoutMs, 2);
    } catch (primaryError: any) {
      // If primary model failed with provider error and fallback model is configured and different, try fallback
      if (
        fallbackModel &&
        fallbackModel !== primaryModel &&
        !(primaryError instanceof OpenRouterAuthError) &&
        !(primaryError instanceof OpenRouterConfigurationError)
      ) {
        console.warn(`[OpenRouter] Primary model "${primaryModel}" failed. Attempting fallback to "${fallbackModel}"...`);
        try {
          return await this.executeWithRetry(fallbackModel, messages, options, timeoutMs, 1);
        } catch (fallbackError: any) {
          console.error(`[OpenRouter] Fallback model "${fallbackModel}" also failed:`, fallbackError.message);
          throw fallbackError;
        }
      }

      throw primaryError;
    }
  }

  /**
   * Internal executor with bounded retries and exponential backoff
   */
  private static async executeWithRetry(
    model: string,
    messages: OpenRouterChatMessage[],
    options: ChatCompletionOptions,
    timeoutMs: number,
    maxRetries: number
  ): Promise<{ content: string; model: string; usage: OpenRouterUsage }> {
    const url = `${config.openrouter.baseUrl}/chat/completions`;
    let attempt = 0;

    const payload: any = {
      model,
      messages,
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
      max_tokens: options.maxTokens || 1500
    };

    if (options.responseFormatJson) {
      payload.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'HTTP-Referer': config.frontendUrl || 'http://localhost:3000',
      'X-Title': 'AI Social Media Management Platform',
      'Content-Type': 'application/json'
    };

    while (attempt <= maxRetries) {
      try {
        const response = await axios.post<OpenRouterResponse>(url, payload, {
          headers,
          timeout: timeoutMs
        });

        const choice = response.data?.choices?.[0];
        if (!choice?.message?.content) {
          throw new OpenRouterProviderError('OpenRouter returned an empty completion content choice.');
        }

        const usage: OpenRouterUsage = response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        };

        // Track usage metadata centrally
        this.trackUsage({
          tenantId: options.tenantId,
          brandId: options.brandId,
          userId: options.userId,
          taskType: options.taskType || 'REPLY_GENERATION',
          modelUsed: model,
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          estimatedCostUsd: this.calculateEstimatedCost(model, usage),
          timestamp: new Date().toISOString()
        });

        return {
          content: choice.message.content.trim(),
          model: response.data.model || model,
          usage
        };
      } catch (err: any) {
        attempt++;

        if (axios.isAxiosError(err)) {
          const axiosErr = err as AxiosError<any>;
          const status = axiosErr.response?.status;
          const errorData = axiosErr.response?.data;
          const errorMessage =
            (typeof errorData === 'object' && errorData?.error?.message) ||
            axiosErr.message ||
            'Unknown API error';

          // 401: Invalid credentials - do NOT retry
          if (status === 401) {
            throw new OpenRouterAuthError(
              `OpenRouter API authentication failed (HTTP 401): ${errorMessage}. Please verify OPENROUTER_API_KEY.`
            );
          }

          // 429: Rate limited - retry with delay if attempts remaining
          if (status === 429) {
            if (attempt <= maxRetries) {
              const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
              console.warn(`[OpenRouter] Rate limited (429). Retrying in ${Math.round(backoff)}ms (attempt ${attempt}/${maxRetries})...`);
              await new Promise((res) => setTimeout(res, backoff));
              continue;
            }
            throw new OpenRouterRateLimitError(
              'OpenRouter rate limit reached. Please wait a moment before sending more AI requests.'
            );
          }

          // 5xx: Provider or server failure - retry if attempts remaining
          if (status && status >= 500 && attempt <= maxRetries) {
            const backoff = Math.pow(2, attempt) * 1000;
            console.warn(`[OpenRouter] Server error (${status}). Retrying in ${backoff}ms...`);
            await new Promise((res) => setTimeout(res, backoff));
            continue;
          }

          // Network or timeout errors
          if ((axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT') && attempt <= maxRetries) {
            console.warn(`[OpenRouter] Request timed out after ${timeoutMs}ms. Retrying attempt ${attempt}...`);
            continue;
          }

          throw new OpenRouterProviderError(`OpenRouter request failed (${status || 'Network Error'}): ${errorMessage}`);
        }

        if (attempt > maxRetries) {
          throw err;
        }
      }
    }

    throw new OpenRouterProviderError('Exceeded maximum retry attempts connecting to OpenRouter.');
  }

  /**
   * Usage tracking accumulator with persistent PostgreSQL logging
   */
  static async trackUsage(record: TokenUsageRecord): Promise<void> {
    // 1. In-memory buffer for fast synchronous reads
    this.usageHistory.push(record);
    this.totalTokensTracked += record.totalTokens;
    this.totalRequestsTracked += 1;

    // Keep history bounded in memory (last 500 requests)
    if (this.usageHistory.length > 500) {
      this.usageHistory.shift();
    }

    // 2. Persistent PostgreSQL ledger (handles missing fields and logging errors safely)
    try {
      await prisma.aiUsageLog.create({
        data: {
          tenantId: record.tenantId || null,
          brandId: record.brandId || null,
          userId: record.userId || null,
          taskType: record.taskType,
          modelUsed: record.modelUsed,
          promptTokens: typeof record.promptTokens === 'number' && !isNaN(record.promptTokens) ? record.promptTokens : 0,
          completionTokens: typeof record.completionTokens === 'number' && !isNaN(record.completionTokens) ? record.completionTokens : 0,
          totalTokens: typeof record.totalTokens === 'number' && !isNaN(record.totalTokens) ? record.totalTokens : 0,
          estimatedCostUsd: typeof record.estimatedCostUsd === 'number' && !isNaN(record.estimatedCostUsd) ? record.estimatedCostUsd : 0
        }
      });
    } catch (dbErr: any) {
      console.warn('[OpenRouter] Non-blocking notice: failed to write persistent AiUsageLog:', dbErr?.message || dbErr);
    }
  }

  /**
   * Estimate cost in USD based on standard model pricing
   */
  private static calculateEstimatedCost(model: string, usage: OpenRouterUsage): number {
    // Standard blended estimate ~$0.50 per 1M tokens for gpt-4o-mini / gemini-flash
    const costPerToken = 0.0000005;
    return Number(((usage?.total_tokens ?? 0) * costPerToken).toFixed(6));
  }

  /**
   * Platform-level usage statistics for Super Admin and Tenant Observability (in-memory)
   */
  static getPlatformUsageSummary(tenantId?: string | null) {
    const filtered = tenantId
      ? this.usageHistory.filter((r) => r.tenantId === tenantId)
      : this.usageHistory;

    const totalTokens = filtered.reduce((acc, r) => acc + r.totalTokens, 0);
    const totalCostUsd = filtered.reduce((acc, r) => acc + r.estimatedCostUsd, 0);

    const taskBreakdown = {
      replyGeneration: filtered.filter((r) => r.taskType === 'REPLY_GENERATION').length,
      contentStudio: filtered.filter((r) => r.taskType === 'CONTENT_STUDIO').length,
      classification: filtered.filter((r) => r.taskType === 'CLASSIFICATION').length
    };

    return {
      isConfigured: this.isConfigured(),
      gateway: 'OpenRouter',
      defaultModel: config.openrouter.defaultModel,
      replyModel: config.openrouter.replyModel,
      contentModel: config.openrouter.contentModel,
      classificationModel: config.openrouter.classificationModel,
      fallbackModel: config.openrouter.fallbackModel,
      totalRequests: filtered.length,
      totalTokens,
      estimatedCostUsd: Number(totalCostUsd.toFixed(4)),
      taskBreakdown,
      recentRequests: filtered.slice(-10).reverse()
    };
  }

  /**
   * Persistent PostgreSQL usage statistics aggregating across server restarts
   */
  static async getPersistentUsageSummary(tenantId?: string | null) {
    try {
      const whereClause = tenantId ? { tenantId } : {};

      const [logs, aggregations, replyCount, contentCount, classCount] = await Promise.all([
        prisma.aiUsageLog.findMany({
          where: whereClause,
          take: 10,
          orderBy: { createdAt: 'desc' }
        }),
        prisma.aiUsageLog.aggregate({
          where: whereClause,
          _sum: {
            totalTokens: true,
            estimatedCostUsd: true
          },
          _count: {
            _all: true
          }
        }),
        prisma.aiUsageLog.count({ where: { ...whereClause, taskType: 'REPLY_GENERATION' } }),
        prisma.aiUsageLog.count({ where: { ...whereClause, taskType: 'CONTENT_STUDIO' } }),
        prisma.aiUsageLog.count({ where: { ...whereClause, taskType: 'CLASSIFICATION' } })
      ]);

      const totalTokens = aggregations._sum.totalTokens || 0;
      const totalCostUsd = aggregations._sum.estimatedCostUsd || 0;
      const totalRequests = aggregations._count._all || 0;

      return {
        isConfigured: this.isConfigured(),
        gateway: 'OpenRouter',
        storage: 'POSTGRESQL_PERSISTENT',
        defaultModel: config.openrouter.defaultModel,
        replyModel: config.openrouter.replyModel,
        contentModel: config.openrouter.contentModel,
        classificationModel: config.openrouter.classificationModel,
        fallbackModel: config.openrouter.fallbackModel,
        totalRequests,
        totalTokens,
        estimatedCostUsd: Number(totalCostUsd.toFixed(4)),
        taskBreakdown: {
          replyGeneration: replyCount,
          contentStudio: contentCount,
          classification: classCount
        },
        recentRequests: logs.map((l) => ({
          id: l.id,
          tenantId: l.tenantId,
          brandId: l.brandId,
          userId: l.userId,
          taskType: l.taskType,
          modelUsed: l.modelUsed,
          promptTokens: l.promptTokens,
          completionTokens: l.completionTokens,
          totalTokens: l.totalTokens,
          estimatedCostUsd: l.estimatedCostUsd,
          timestamp: l.createdAt.toISOString()
        }))
      };
    } catch (err: any) {
      console.warn('[OpenRouter] Persistent usage query failed, using in-memory fallback:', err?.message || err);
      return this.getPlatformUsageSummary(tenantId);
    }
  }

  /**
   * Curated high-realism video models available on OpenRouter
   */
  static getCuratedVideoModels() {
    return [
      {
        id: 'google/veo-3.1-fast',
        name: 'Google: Veo 3.1 Fast (Recommended for Reels)',
        provider: 'Google DeepMind',
        isDefault: true,
        supportsAudio: true,
        resolutions: ['720p', '1080p', '4K'],
        aspectRatios: ['9:16', '16:9'],
        durations: [4, 6, 8],
        description: 'Google DeepMind flagship photorealistic video model with native synchronized audio and ultra-high realistic motion.'
      },
      {
        id: 'google/veo-3.1-lite',
        name: 'Google: Veo 3.1 Lite (Fast Preview)',
        provider: 'Google DeepMind',
        isDefault: false,
        supportsAudio: true,
        resolutions: ['720p', '1080p'],
        aspectRatios: ['9:16', '16:9'],
        durations: [4, 6, 8],
        description: 'Lightweight Veo 3.1 variant optimized for rapid social Reel turnarounds.'
      },
      {
        id: 'bytedance/seedance-2.5-flash',
        name: 'ByteDance: Seedance 2.5 Flash (Reels AI)',
        provider: 'ByteDance',
        isDefault: false,
        supportsAudio: true,
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['9:16', '16:9', '1:1'],
        durations: [4, 6, 8, 10],
        description: 'Latest ByteDance vertical video generator tuned for crisp short-form reels.'
      },
      {
        id: 'minimax/hailuo-3',
        name: 'MiniMax: Hailuo 3 Cinematic',
        provider: 'MiniMax',
        isDefault: false,
        supportsAudio: true,
        resolutions: ['720p', '1080p'],
        aspectRatios: ['9:16', '16:9', '1:1'],
        durations: [5, 6],
        description: 'Expressive subject motion and smooth camera choreography for commercial reels.'
      },
      {
        id: 'alibaba/wan-3.0-prime',
        name: 'Alibaba: Wan 3.0 Prime',
        provider: 'Alibaba Cloud',
        isDefault: false,
        supportsAudio: true,
        resolutions: ['720p', '1080p'],
        aspectRatios: ['9:16', '16:9', '1:1'],
        durations: [4, 6, 8, 10],
        description: 'High-definition photorealistic commercial video generation with audio.'
      }
    ];
  }

  /**
   * Curated high-realism image models available on OpenRouter
   */
  static getCuratedImageModels() {
    return [
      {
        id: 'black-forest-labs/flux-3-image-klein',
        name: 'Black Forest Labs: FLUX 3 (Recommended)',
        provider: 'Black Forest Labs',
        isDefault: true,
        description: 'Industry benchmark for photorealistic images, studio lighting, and product detail.'
      },
      {
        id: 'bytedance-seed/seedream-5-0-flash',
        name: 'ByteDance: Seedream 5.0 Flash',
        provider: 'ByteDance',
        isDefault: false,
        description: 'Fast, high-fidelity visual generation optimized for social media feeds.'
      },
      {
        id: 'recraft/recraft-v4.1-flash-v2:free',
        name: 'Recraft v4.1 Flash (Free In-App AI)',
        provider: 'Recraft',
        isDefault: false,
        description: 'Zero-cost crisp marketing visual generator available directly inside OmniSocial.'
      },
      {
        id: 'google/gemini-nano-banana-2.1',
        name: 'Google: Nano Banana 2.1',
        provider: 'Google',
        isDefault: false,
        description: 'Google multimodal realistic image synthesis.'
      }
    ];
  }

  /**
   * Submit Video Generation Job to OpenRouter
   */
  static async submitVideoGeneration(options: {
    prompt: string;
    model?: string;
    aspectRatio?: string;
    duration?: number;
    resolution?: string;
    generateAudio?: boolean;
  }): Promise<{ id: string; pollingUrl: string; status: string }> {
    const apiKey = config.openrouter.apiKey;
    if (!this.isConfigured()) {
      throw new OpenRouterConfigurationError('OpenRouter API key is not configured.');
    }

    const requestedModel = options.model || 'google/veo-3.1-fast';
    const model = requestedModel === 'kwaivgi/kling-v3.0-pro' ? 'bytedance/seedance-2.5-flash' : requestedModel;
    const aspectRatio = options.aspectRatio || '9:16';
    const duration = options.duration || 4;
    const resolution = options.resolution || '720p';
    const generateAudio = options.generateAudio !== false;

    const res = await axios.post(
      'https://openrouter.ai/api/v1/videos',
      {
        model,
        prompt: options.prompt,
        aspect_ratio: aspectRatio,
        duration,
        resolution,
        generate_audio: generateAudio
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 45000
      }
    );

    const jobId = res.data.id || res.data.generation_id;
    return {
      id: jobId,
      pollingUrl: res.data.polling_url || `https://openrouter.ai/api/v1/videos/${jobId}`,
      status: res.data.status || 'pending'
    };
  }

  /**
   * Poll Video Generation Status from OpenRouter
   */
  static async pollVideoStatus(jobId: string): Promise<{
    id: string;
    status: 'pending' | 'completed' | 'failed';
    unsignedUrls?: string[];
    error?: string;
  }> {
    const apiKey = config.openrouter.apiKey;
    if (!this.isConfigured()) {
      throw new OpenRouterConfigurationError('OpenRouter API key is not configured.');
    }

    const res = await axios.get(`https://openrouter.ai/api/v1/videos/${jobId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      timeout: 20000
    });

    const rawStatus = String(res.data?.status || 'pending').toLowerCase();
    const normalizedStatus: 'pending' | 'completed' | 'failed' =
      rawStatus === 'completed'
        ? 'completed'
        : ['failed', 'cancelled', 'expired', 'error'].includes(rawStatus)
          ? 'failed'
          : 'pending';

    const signedUrls = Array.isArray(res.data?.urls) ? res.data.urls : [];
    const unsignedUrls = Array.isArray(res.data?.unsigned_urls) ? res.data.unsigned_urls : [];
    const resolvedUrls = signedUrls.length > 0 ? signedUrls : unsignedUrls;

    return {
      id: res.data.id || jobId,
      status: normalizedStatus,
      unsignedUrls: resolvedUrls,
      error: res.data.error?.message || res.data.error
    };
  }

  /**
   * Download Generated Video Stream from OpenRouter (or signed storage URL)
   */
  static async downloadVideoBuffer(contentUrl: string): Promise<Buffer> {
    const apiKey = config.openrouter.apiKey;
    const isOpenRouterProxy = contentUrl.includes('openrouter.ai');
    const res = await axios.get(contentUrl, {
      headers: isOpenRouterProxy ? { Authorization: `Bearer ${apiKey}` } : undefined,
      responseType: 'arraybuffer',
      timeout: 90000
    });

    return Buffer.from(res.data);
  }

  /**
   * Generate Image using OpenRouter Image API with multi-model resilience (paid + free tier fallback)
   */
  static async generateImage(options: {
    prompt: string;
    model?: string;
    aspectRatio?: string;
  }): Promise<{ b64_json?: string; url?: string; mediaType?: string; modelUsed: string }> {
    const apiKey = config.openrouter.apiKey;
    if (!this.isConfigured()) {
      throw new OpenRouterConfigurationError('OpenRouter API key is not configured.');
    }

    const aspectRatio = options.aspectRatio || '1:1';
    const candidateModels = Array.from(
      new Set([
        options.model || 'black-forest-labs/flux-3-image-klein',
        'black-forest-labs/flux-3-image-klein',
        'bytedance-seed/seedream-5-0-flash',
        'recraft/recraft-v4.1-flash-v2:free'
      ])
    );

    let lastError: any = null;

    for (const model of candidateModels) {
      try {
        const res = await axios.post(
          'https://openrouter.ai/api/v1/images',
          {
            model,
            prompt: options.prompt,
            aspect_ratio: aspectRatio,
            n: 1
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 45000
          }
        );

        const first = res.data?.data?.[0];
        if (!first || (!first.b64_json && !first.url)) {
          throw new Error(`OpenRouter Image API (${model}) returned empty result`);
        }

        let cleanB64: string | undefined = first.b64_json;
        if (cleanB64 && cleanB64.includes(',')) {
          cleanB64 = cleanB64.split(',').pop();
        }

        return {
          b64_json: cleanB64,
          url: first.url,
          mediaType: first.media_type,
          modelUsed: model
        };
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status;
        const detail = err.response?.data?.error?.message || err.message;
        console.warn(`[OpenRouter] Image model ${model} failed (${status || 'ERR'}): ${detail}`);
      }
    }

    throw lastError || new Error('All OpenRouter image generation models failed');
  }
}


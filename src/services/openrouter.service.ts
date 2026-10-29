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
}


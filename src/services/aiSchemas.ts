import { z } from 'zod';

// ============================================================================
// 1. AI Reply Generation Schemas
// ============================================================================

export const ReplySuggestionSchema = z.object({
  tone: z.enum(['WARM_POLITE', 'CONCISE_DIRECT', 'ENTHUSIASTIC']),
  title: z.string().min(1),
  text: z.string().min(1)
});

export type ReplySuggestion = z.infer<typeof ReplySuggestionSchema>;

export const ReplySuggestionsResponseSchema = z.object({
  suggestions: z.array(ReplySuggestionSchema).min(1).max(5)
});

export type ReplySuggestionsResponse = z.infer<typeof ReplySuggestionsResponseSchema>;

// ============================================================================
// 2. AI Content Studio Generation Schemas
// ============================================================================

export const ContentVariantsSchema = z.object({
  facebook: z.string().optional().default(''),
  instagram: z.string().optional().default(''),
  linkedin: z.string().optional().default('')
});

export const AngleVariantSchema = z.object({
  angleLabel: z.string(),
  style: z.string(),
  copy: z.string(),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default('Explore More')
});

export type AngleVariant = z.infer<typeof AngleVariantSchema>;

export const GeneratedContentSchema = z.object({
  caption: z.string().default(''),
  variants: ContentVariantsSchema.default({ facebook: '', instagram: '', linkedin: '' }),
  angleVariants: z.array(AngleVariantSchema).optional().default([]),
  hashtags: z.array(z.string()).default([]),
  callToAction: z.string().default('Explore more'),
  characterCount: z.number().int().nonnegative().default(0)
});

export type GeneratedContent = z.infer<typeof GeneratedContentSchema>;

// ============================================================================
// 3. Interaction Classification Schemas
// ============================================================================

export const ClassificationResultSchema = z.object({
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
  sentimentScore: z.number().min(0).max(1),
  isQuestion: z.boolean(),
  isPricingInquiry: z.boolean(),
  isLeadIntent: z.boolean(),
  isSensitiveOrComplaint: z.boolean(),
  urgencyScore: z.number().int().min(1).max(5),
  reasoning: z.string()
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

// ============================================================================
// 4. OpenRouter API Request & Usage Schemas
// ============================================================================

export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: OpenRouterUsage;
}

export interface TokenUsageRecord {
  tenantId?: string | null;
  brandId?: string | null;
  userId?: string | null;
  taskType: 'REPLY_GENERATION' | 'CONTENT_STUDIO' | 'CLASSIFICATION';
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: string;
}


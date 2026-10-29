import { config } from '../config';
import {
  OpenRouterService,
  OpenRouterConfigurationError
} from './openrouter.service';
import { BrandContextService, EnrichedBrandContext } from './brandContext.service';
import {
  ReplySuggestion,
  ReplySuggestionsResponseSchema,
  GeneratedContent,
  GeneratedContentSchema,
  ClassificationResult,
  ClassificationResultSchema,
  OpenRouterChatMessage
} from './aiSchemas';

export {
  ReplySuggestion,
  ClassificationResult,
  GeneratedContent
};

export class AiService {
  /**
   * Helper to parse and extract valid JSON from LLM response content
   */
  private static parseJsonFromResponse(rawContent: string): any {
    const cleaned = rawContent
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Find outermost JSON object or array
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      }
      throw new Error(`Failed to parse structured JSON from AI output: "${rawContent.slice(0, 100)}..."`);
    }
  }

  /**
   * 1. Generate Contextual Reply Suggestions using Centralized OpenRouter Gateway
   */
  static async generateReplySuggestions(
    brandVoiceOrContext: any,
    interactionText: string,
    authorName: string,
    platform: string,
    brandId?: string,
    tenantId?: string | null,
    userId?: string | null
  ): Promise<ReplySuggestion[]> {
    // 1. Resolve brand context
    let brandContext: EnrichedBrandContext;

    if (brandId) {
      brandContext = await BrandContextService.getEnrichedBrandContext(brandId, interactionText);
    } else if (brandVoiceOrContext?.brandId) {
      brandContext = await BrandContextService.getEnrichedBrandContext(brandVoiceOrContext.brandId, interactionText);
    } else {
      // Synthesize context from passed brandVoice object
      const tone = brandVoiceOrContext?.tone || 'Professional, friendly, and helpful';
      const writingStyle = brandVoiceOrContext?.writingStyle || 'Conversational and engaging';
      const targetAudience = brandVoiceOrContext?.targetAudience || 'Modern consumers and valued community members';
      const bannedKeywords = (brandVoiceOrContext?.bannedKeywords || '')
        .split(',')
        .map((k: string) => k.trim().toLowerCase())
        .filter((k: string) => k.length > 0);

      brandContext = {
        brandId: 'adhoc-brand',
        brandName: 'Our Brand',
        businessName: 'Our Business',
        industry: 'General',
        website: '',
        description: '',
        tone,
        writingStyle,
        targetAudience,
        keyTerminology: [],
        bannedKeywords,
        responseGuidelines: brandVoiceOrContext?.responseGuidelines || 'Always greet politely and maintain brand integrity.',
        formattedFaqs: brandVoiceOrContext?.standardFaqs || 'No specific FAQs provided.',
        fewShotExamples: []
      };
    }

    // 2. Build Structured System Prompt
    const bannedClause = brandContext.bannedKeywords.length > 0
      ? `STRICT SAFETY RULE: You must NEVER use or mention any of these forbidden keywords: [${brandContext.bannedKeywords.join(', ')}].`
      : 'Maintain high professionalism and safety standards.';

    const systemPrompt = `You are the designated Senior Social Media Engagement & Community Specialist for "${brandContext.brandName}".
Your mission is to generate 3 distinct, high-converting, empathetic, and on-brand reply suggestions for human review.

### Brand Identity & Voice Persona:
- Brand Name: ${brandContext.brandName}
- Industry: ${brandContext.industry}
- Tone of Voice: ${brandContext.tone}
- Writing Style: ${brandContext.writingStyle}
- Target Audience: ${brandContext.targetAudience}
- Response Guidelines: ${brandContext.responseGuidelines}
${bannedClause}

### Approved Knowledge Base & FAQs:
${brandContext.formattedFaqs}

### Output Requirements:
You must provide exactly 3 distinct reply options formatted in strict JSON:
1. "WARM_POLITE": Warm, polite, empathetic, and community-building (Recommended default).
2. "CONCISE_DIRECT": Direct, concise, action-oriented, and straightforward.
3. "ENTHUSIASTIC": Vibrant, engaging, high-energy with tasteful emojis aligned with brand tone.

Respond ONLY with a valid JSON object matching this schema:
{
  "suggestions": [
    {
      "tone": "WARM_POLITE",
      "title": "Warm & Helpful (Recommended)",
      "text": "..."
    },
    {
      "tone": "CONCISE_DIRECT",
      "title": "Quick & Direct",
      "text": "..."
    },
    {
      "tone": "ENTHUSIASTIC",
      "title": "Engaging & Vibrant",
      "text": "..."
    }
  ]
}`;

    const userPrompt = `A customer reached out on ${platform.toUpperCase()}:
Author Name: ${authorName || 'Valued Customer'}
Customer Message: "${interactionText}"

Please generate the 3 distinct brand reply suggestions now.`;

    const messages: OpenRouterChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 3. Dispatch to OpenRouter using configured reply model
    const response = await OpenRouterService.createChatCompletion(messages, {
      model: config.openrouter.replyModel,
      temperature: 0.7,
      responseFormatJson: true,
      tenantId,
      brandId: brandContext.brandId,
      userId,
      taskType: 'REPLY_GENERATION'
    });

    // 4. Validate output with Zod
    const parsedJson = this.parseJsonFromResponse(response.content);
    const validated = ReplySuggestionsResponseSchema.parse(parsedJson);

    // 5. Post-generation safety scan for banned keywords
    const sanitizedSuggestions = validated.suggestions.map((suggestion) => {
      const scan = BrandContextService.scanForBannedKeywords(suggestion.text, brandContext.bannedKeywords);
      return {
        ...suggestion,
        text: scan.sanitizedText
      };
    });

    return sanitizedSuggestions;
  }

  /**
   * 2. AI Content Studio Post Generator
   */
  static async generateContent(
    brandVoiceOrContext: any,
    rawIdea: string,
    targetPlatforms: string[] = ['FACEBOOK', 'INSTAGRAM'],
    format = 'POST',
    brandId?: string,
    tenantId?: string | null,
    userId?: string | null
  ): Promise<GeneratedContent> {
    let brandContext: EnrichedBrandContext;

    if (brandId) {
      brandContext = await BrandContextService.getEnrichedBrandContext(brandId);
    } else if (brandVoiceOrContext?.brandId) {
      brandContext = await BrandContextService.getEnrichedBrandContext(brandVoiceOrContext.brandId);
    } else {
      brandContext = {
        brandId: 'adhoc-brand',
        brandName: 'Our Brand',
        businessName: 'Our Business',
        industry: 'General',
        website: '',
        description: '',
        tone: brandVoiceOrContext?.tone || 'Engaging and polished',
        writingStyle: brandVoiceOrContext?.writingStyle || 'Conversational and persuasive',
        targetAudience: brandVoiceOrContext?.targetAudience || 'Modern consumers',
        keyTerminology: [],
        bannedKeywords: [],
        responseGuidelines: '',
        formattedFaqs: '',
        fewShotExamples: []
      };
    }

    const systemPrompt = `You are a World-Class Creative Social Media Copywriter and Strategist for "${brandContext.brandName}".
Generate high-engagement social media copy, platform-tailored variations, relevant hashtags, and a compelling call-to-action (CTA).

### Brand Guidelines:
- Brand: ${brandContext.brandName}
- Industry: ${brandContext.industry}
- Tone: ${brandContext.tone}
- Writing Style: ${brandContext.writingStyle}
- Target Audience: ${brandContext.targetAudience}
${brandContext.bannedKeywords.length > 0 ? `- FORBIDDEN WORDS: ${brandContext.bannedKeywords.join(', ')}` : ''}

### Formatting Specifications:
- Facebook Variant: Conversational, community-focused, storytelling with line breaks and clear CTA.
- Instagram Variant: Catchy hook, visually expressive with tasteful emojis, bullet points, CTA, followed by clean hashtag spacing.
- Format Requested: ${format.toUpperCase()} (e.g. POST, REEL, STORY, CAROUSEL)

Respond ONLY with a valid JSON object matching this schema:
{
  "caption": "Primary complete caption",
  "variants": {
    "facebook": "Facebook optimized text",
    "instagram": "Instagram optimized text"
  },
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4", "#Tag5"],
  "callToAction": "Short call to action phrase",
  "characterCount": 250
}`;

    const userPrompt = `Creative Post Brief / Idea: "${rawIdea}"
Target Platforms: [${targetPlatforms.join(', ')}]
Format: ${format}`;

    const messages: OpenRouterChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const response = await OpenRouterService.createChatCompletion(messages, {
      model: config.openrouter.contentModel,
      temperature: 0.8,
      responseFormatJson: true,
      tenantId,
      brandId: brandContext.brandId,
      userId,
      taskType: 'CONTENT_STUDIO'
    });

    const parsedJson = this.parseJsonFromResponse(response.content);
    parsedJson.characterCount = parsedJson.caption?.length || 0;
    const validated = GeneratedContentSchema.parse(parsedJson);

    return validated;
  }

  /**
   * 3. AI Interaction Classification (Sentiment, Urgency, Intent)
   */
  static async classifyInteraction(
    text: string,
    tenantId?: string | null,
    brandId?: string | null,
    userId?: string | null
  ): Promise<ClassificationResult> {
    if (!text || !text.trim()) {
      return {
        sentiment: 'NEUTRAL',
        sentimentScore: 0.5,
        isQuestion: false,
        isPricingInquiry: false,
        isLeadIntent: false,
        isSensitiveOrComplaint: false,
        urgencyScore: 1,
        reasoning: 'Empty or blank interaction text.'
      };
    }

    // If OpenRouter is not configured, throw configuration error
    if (!OpenRouterService.isConfigured()) {
      throw new OpenRouterConfigurationError(
        'Centralized OpenRouter API key is not configured on the platform. The Platform Super Admin must set OPENROUTER_API_KEY.'
      );
    }

    const systemPrompt = `You are an AI customer interaction classification engine.
Analyze the customer's comment or message with high precision.
Determine:
1. sentiment: "POSITIVE", "NEUTRAL", or "NEGATIVE"
2. sentimentScore: decimal between 0.0 (extremely negative) and 1.0 (extremely positive)
3. isQuestion: true if customer is asking a question or requesting info
4. isPricingInquiry: true if asking about price, discounts, shipping costs, or COD
5. isLeadIntent: true if expressing purchase intent, wanting to buy, or asking for demo/quote
6. isSensitiveOrComplaint: true if complaining, angry, reporting damaged goods, fraud, or requesting refund
7. urgencyScore: integer from 1 (lowest) to 5 (urgent complaint, angry customer, or immediate hot lead)
8. reasoning: 1 concise sentence explaining the classification

Respond ONLY with a valid JSON object matching this schema:
{
  "sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
  "sentimentScore": 0.85,
  "isQuestion": true,
  "isPricingInquiry": false,
  "isLeadIntent": true,
  "isSensitiveOrComplaint": false,
  "urgencyScore": 4,
  "reasoning": "..."
}`;

    const userPrompt = `Message to classify: "${text}"`;

    const messages: OpenRouterChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const response = await OpenRouterService.createChatCompletion(messages, {
      model: config.openrouter.classificationModel,
      temperature: 0.2, // deterministic for classification
      responseFormatJson: true,
      tenantId,
      brandId,
      userId,
      taskType: 'CLASSIFICATION'
    });

    const parsedJson = this.parseJsonFromResponse(response.content);
    return ClassificationResultSchema.parse(parsedJson);
  }

  /**
   * 4. Retrieve Centralized Platform AI Usage & Cost Summary (Persistent)
   */
  static async getPlatformUsage(tenantId?: string | null) {
    return OpenRouterService.getPersistentUsageSummary(tenantId);
  }

  /**
   * Synchronous fallback for legacy callers
   */
  static getPlatformUsageSync(tenantId?: string | null) {
    return OpenRouterService.getPlatformUsageSummary(tenantId);
  }
}

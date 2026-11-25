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
  AngleVariant,
  AngleVariantSchema,
  ClassificationResult,
  ClassificationResultSchema,
  OpenRouterChatMessage
} from './aiSchemas';

export {
  ReplySuggestion,
  ClassificationResult,
  GeneratedContent,
  AngleVariant
};

export class AiService {
  /**
   * Helper to parse and extract valid JSON from LLM response content with 5-stage resilience
   */
  static parseJsonFromResponse(rawContent: string): any {
    if (!rawContent || typeof rawContent !== 'string') {
      return { caption: '', hashtags: [], variants: { facebook: '', instagram: '', linkedin: '' } };
    }

    const cleaned = rawContent
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Stage 1: Direct JSON.parse
    try {
      return JSON.parse(cleaned);
    } catch {
      // Stage 2: Substring between first { and last }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = cleaned.substring(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Stage 3: Strip trailing commas and sanitize unescaped newlines/tabs inside string values
          try {
            const noTrailingCommas = candidate.replace(/,\s*([\]}])/g, '$1');
            const sanitized = noTrailingCommas.replace(
              /"([^"\\]*(\\.[^"\\]*)*)"/g,
              (match) => match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
            );
            return JSON.parse(sanitized);
          } catch {
            // Stage 4: Regex extraction of structured fields (caption, hashtags, variants, angleVariants)
            const captionMatch = cleaned.match(/"caption"\s*:\s*"([\s\S]*?)(?<!\\)"/);
            const hashtagsMatch = cleaned.match(/"hashtags"\s*:\s*\[([\s\S]*?)\]/);
            const ctaMatch = cleaned.match(/"callToAction"\s*:\s*"([\s\S]*?)(?<!\\)"/);

            let hashtags: string[] = [];
            if (hashtagsMatch && hashtagsMatch[1]) {
              hashtags = (hashtagsMatch[1].match(/#[a-zA-Z0-9_]+/g) || []) as string[];
            }
            if (hashtags.length === 0) {
              hashtags = (cleaned.match(/#[a-zA-Z0-9_]+/g) || ['#SocialMedia', '#BrandGrowth']) as string[];
            }

            // Salvage any complete angleVariant objects even from truncated JSON
            const salvagedAngleVariants: any[] = [];
            const angleObjRegex = /\{\s*"angleLabel"\s*:\s*"([^"]+)"\s*,\s*"style"\s*:\s*"([^"]+)"\s*,\s*"copy"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?\}/g;
            let angleMatch: RegExpExecArray | null;
            while ((angleMatch = angleObjRegex.exec(cleaned)) !== null) {
              const ctaInnerMatch = angleMatch[0].match(/"cta"\s*:\s*"([^"]+)"/);
              const tagsInnerMatch = angleMatch[0].match(/"hashtags"\s*:\s*\[([^\]]*)\]/);
              const itemTags = tagsInnerMatch
                ? ((tagsInnerMatch[1].match(/#[a-zA-Z0-9_]+/g) || []) as string[])
                : hashtags;
              salvagedAngleVariants.push({
                angleLabel: angleMatch[1],
                style: angleMatch[2],
                copy: angleMatch[3].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
                hashtags: itemTags.length > 0 ? itemTags : hashtags,
                cta: ctaInnerMatch ? ctaInnerMatch[1] : 'Learn More'
              });
            }

            if (captionMatch && captionMatch[1]) {
              const cleanCap = captionMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
              return {
                caption: cleanCap,
                variants: {
                  facebook: cleanCap,
                  instagram: cleanCap,
                  linkedin: cleanCap
                },
                angleVariants: salvagedAngleVariants.length > 0 ? salvagedAngleVariants : undefined,
                hashtags,
                callToAction: ctaMatch ? ctaMatch[1] : 'Explore more',
                characterCount: cleanCap.length
              };
            }
          }
        }
      }

      // Stage 5: Clean raw text fallback if model replied in freeform text
      const fallbackText = cleaned
        .replace(/^[{\[\s"]+|[}\]\s"]+$/g, '')
        .replace(/"?caption"?\s*:\s*"?/gi, '')
        .trim();

      const extractedTags = (cleaned.match(/#[a-zA-Z0-9_]+/g) || ['#SocialMedia', '#BrandGrowth']) as string[];

      return {
        caption: fallbackText.slice(0, 800) || rawContent.slice(0, 300).trim(),
        variants: {
          facebook: fallbackText.slice(0, 800),
          instagram: fallbackText.slice(0, 800),
          linkedin: fallbackText.slice(0, 800)
        },
        hashtags: extractedTags,
        callToAction: 'Learn more',
        characterCount: fallbackText.length
      };
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

### Brand Identity, Products & Services Base:
- Brand Name: ${brandContext.brandName}
- Company & Product Overview: ${brandContext.description || 'High quality products and services dedicated to customer excellence.'}
- Official Website: ${brandContext.website || 'Not specified'}
- Industry: ${brandContext.industry}
- Tone of Voice: ${brandContext.tone}
- Writing Style: ${brandContext.writingStyle}
- Target Audience: ${brandContext.targetAudience}
- Response Directives for Comments & DMs: ${brandContext.responseGuidelines}
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
- LinkedIn Variant: Professional, insightful, thought-leadership style, structured spacing, high-value takeaway, and professional CTA.
- Angle Variants: MANDATORY — Generate ALL 4 distinct strategic angles in the angleVariants array, deeply anchored ONLY to the user's actual brief:
  1. Direct Hook & Story (Style: 'Storytelling' - rich narrative hook focusing on the exact scenario, setting, product details, and emotional appeal)
  2. Actionable Breakdown (Style: 'Framework / Listicle' - 3 concrete, practical takeaways, specs, or highlights strictly from the subject matter; NEVER emit corporate clichés like 'Purpose & Clarity', 'Consistent Execution', or 'Measurable Impact')
  3. Behind-The-Scenes Craft (Style: 'Insight / Advice' - authentic insight into the craft, preparation, provenance, heritage, or engineering behind THIS exact subject)
  4. Community Discussion (Style: 'Question / Discussion' - an engaging, topic-relevant question or prompt inviting reader comments)
  STRICT RULES FOR ALL VARIANTS:
  - Stay 100% faithful to the user's specific product/topic/industry — NEVER borrow imagery or terms from unrelated industries.
  - Do NOT use markdown **double-asterisk** syntax anywhere in copy; use clean plain text, line breaks, and emojis.
  - EVERY single variant copy in angleVariants (all 4) MUST end on a new line with 3–4 relevant hashtags matching its hashtags array (e.g. #Tag1 #Tag2 #Tag3 #Tag4).
- Format Requested: ${format.toUpperCase()} (e.g. POST, REEL, STORY, CAROUSEL)
- Current Year Context: The current year is 2026. Clamp all festive, annual, and seasonal hashtags strictly to 2026 (e.g. #Diwali2026, never emit #Diwali2023 or older years).

Respond ONLY with a valid JSON object matching this schema:
{
  "caption": "Primary complete caption (ending with hashtags)",
  "variants": {
    "facebook": "Facebook optimized text",
    "instagram": "Instagram optimized text",
    "linkedin": "LinkedIn optimized text"
  },
  "angleVariants": [
    {
      "angleLabel": "Direct Hook & Story",
      "style": "Storytelling",
      "copy": "Full storytelling caption on topic...\n\n#Tag1 #Tag2 #Tag3 #Tag4",
      "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4"],
      "cta": "Explore Now"
    },
    {
      "angleLabel": "Actionable Breakdown",
      "style": "Framework / Listicle",
      "copy": "Full breakdown caption on topic...\n\n#Tag1 #Tag2 #Tag3 #Tag4",
      "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4"],
      "cta": "Learn More"
    },
    {
      "angleLabel": "Behind-The-Scenes Craft",
      "style": "Insight / Advice",
      "copy": "Full behind-the-scenes caption on topic...\n\n#Tag1 #Tag2 #Tag3 #Tag4",
      "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4"],
      "cta": "Share Your Thoughts"
    },
    {
      "angleLabel": "Community Discussion",
      "style": "Question / Discussion",
      "copy": "Full community question caption on topic...\n\n#Tag1 #Tag2 #Tag3 #Tag4",
      "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4"],
      "cta": "Comment Below"
    }
  ],
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
      temperature: 0.75,
      maxTokens: 3500,
      responseFormatJson: true,
      tenantId,
      brandId: brandContext.brandId,
      userId,
      taskType: 'CONTENT_STUDIO'
    });

    const parsedJson = this.parseJsonFromResponse(response.content);
    parsedJson.characterCount = parsedJson.caption?.length || 0;

    // Clamp any stale years (e.g. 2023, 2024, 2025) strictly to 2026
    if (Array.isArray(parsedJson.hashtags)) {
      parsedJson.hashtags = parsedJson.hashtags.map((tag: string) =>
        typeof tag === 'string' ? tag.replace(/202[0-5]\b/g, '2026') : tag
      );
    }
    if (parsedJson.caption && typeof parsedJson.caption === 'string') {
      parsedJson.caption = parsedJson.caption.replace(/202[0-5]\b/g, '2026');
    }
    if (parsedJson.variants && typeof parsedJson.variants === 'object') {
      for (const k of Object.keys(parsedJson.variants)) {
        if (typeof parsedJson.variants[k] === 'string') {
          parsedJson.variants[k] = parsedJson.variants[k].replace(/202[0-5]\b/g, '2026');
        }
      }
    }

    const effectiveHashtags = Array.isArray(parsedJson.hashtags) && parsedJson.hashtags.length > 0
      ? parsedJson.hashtags
      : ['#BrandSpotlight', '#Storytelling', '#CommunityFirst', '#Growth2026'];

    parsedJson.angleVariants = await this.ensureFourAuthenticVariants({
      rawIdea,
      baseCaption: parsedJson.caption || '',
      existingVariants: parsedJson.angleVariants,
      hashtags: effectiveHashtags,
      callToAction: parsedJson.callToAction || 'Learn More',
      brandContext: {
        brandName: brandContext.brandName,
        industry: brandContext.industry,
        tone: brandContext.tone,
        targetAudience: brandContext.targetAudience
      },
      tenantId,
      brandId: brandContext.brandId,
      userId
    });

    // Keep caption synced with first variant if caption was empty or missing tags
    if (!parsedJson.caption && parsedJson.angleVariants[0]?.copy) {
      parsedJson.caption = parsedJson.angleVariants[0].copy;
      parsedJson.characterCount = parsedJson.caption.length;
    }

    const validated = GeneratedContentSchema.parse(parsedJson);

    return validated;
  }

  /**
   * Pure topic-faithful variant synthesizer (zero cross-category template invention).
   * Used ONLY if OpenRouter is completely unavailable. Strictly extracts sentences and phrases
   * from the caller's actual brief and primary caption.
   */
  private static synthesizeTopicFaithfulVariants(
    rawIdea: string,
    baseCaption: string,
    effectiveHashtags: string[],
    callToAction: string
  ): AngleVariant[] {
    const cleanBrief = (rawIdea || '').replace(/202[0-5]\b/g, '2026').trim();
    const cleanBase = (baseCaption || '').replace(/202[0-5]\b/g, '2026').trim();

    // Extract clean sentences/clauses strictly from the actual brief and base caption
    const rawClauses = `${cleanBase}\n${cleanBrief}`
      .split(/[\n•\|]+|(?<=[.!?])\s+/)
      .map(s => s.replace(/^[*\-\d.)\s]+/, '').trim())
      .filter(s => s.length > 18 && !s.startsWith('#') && !/^https?:\/\//i.test(s));

    const uniqueClauses = Array.from(new Set(rawClauses));
    const headlineSource = cleanBrief.split(/[\n.!?]/)[0]?.trim() || uniqueClauses[0] || 'Featured Highlight';
    const shortTitle = headlineSource.length > 70 ? headlineSource.slice(0, 67) + '...' : headlineSource;

    const point1 = uniqueClauses[0] || `Focused on ${shortTitle}.`;
    const point2 = uniqueClauses[1] || cleanBrief || `Designed with care around ${shortTitle}.`;
    const point3 = uniqueClauses[2] || `Crafted to deliver genuine value for everyone following ${shortTitle}.`;
    const tagLine = effectiveHashtags.slice(0, 4).join(' ');

    return [
      {
        angleLabel: 'Direct Hook & Story',
        style: 'Storytelling',
        copy: cleanBase || `${shortTitle}\n\n${point2}\n\n${tagLine}`,
        hashtags: effectiveHashtags,
        cta: callToAction || 'Explore Now'
      },
      {
        angleLabel: 'Actionable Breakdown',
        style: 'Framework / Listicle',
        copy: `Closer Look: ${shortTitle}\n\nKey highlights to explore:\n\n1. ${point1}\n2. ${point2}\n3. ${point3}\n\nSave this post for reference or reach out for full details.\n\n${tagLine}`,
        hashtags: effectiveHashtags,
        cta: 'Learn More'
      },
      {
        angleLabel: 'Behind-The-Scenes Craft',
        style: 'Insight / Advice',
        copy: `The story and care behind ${shortTitle}\n\n${point1}\n\nEvery detail takes intentional focus and pride in execution: ${point2}\n\n${tagLine}`,
        hashtags: effectiveHashtags,
        cta: 'Share Your Thoughts'
      },
      {
        angleLabel: 'Community Discussion',
        style: 'Question / Discussion',
        copy: `We would love your perspective on ${shortTitle} 👇\n\n${point1}\n\nWhich aspect resonates with you most? Drop your thoughts in the comments below!\n\n${tagLine}`,
        hashtags: effectiveHashtags,
        cta: 'Comment Below'
      }
    ];
  }

  /**
   * Shared guarantee used by both Composer (/ai/generate-post) and Orchestrator (/skills/orchestrate):
   * Ensures exactly 4 distinct, genuine, topic-faithful variants with hashtags embedded consistently in copy.
   */
  static async ensureFourAuthenticVariants(params: {
    rawIdea: string;
    baseCaption: string;
    existingVariants?: any[];
    hashtags?: string[];
    callToAction?: string;
    brandContext?: { brandName: string; industry: string; tone: string; targetAudience: string };
    tenantId?: string | null;
    brandId?: string | null;
    userId?: string | null;
  }): Promise<AngleVariant[]> {
    const normalizeTags = (arr: any[], fallback: string[]): string[] => {
      const cleaned = (Array.isArray(arr) ? arr : [])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 1)
        .map(t => {
          const trimmed = t.trim().replace(/\s+/g, '').replace(/202[0-5]\b/g, '2026');
          return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        });
      const base = cleaned.length > 0 ? cleaned : fallback;
      return Array.from(new Set(base)).slice(0, 5);
    };

    const effectiveHashtags = normalizeTags(
      params.hashtags || [],
      ['#BrandSpotlight', '#Storytelling', '#CommunityFirst', '#Growth2026']
    );

    const cannedLeakRegex = /Purpose & Clarity|Consistent Execution|Measurable Impact|Focused Intent|Measurable Value|Supple Natural Leather|genuine hand-stitched footwear|Weekend Thali|Essential Framework:|Essential Highlights:/i;

    const filterValid = (items: any[] | undefined): AngleVariant[] => {
      if (!Array.isArray(items)) return [];
      return items
        .filter(item =>
          item &&
          typeof item === 'object' &&
          typeof item.copy === 'string' &&
          item.copy.trim().length >= 35 &&
          !cannedLeakRegex.test(item.copy)
        )
        .map((item, idx) => ({
          angleLabel: typeof item.angleLabel === 'string' && item.angleLabel.trim()
            ? item.angleLabel.trim()
            : ['Direct Hook & Story', 'Actionable Breakdown', 'Behind-The-Scenes Craft', 'Community Discussion'][idx] || 'Direct Hook & Story',
          style: typeof item.style === 'string' && item.style.trim()
            ? item.style.trim()
            : ['Storytelling', 'Framework / Listicle', 'Insight / Advice', 'Question / Discussion'][idx] || 'Storytelling',
          copy: item.copy.replace(/202[0-5]\b/g, '2026').trim(),
          hashtags: normalizeTags(item.hashtags, effectiveHashtags),
          cta: typeof item.cta === 'string' && item.cta.trim()
            ? item.cta.trim()
            : ['Explore Now', 'Learn More', 'Share Your Thoughts', 'Comment Below'][idx] || 'Learn More'
        }));
    };

    let validVariants = filterValid(params.existingVariants);

    // Repair pass via dedicated lightweight OpenRouter call whenever LLM returned < 4 genuine variants
    if (validVariants.length < 4 && OpenRouterService.isConfigured()) {
      try {
        const repairSystem = `You are a Senior Social Media Copywriter for "${params.brandContext?.brandName || 'our brand'}" (${params.brandContext?.industry || 'General'}).
Return strictly valid JSON containing an "angleVariants" array with EXACTLY 4 complete, unique, deeply topic-specific social post captions:
1. "Direct Hook & Story" (Style: "Storytelling") — vivid narrative hook grounded directly in the brief
2. "Actionable Breakdown" (Style: "Framework / Listicle") — 3–4 concrete facts, highlights, specs, or steps directly from the brief
3. "Behind-The-Scenes Craft" (Style: "Insight / Advice") — authentic provenance, process, materials, or team insight strictly about THIS brief
4. "Community Discussion" (Style: "Question / Discussion") — specific conversational prompt inviting reader comments about THIS brief

CRITICAL RULES:
- Use ONLY real facts, products, locations, materials, specs, and details present in the brief or reference caption. NEVER borrow products or templates from unrelated industries.
- Do NOT use markdown **double-asterisk** syntax.
- EVERY variant's "copy" MUST end cleanly after a blank line with 3–4 relevant hashtags matching its "hashtags" array.
- Clamp any years strictly to 2026.`;

        const repairUser = `Brief / Topic: "${params.rawIdea || params.baseCaption.slice(0, 120)}"
Reference Primary Caption: "${(params.baseCaption || '').slice(0, 600)}"
Brand Tone: ${params.brandContext?.tone || 'Engaging and authentic'}
Target Audience: ${params.brandContext?.targetAudience || 'Targeted buyers & community'}

Respond ONLY with JSON:
{
  "angleVariants": [
    { "angleLabel": "Direct Hook & Story", "style": "Storytelling", "copy": "...", "hashtags": ["#Tag1", "#Tag2", "#Tag3"], "cta": "Explore Now" },
    { "angleLabel": "Actionable Breakdown", "style": "Framework / Listicle", "copy": "...", "hashtags": ["#Tag1", "#Tag2", "#Tag3"], "cta": "Learn More" },
    { "angleLabel": "Behind-The-Scenes Craft", "style": "Insight / Advice", "copy": "...", "hashtags": ["#Tag1", "#Tag2", "#Tag3"], "cta": "Share Your Thoughts" },
    { "angleLabel": "Community Discussion", "style": "Question / Discussion", "copy": "...", "hashtags": ["#Tag1", "#Tag2", "#Tag3"], "cta": "Comment Below" }
  ]
}`;

        const repairRes = await OpenRouterService.createChatCompletion(
          [
            { role: 'system', content: repairSystem },
            { role: 'user', content: repairUser }
          ],
          {
            model: config.openrouter.contentModel,
            temperature: 0.75,
            maxTokens: 2500,
            responseFormatJson: true,
            tenantId: params.tenantId,
            brandId: params.brandId,
            userId: params.userId,
            taskType: 'CONTENT_STUDIO'
          }
        );

        const repairedJson = this.parseJsonFromResponse(repairRes.content);
        const repairedValid = filterValid(repairedJson?.angleVariants);
        if (repairedValid.length >= 4) {
          validVariants = repairedValid.slice(0, 4);
        } else if (repairedValid.length > validVariants.length) {
          validVariants = repairedValid;
        }
      } catch (repairErr: any) {
        console.warn('[AiService] Variant repair call notice:', repairErr?.message || repairErr);
      }
    }

    // Complete any remaining missing slots cleanly without cross-bleeding foreign templates
    if (validVariants.length < 4) {
      const synthetic = this.synthesizeTopicFaithfulVariants(
        params.rawIdea,
        params.baseCaption,
        effectiveHashtags,
        params.callToAction || 'Learn More'
      );
      while (validVariants.length < 4) {
        validVariants.push(synthetic[validVariants.length]);
      }
    }

    const defaultAngles = [
      { angleLabel: 'Direct Hook & Story', style: 'Storytelling', cta: params.callToAction || 'Explore Now' },
      { angleLabel: 'Actionable Breakdown', style: 'Framework / Listicle', cta: 'Learn More' },
      { angleLabel: 'Behind-The-Scenes Craft', style: 'Insight / Advice', cta: 'Share Your Thoughts' },
      { angleLabel: 'Community Discussion', style: 'Question / Discussion', cta: 'Comment Below' }
    ];

    // Enforce consistent inline hashtags across ALL 4 variants & clean 2026 clamping
    return validVariants.slice(0, 4).map((item, idx) => {
      const defaults = defaultAngles[idx];
      const variantTags = normalizeTags(item.hashtags, effectiveHashtags);
      let finalCopy = (item.copy || '').replace(/202[0-5]\b/g, '2026').trim();

      // Embed hashtags consistently in copy across variants 1-4 if fewer than 2 hashtags are present
      const inlineTagsCount = (finalCopy.match(/(?:^|\s)#[a-zA-Z0-9_]{2,}/g) || []).length;
      if (inlineTagsCount < 2 && variantTags.length > 0) {
        const missingTags = variantTags
          .slice(0, 4)
          .filter(t => !finalCopy.toLowerCase().includes(t.toLowerCase()));
        if (missingTags.length > 0) {
          finalCopy = `${finalCopy}\n\n${missingTags.join(' ')}`;
        }
      }

      return {
        angleLabel: item.angleLabel || defaults.angleLabel,
        style: item.style || defaults.style,
        copy: finalCopy,
        hashtags: variantTags,
        cta: item.cta || defaults.cta
      };
    });
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

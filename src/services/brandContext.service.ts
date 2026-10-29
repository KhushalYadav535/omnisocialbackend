import { prisma } from './db.service';
import { KnowledgeRetrievalService } from './knowledgeRetrieval.service';

export interface EnrichedBrandContext {
  brandId: string;
  brandName: string;
  businessName: string;
  industry: string;
  website: string;
  description: string;
  tone: string;
  writingStyle: string;
  targetAudience: string;
  keyTerminology: string[];
  bannedKeywords: string[];
  responseGuidelines: string;
  formattedFaqs: string;
  fewShotExamples: Array<{ scenario: string; goodReply: string; badReply?: string }>;
}

export class BrandContextService {
  /**
   * Resolve complete, enriched brand context and voice guidelines from PostgreSQL
   */
  static async getEnrichedBrandContext(
    brandId: string,
    customerQuery?: string
  ): Promise<EnrichedBrandContext> {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        business: true,
        voiceProfile: true
      }
    });

    if (!brand) {
      throw new Error(`Brand with ID "${brandId}" was not found.`);
    }

    const voice = brand.voiceProfile;
    const tone = voice?.tone || 'Professional, friendly, and helpful';
    const writingStyle = voice?.writingStyle || 'Conversational and engaging';
    const targetAudience = voice?.targetAudience || 'Modern consumers and valued community members';

    // Parse banned keywords
    const bannedKeywords = (voice?.bannedKeywords || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);

    // Parse key terminology
    const keyTerminology = (voice?.keyTerminology || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    // Parse few-shot example replies
    let fewShotExamples: Array<{ scenario: string; goodReply: string; badReply?: string }> = [];
    if (voice?.exampleReplies) {
      try {
        const parsed = JSON.parse(voice.exampleReplies);
        if (Array.isArray(parsed)) {
          fewShotExamples = parsed;
        }
      } catch {
        // ignore parse error on example replies
      }
    }

    // Retrieve and format relevant knowledge
    const allSnippets = KnowledgeRetrievalService.parseFaqs(voice?.standardFaqs);
    const relevantSnippets = customerQuery
      ? KnowledgeRetrievalService.retrieveRelevantKnowledge(allSnippets, customerQuery, 4)
      : allSnippets.slice(0, 4);
    const formattedFaqs = KnowledgeRetrievalService.formatForPrompt(relevantSnippets);

    return {
      brandId: brand.id,
      brandName: brand.name,
      businessName: brand.business?.name || brand.name,
      industry: brand.business?.industry || 'General',
      website: brand.website || brand.business?.website || '',
      description: brand.description || '',
      tone,
      writingStyle,
      targetAudience,
      keyTerminology,
      bannedKeywords,
      responseGuidelines: voice?.responseGuidelines || 'Always greet politely and maintain brand integrity.',
      formattedFaqs,
      fewShotExamples
    };
  }

  /**
   * Safety check: Scan generated output for banned keywords.
   * Returns clean output and list of detected violations.
   */
  static scanForBannedKeywords(
    text: string,
    bannedKeywords: string[]
  ): { isSafe: boolean; detectedKeywords: string[]; sanitizedText: string } {
    if (!bannedKeywords || bannedKeywords.length === 0) {
      return { isSafe: true, detectedKeywords: [], sanitizedText: text };
    }

    const detectedKeywords: string[] = [];
    let sanitizedText = text;

    for (const keyword of bannedKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      if (regex.test(text)) {
        detectedKeywords.push(keyword);
        sanitizedText = sanitizedText.replace(regex, '[redacted]');
      }
    }

    return {
      isSafe: detectedKeywords.length === 0,
      detectedKeywords,
      sanitizedText
    };
  }
}


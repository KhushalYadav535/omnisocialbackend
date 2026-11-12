import axios from 'axios';
import { OpenRouterService } from './openrouter.service';
import { config } from '../config';

export interface RepurposedCampaign {
  title: string;
  sourceUrl?: string;
  summary: string;
  keyTakeaways: string[];
  linkedinCarousel: {
    title: string;
    hook: string;
    slides: Array<{
      slideNumber: number;
      tagline: string;
      heading: string;
      body?: string;
      bullets?: string[];
      highlight?: string;
    }>;
  };
  instagramReel: {
    hookText: string;
    visualDirection: string;
    voiceoverScript: string;
    caption: string;
    hashtags: string[];
    suggestedAudioStyle: string;
  };
  twitterThread: Array<{
    tweetNumber: number;
    text: string;
  }>;
  facebookPost: {
    headline: string;
    body: string;
    questionPrompt: string;
    hashtags: string[];
  };
}

export class RepurposeService {
  /**
   * Fetches readable text from a URL
   */
  static async extractArticleText(url: string): Promise<{ title: string; text: string }> {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 10000
      });

      const html = String(response.data);

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : 'Source Article';

      // Clean HTML to readable text
      let text = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate to first 4,000 characters for token efficiency
      text = text.slice(0, 4000);

      return { title, text };
    } catch (err: any) {
      console.warn('[RepurposeService] Article scrape warning:', err.message);
      return {
        title: 'Provided Web Content',
        text: `Content extracted from ${url}`
      };
    }
  }

  /**
   * Generates a 4-channel cross-platform campaign from a URL or raw text
   */
  static async repurposeContent(
    sourceUrl?: string,
    rawText?: string,
    brandName: string = 'OmniSocial'
  ): Promise<RepurposedCampaign> {
    let articleTitle = 'Featured Insight';
    let bodyText = rawText || '';

    if (sourceUrl && !rawText) {
      const extracted = await this.extractArticleText(sourceUrl);
      articleTitle = extracted.title;
      bodyText = extracted.text;
    }

    if (!bodyText || bodyText.length < 20) {
      throw new Error('Please provide a valid URL or at least 20 characters of article text.');
    }

    const prompt = `You are a world-class omni-channel Social Media Director.
Transform the following article/URL content into an ultra-viral 4-channel multi-platform campaign for brand "${brandName}".

Source Title: "${articleTitle}"
Source Content:
"""
${bodyText.slice(0, 3000)}
"""

Return STRICTLY valid JSON with this exact schema:
{
  "title": "Short punchy campaign title",
  "summary": "2-sentence executive summary of the value proposition",
  "keyTakeaways": [
    "Key takeaway 1",
    "Key takeaway 2",
    "Key takeaway 3"
  ],
  "linkedinCarousel": {
    "title": "Curiosity gap title for LinkedIn carousel",
    "hook": "Slide 1 bold hook",
    "slides": [
      {
        "slideNumber": 1,
        "tagline": "VIRAL HOOK",
        "heading": "Big bold hook headline",
        "body": "Framing the key problem or opportunity",
        "highlight": "Swipe to learn the full framework ->"
      },
      {
        "slideNumber": 2,
        "tagline": "FRAMEWORK #1",
        "heading": "Step 1 actionable rule",
        "bullets": ["Actionable bullet 1", "Actionable bullet 2"],
        "highlight": "Pro Tip: Key nuance"
      },
      {
        "slideNumber": 3,
        "tagline": "FRAMEWORK #2",
        "heading": "Step 2 actionable rule",
        "bullets": ["Actionable bullet 1", "Actionable bullet 2"],
        "highlight": "Pro Tip: Common pitfall to avoid"
      },
      {
        "slideNumber": 4,
        "tagline": "FRAMEWORK #3",
        "heading": "Step 3 actionable rule",
        "bullets": ["Actionable bullet 1", "Actionable bullet 2"],
        "highlight": "Pro Tip: Metric that matters"
      },
      {
        "slideNumber": 5,
        "tagline": "ACTION & RETENTION",
        "heading": "How to execute this today",
        "bullets": ["1. Immediate step", "2. Long term benefit"],
        "highlight": "Save this carousel and follow ${brandName} for daily insights!"
      }
    ]
  },
  "instagramReel": {
    "hookText": "On-screen text hook in first 3 seconds",
    "visualDirection": "Detailed visual description of what appears in the video reel",
    "voiceoverScript": "30-second conversational voiceover script",
    "caption": "Punchy Instagram caption with hook and value",
    "hashtags": ["#ReelsViral", "#Growth", "#Innovation"],
    "suggestedAudioStyle": "Trending fast-paced upbeat lo-fi beat"
  },
  "twitterThread": [
    {
      "tweetNumber": 1,
      "text": "1/4 Hook tweet with massive curiosity gap and bold statement. 🧵👇"
    },
    {
      "tweetNumber": 2,
      "text": "2/4 Core insight breakdown with specific numbers or example."
    },
    {
      "tweetNumber": 3,
      "text": "3/4 The single biggest mistake most creators make when trying this."
    },
    {
      "tweetNumber": 4,
      "text": "4/4 Summary + Call to Action: Retweet to save someone 10 hours, and follow @${brandName.toLowerCase().replace(/[^a-z0-9]/g, '')} for more."
    }
  ],
  "facebookPost": {
    "headline": "Attention-grabbing Facebook headline",
    "body": "3-paragraph community storytelling post explaining the transformation",
    "questionPrompt": "What is your experience with this? Tell us in the comments below!",
    "hashtags": ["#Community", "#Insights"]
  }
}`;

    const response = await OpenRouterService.createChatCompletion(
      [
        {
          role: 'system',
          content: 'You are an elite omni-channel social media repurposing engine. Return only strictly valid JSON matching the schema, with no markdown code blocks.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      {
        model: config.openrouter.contentModel || 'openai/gpt-4o-mini',
        temperature: 0.7,
        responseFormatJson: true
      }
    );

    let parsed: any;
    try {
      const cleaned = response.content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      const start = response.content.indexOf('{');
      const end = response.content.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        parsed = JSON.parse(response.content.substring(start, end + 1));
      } else {
        throw new Error('Failed to parse repurposed campaign JSON from AI response');
      }
    }

    return {
      title: parsed.title || articleTitle,
      sourceUrl,
      summary: parsed.summary || 'AI Repurposed Campaign',
      keyTakeaways: parsed.keyTakeaways || [],
      linkedinCarousel: parsed.linkedinCarousel,
      instagramReel: parsed.instagramReel,
      twitterThread: parsed.twitterThread || [],
      facebookPost: parsed.facebookPost
    };
  }
}


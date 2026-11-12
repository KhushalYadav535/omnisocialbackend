import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { OpenRouterService } from './openrouter.service';
import { config } from '../config';

export interface CarouselSlide {
  slideNumber: number;
  type: 'intro' | 'content' | 'outro';
  tagline: string;
  heading: string;
  bullets?: string[];
  body?: string;
  highlight?: string;
}

export interface GeneratedCarousel {
  title: string;
  subtitle: string;
  theme: 'midnight' | 'royal' | 'minimal' | 'sunset';
  slides: CarouselSlide[];
  pdfUrl?: string;
  pdfPath?: string;
  filename?: string;
}

export class CarouselService {
  /**
   * Generates structured LinkedIn Carousel content using OpenRouter LLM
   */
  static async generateCarouselContent(
    topic: string,
    theme: 'midnight' | 'royal' | 'minimal' | 'sunset' = 'midnight',
    slideCount: number = 5,
    brandName: string = 'OmniSocial'
  ): Promise<GeneratedCarousel> {
    const prompt = `You are a world-class LinkedIn Thought Leadership & Viral Content Specialist.
Create an engaging, viral, high-value ${slideCount}-slide LinkedIn PDF Carousel presentation on the following topic:
"${topic}"

The presentation is published by brand: "${brandName}".

Return STRICTLY valid JSON with this exact schema:
{
  "title": "Short, punchy main title of the presentation (max 8 words)",
  "subtitle": "Clear subtitle explaining the value proposition (max 15 words)",
  "theme": "${theme}",
  "slides": [
    {
      "slideNumber": 1,
      "type": "intro",
      "tagline": "VIRAL HOOK",
      "heading": "Big bold hook headline for slide 1",
      "body": "Brief sentence framing the problem or context.",
      "highlight": "Swipe to learn the 5 key frameworks ->"
    },
    {
      "slideNumber": 2,
      "type": "content",
      "tagline": "RULE #1 / STEP #1",
      "heading": "Specific actionable insight heading",
      "bullets": [
        "First key actionable observation or rule",
        "Second practical step to take",
        "Common mistake to avoid"
      ],
      "highlight": "Pro Tip: Key takeaway"
    },
    ...
    {
      "slideNumber": ${slideCount},
      "type": "outro",
      "tagline": "SUMMARY & ACTION",
      "heading": "How to Put This Into Practice",
      "body": "Brief summary of the transformation.",
      "bullets": [
        "1. Start small with step 1",
        "2. Measure progress weekly",
        "3. Share with your team"
      ],
      "highlight": "Save this carousel for later and follow ${brandName} for daily insights!"
    }
  ]
}

Ensure there are exactly ${slideCount} slides. Make the insights specific, non-generic, and easy to read.`;

    const response = await OpenRouterService.createChatCompletion(
      [
        {
          role: 'system',
          content: 'You generate structured JSON for viral LinkedIn PDF Carousel presentations. Return only valid JSON without markdown wrapping.'
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
        throw new Error('Failed to parse carousel JSON from AI response');
      }
    }

    return {
      title: parsed.title || topic,
      subtitle: parsed.subtitle || `A guide by ${brandName}`,
      theme,
      slides: parsed.slides || []
    };
  }

  /**
   * Renders the Carousel slides into a high-res square PDF document (1080x1080 points)
   * Suitable for LinkedIn Document / Carousel post upload.
   */
  static async renderCarouselPdf(
    carousel: GeneratedCarousel,
    brandName: string = 'OmniSocial',
    host: string = 'localhost:5000',
    protocol: string = 'http'
  ): Promise<{ pdfUrl: string; pdfPath: string; filename: string }> {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const cleanTitle = (carousel.title || 'carousel')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .slice(0, 30);
    const filename = `carousel_${Date.now()}_${cleanTitle}.pdf`;
    const pdfPath = path.join(uploadsDir, filename);

    // Color Theme Definitions (Hex RGB)
    const themes = {
      midnight: {
        bg: '#0F172A',
        card: '#1E293B',
        accent: '#38BDF8',
        tag: '#0EA5E9',
        title: '#F8FAFC',
        text: '#CBD5E1',
        highlightBg: '#0369A1',
        highlightText: '#E0F2FE'
      },
      royal: {
        bg: '#0A66C2',
        card: '#004182',
        accent: '#FFFFFF',
        tag: '#BAE6FD',
        title: '#FFFFFF',
        text: '#F0F9FF',
        highlightBg: '#0284C7',
        highlightText: '#FFFFFF'
      },
      minimal: {
        bg: '#F8FAFC',
        card: '#FFFFFF',
        accent: '#4F46E5',
        tag: '#6366F1',
        title: '#0F172A',
        text: '#334155',
        highlightBg: '#EEF2FF',
        highlightText: '#3730A3'
      },
      sunset: {
        bg: '#180B26',
        card: '#2D124D',
        accent: '#F43F5E',
        tag: '#FB7185',
        title: '#FFF1F2',
        text: '#FECDD3',
        highlightBg: '#881337',
        highlightText: '#FFE4E6'
      }
    };

    const activeTheme = themes[carousel.theme] || themes.midnight;
    const size = 600; // 600x600 pt square slide (scales cleanly on mobile & desktop)

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: [size, size],
        margin: 0,
        autoFirstPage: false
      });

      const writeStream = fs.createWriteStream(pdfPath);
      doc.pipe(writeStream);

      const totalSlides = carousel.slides.length;

      carousel.slides.forEach((slide, index) => {
        doc.addPage({ size: [size, size], margin: 0 });

        // 1. Draw Slide Background
        doc.rect(0, 0, size, size).fill(activeTheme.bg);

        // Top Subtle Accent Stripe
        doc.rect(0, 0, size, 6).fill(activeTheme.accent);

        // 2. Header Bar: Brand Name & Slide Counter
        doc.fillColor(activeTheme.accent)
           .fontSize(11)
           .font('Helvetica-Bold')
           .text(brandName.toUpperCase(), 40, 30);

        const counterText = `${String(index + 1).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`;
        doc.fillColor(activeTheme.text)
           .fontSize(11)
           .font('Helvetica')
           .text(counterText, size - 100, 30, { width: 60, align: 'right' });

        // Divider
        doc.strokeColor(activeTheme.card)
           .lineWidth(1)
           .moveTo(40, 52)
           .lineTo(size - 40, 52)
           .stroke();

        // 3. Slide Content Rendering
        const contentY = 75;

        // Tagline Pill
        if (slide.tagline) {
          doc.fillColor(activeTheme.tag)
             .fontSize(10)
             .font('Helvetica-Bold')
             .text(slide.tagline.toUpperCase(), 40, contentY);
        }

        // Main Slide Heading
        doc.fillColor(activeTheme.title)
           .fontSize(slide.type === 'intro' ? 26 : 21)
           .font('Helvetica-Bold')
           .text(slide.heading, 40, contentY + 22, {
             width: size - 80,
             lineGap: 4
           });

        let nextY = doc.y + 14;

        // Body / Context text
        if (slide.body) {
          doc.fillColor(activeTheme.text)
             .fontSize(13)
             .font('Helvetica')
             .text(slide.body, 40, nextY, {
               width: size - 80,
               lineGap: 4
             });
          nextY = doc.y + 14;
        }

        // Bullet Points
        if (slide.bullets && slide.bullets.length > 0) {
          slide.bullets.forEach((bullet) => {
            doc.fillColor(activeTheme.accent)
               .fontSize(14)
               .font('Helvetica-Bold')
               .text('•', 45, nextY);

            doc.fillColor(activeTheme.text)
               .fontSize(12)
               .font('Helvetica')
               .text(bullet, 65, nextY, {
                 width: size - 110,
                 lineGap: 3
               });

            nextY = doc.y + 8;
          });
          nextY += 8;
        }

        // 4. Highlight Card at Bottom
        if (slide.highlight) {
          const cardY = Math.max(nextY, size - 115);
          const cardHeight = 55;

          // Background card
          doc.roundedRect(40, cardY, size - 80, cardHeight, 10)
             .fill(activeTheme.card);

          // Left accent border on card
          doc.rect(40, cardY, 4, cardHeight)
             .fill(activeTheme.accent);

          doc.fillColor(activeTheme.highlightText)
             .fontSize(11)
             .font('Helvetica-Bold')
             .text(slide.highlight, 55, cardY + 12, {
               width: size - 110,
               align: 'left',
               lineGap: 2
             });
        }

        // 5. Slide Footer
        doc.fillColor(activeTheme.text)
           .fontSize(9)
           .font('Helvetica')
           .text('Swipe Next →', size - 120, size - 32, { width: 80, align: 'right' });
      });

      doc.end();

      writeStream.on('finish', () => {
        const pdfUrl = `${protocol}://${host}/uploads/${filename}`;
        resolve({
          pdfUrl,
          pdfPath,
          filename
        });
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    });
  }
}


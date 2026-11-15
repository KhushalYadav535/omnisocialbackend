import { prisma } from '../db.service';

export interface SkillContract {
  id: string;
  name: string;
  category: 'MARKETING_STRATEGY' | 'CONTENT_STRATEGY' | 'WRITING_AND_COPY' | 'CREATIVE_DEVELOPMENT' | 'PLATFORM_ADAPTATION' | 'REPURPOSING' | 'REVIEW_AND_QUALITY';
  description: string;
  version: string;
  status: 'ACTIVE' | 'TESTING' | 'DEPRECATED' | 'DISABLED';
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  instructions: string;
  contextRequirements: string[];
  allowedTools: string[];
  isSystem: boolean;
}

export const INITIAL_SKILLS: SkillContract[] = [
  {
    id: 'marketing-strategy-generator',
    name: 'Marketing Strategy & Positioning Architect',
    category: 'MARKETING_STRATEGY',
    description: 'Generates or refines structured marketing strategy components including business context, target audience personas, value proposition, positioning, messaging pillars, and channel roadmaps.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', enum: ['ALL', 'OBJECTIVES', 'AUDIENCE', 'POSITIONING', 'MESSAGING', 'CHANNELS', 'ROADMAP'] },
        businessBrief: { type: 'string' },
        currentStrategy: { type: 'object' }
      },
      required: ['businessBrief']
    },
    outputSchema: {
      type: 'object',
      properties: {
        businessContext: { type: 'string' },
        targetAudience: { type: 'array', items: { type: 'object' } },
        valueProposition: { type: 'string' },
        positioning: { type: 'string' },
        messagingPillars: { type: 'array', items: { type: 'string' } },
        marketingObjectives: { type: 'array', items: { type: 'object' } },
        channelStrategy: { type: 'array', items: { type: 'object' } },
        roadmap: { type: 'array', items: { type: 'object' } }
      }
    },
    instructions: `You are the Principal Marketing Strategist. Analyze the business context and generate rigorous, actionable strategy components.
Always separate verified user facts from strategic hypotheses. Focus on differentiated positioning, clear audience pains, and realistic channel cadence.`,
    contextRequirements: ['BRAND_PROFILE', 'VOICE_PROFILE', 'MARKET_CONTEXT'],
    allowedTools: ['DATABASE_LOOKUP'],
    isSystem: true
  },
  {
    id: 'content-pillar-generator',
    name: 'Content Pillars & Themes Architect',
    category: 'CONTENT_STRATEGY',
    description: 'Generates 3 to 5 core content pillars with balanced percentage allocations, rationale, and specific subtopics tailored to the brand.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        brandDescription: { type: 'string' },
        goals: { type: 'string' }
      },
      required: ['brandDescription']
    },
    outputSchema: {
      type: 'object',
      properties: {
        pillars: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              targetPercentage: { type: 'number' },
              color: { type: 'string' },
              themes: { type: 'array', items: { type: 'string' } }
            },
            required: ['name', 'description', 'targetPercentage', 'color', 'themes']
          }
        }
      },
      required: ['pillars']
    },
    instructions: `You are the Content Strategy Lead. Develop 3-5 distinct, complementary content pillars that establish authority, educate, build trust, and drive engagement.
Ensure the total targetPercentage sums exactly to 100%. Assign a modern hex color code to each pillar.`,
    contextRequirements: ['BRAND_PROFILE', 'MARKETING_STRATEGY'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'content-ideas-generator',
    name: 'Topic Discovery & Idea Brainstormer',
    category: 'CONTENT_STRATEGY',
    description: 'Generates high-leverage content ideas and topic hooks aligned with brand pillars, trending themes, and audience pain points.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        pillarName: { type: 'string' },
        focusTheme: { type: 'string' },
        count: { type: 'number', default: 5 }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        ideas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              hookAngle: { type: 'string' },
              recommendedFormat: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'description', 'recommendedFormat']
          }
        }
      },
      required: ['ideas']
    },
    instructions: `You are a Creative Content Ideator. Generate scroll-stopping, fresh content concepts that provoke curiosity or deliver high tactical value. Avoid generic clichés.`,
    contextRequirements: ['BRAND_PROFILE', 'CONTENT_PILLARS'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'campaign-brief-generator',
    name: 'Campaign Concept & Sprint Architect',
    category: 'CREATIVE_DEVELOPMENT',
    description: 'Synthesizes campaign concepts, sprint milestones, messaging architecture, and sequential post deliverables for marketing initiatives.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        campaignObjective: { type: 'string' },
        targetAudience: { type: 'string' },
        durationWeeks: { type: 'number', default: 2 }
      },
      required: ['campaignObjective']
    },
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        concept: { type: 'string' },
        keyMessages: { type: 'array', items: { type: 'string' } },
        phases: { type: 'array', items: { type: 'object' } },
        deliverablesSummary: { type: 'string' }
      },
      required: ['name', 'concept', 'keyMessages']
    },
    instructions: `You are the Campaign Director. Design a cohesive multi-post campaign that moves an audience through Awareness, Consideration, and Action.`,
    contextRequirements: ['BRAND_PROFILE', 'MARKETING_STRATEGY'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'social-post-copywriter',
    name: 'Platform Social Copywriter',
    category: 'WRITING_AND_COPY',
    description: 'Writes engaging, tone-tuned social posts with hooks, structured captions, calls-to-action, and relevant hashtags.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        topicOrIdea: { type: 'string' },
        platform: { type: 'string', enum: ['LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'TWITTER'] },
        tone: { type: 'string' }
      },
      required: ['topicOrIdea']
    },
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        caption: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        firstComment: { type: 'string' },
        cta: { type: 'string' }
      },
      required: ['caption', 'hashtags']
    },
    instructions: `You are an expert Social Media Copywriter. Craft compelling post copy strictly honoring the brand voice. Optimize typography, line breaks, and readability for the target platform.`,
    contextRequirements: ['BRAND_PROFILE', 'VOICE_PROFILE'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'multi-platform-adapter',
    name: 'Master Brief Multi-Platform Adapter',
    category: 'PLATFORM_ADAPTATION',
    description: 'Adapts a master content brief into tailored, native copy and layout for LinkedIn, Instagram, Facebook, and X simultaneously.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        masterBrief: { type: 'string' },
        platforms: { type: 'array', items: { type: 'string' } }
      },
      required: ['masterBrief']
    },
    outputSchema: {
      type: 'object',
      properties: {
        linkedin: { type: 'object' },
        instagram: { type: 'object' },
        facebook: { type: 'object' },
        twitter: { type: 'object' }
      }
    },
    instructions: `Adapt the core message natively to each platform's culture and algorithm:
- LinkedIn: Professional, storytelling, insightful, 1-3 targeted hashtags.
- Instagram: Visual-first caption, strong punchy hook, engaging CTA, 5-8 hashtags.
- Facebook: Community-focused, conversational, open-ended question.
- X/Twitter: Sharp, punchy, under 280 characters, compelling point.`,
    contextRequirements: ['BRAND_PROFILE', 'VOICE_PROFILE'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'carousel-slide-architect',
    name: 'Carousel Deck & Slide Copy Architect',
    category: 'CREATIVE_DEVELOPMENT',
    description: 'Generates complete slide-by-slide copy, visual instructions, and typography layouts for LinkedIn and Instagram carousels.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        slideCount: { type: 'number', default: 5 },
        theme: { type: 'string', default: 'midnight' }
      },
      required: ['topic']
    },
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slideNumber: { type: 'number' },
              type: { type: 'string' },
              tagline: { type: 'string' },
              heading: { type: 'string' },
              body: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      },
      required: ['title', 'slides']
    },
    instructions: `Design a high-converting carousel deck. Slide 1 must have an irresistible hook. Middle slides deliver digestible, single-point value. Final slide delivers a strong CTA.`,
    contextRequirements: ['BRAND_PROFILE', 'VOICE_PROFILE'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'creative-prompt-generator',
    name: 'Visual Creative & Image Prompt Engineer',
    category: 'CREATIVE_DEVELOPMENT',
    description: 'Generates studio-grade image and video generation prompts matching the brand visual guidelines and post concept.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        postCaption: { type: 'string' },
        visualMood: { type: 'string' }
      },
      required: ['postCaption']
    },
    outputSchema: {
      type: 'object',
      properties: {
        primaryPrompt: { type: 'string' },
        negativePrompt: { type: 'string' },
        style: { type: 'string' },
        aspectRatio: { type: 'string' }
      },
      required: ['primaryPrompt']
    },
    instructions: `Generate highly descriptive photorealistic prompts describing subject, composition, lighting, color palette, camera lens, and atmospheric mood.`,
    contextRequirements: ['BRAND_PROFILE'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'brand-voice-quality-reviewer',
    name: 'Brand Voice & Quality Reviewer',
    category: 'REVIEW_AND_QUALITY',
    description: 'Audits drafted copy against brand voice guidelines, platform constraints, clarity, tone consistency, and unsupported claims.',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        draftText: { type: 'string' },
        platform: { type: 'string' }
      },
      required: ['draftText']
    },
    outputSchema: {
      type: 'object',
      properties: {
        overallScore: { type: 'number' },
        passed: { type: 'boolean' },
        voiceAlignment: { type: 'string' },
        strengths: { type: 'array', items: { type: 'string' } },
        improvements: { type: 'array', items: { type: 'string' } },
        suggestedRevision: { type: 'string' }
      },
      required: ['overallScore', 'passed', 'voiceAlignment']
    },
    instructions: `Critique the draft rigorously. Check tone compliance, readability, and platform optimization. If changes are needed, provide an improved revision.`,
    contextRequirements: ['BRAND_PROFILE', 'VOICE_PROFILE'],
    allowedTools: [],
    isSystem: true
  },
  {
    id: 'launchpad-discovery-synthesizer',
    name: 'Brand Launchpad Foundation Synthesizer',
    category: 'MARKETING_STRATEGY',
    description: 'Synthesizes initial brand setup questions and answers into a complete strategic foundation (pillars, positioning, sample calendar).',
    version: '1.0.0',
    status: 'ACTIVE',
    inputSchema: {
      type: 'object',
      properties: {
        industry: { type: 'string' },
        offering: { type: 'string' },
        idealCustomer: { type: 'string' },
        differentiator: { type: 'string' }
      },
      required: ['industry', 'offering']
    },
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        positioningStatement: { type: 'string' },
        corePillars: { type: 'array', items: { type: 'object' } },
        initialCampaignConcept: { type: 'string' },
        launchPostDraft: { type: 'string' }
      },
      required: ['positioningStatement', 'corePillars']
    },
    instructions: `You are the Brand Launch Specialist. Transform the raw onboarding inputs into an executive-ready foundation. Create 3 distinct pillars and a compelling launch post.`,
    contextRequirements: ['BRAND_PROFILE'],
    allowedTools: [],
    isSystem: true
  }
];

export class SkillRegistry {
  private static isInitialized = false;

  /**
   * Initializes or refreshes registered skills in the database.
   */
  static async initializeRegistry(): Promise<void> {
    if (this.isInitialized) return;

    try {
      for (const skill of INITIAL_SKILLS) {
        await prisma.skillDefinition.upsert({
          where: { id: skill.id },
          create: {
            id: skill.id,
            name: skill.name,
            category: skill.category,
            description: skill.description,
            version: skill.version,
            status: skill.status,
            inputSchema: JSON.stringify(skill.inputSchema),
            outputSchema: JSON.stringify(skill.outputSchema),
            instructions: skill.instructions,
            contextRequirements: JSON.stringify(skill.contextRequirements),
            allowedTools: JSON.stringify(skill.allowedTools),
            isSystem: skill.isSystem
          },
          update: {
            name: skill.name,
            category: skill.category,
            description: skill.description,
            instructions: skill.instructions,
            contextRequirements: JSON.stringify(skill.contextRequirements),
            allowedTools: JSON.stringify(skill.allowedTools)
          }
        });
      }
      this.isInitialized = true;
      console.log(`🧠 [SkillRegistry] ${INITIAL_SKILLS.length} system skills registered and verified in database.`);
    } catch (err: any) {
      console.warn('⚠️ [SkillRegistry] Registry sync notice:', err.message);
    }
  }

  /**
   * Retrieves all active skills from registry.
   */
  static async listSkills(): Promise<SkillContract[]> {
    await this.initializeRegistry();
    const records = await prisma.skillDefinition.findMany({
      orderBy: { category: 'asc' }
    });

    return records.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category as any,
      description: r.description,
      version: r.version,
      status: r.status as any,
      inputSchema: JSON.parse(r.inputSchema || '{}'),
      outputSchema: JSON.parse(r.outputSchema || '{}'),
      instructions: r.instructions,
      contextRequirements: JSON.parse(r.contextRequirements || '[]'),
      allowedTools: JSON.parse(r.allowedTools || '[]'),
      isSystem: r.isSystem
    }));
  }

  /**
   * Finds a skill contract by ID.
   */
  static async getSkill(skillId: string): Promise<SkillContract | null> {
    const memorySkill = INITIAL_SKILLS.find(s => s.id === skillId);
    if (memorySkill) return memorySkill;

    const record = await prisma.skillDefinition.findUnique({
      where: { id: skillId }
    });
    if (!record) return null;

    return {
      id: record.id,
      name: record.name,
      category: record.category as any,
      description: record.description,
      version: record.version,
      status: record.status as any,
      inputSchema: JSON.parse(record.inputSchema || '{}'),
      outputSchema: JSON.parse(record.outputSchema || '{}'),
      instructions: record.instructions,
      contextRequirements: JSON.parse(record.contextRequirements || '[]'),
      allowedTools: JSON.parse(record.allowedTools || '[]'),
      isSystem: record.isSystem
    };
  }
}

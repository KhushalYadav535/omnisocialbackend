import { prisma } from '../db.service';
import { SkillRegistry, SkillContract } from './skillRegistry';
import { OpenRouterService } from '../openrouter.service';

export interface ExecutionStepPlan {
  stepNumber: number;
  skillId: string;
  name: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  description: string;
}

export interface OrchestrationPlan {
  intent: string;
  primarySkillId: string;
  steps: ExecutionStepPlan[];
}

export class SkillOrchestrator {
  /**
   * Parses natural language user request and determines the required skill and workflow plan.
   */
  static async planFromIntent(prompt: string): Promise<OrchestrationPlan> {
    const p = prompt.toLowerCase();

    // 1. Marketing Strategy
    if (p.includes('strategy') || p.includes('positioning') || p.includes('audience persona') || p.includes('roadmap')) {
      return {
        intent: 'Develop or refine marketing strategy and positioning',
        primarySkillId: 'marketing-strategy-generator',
        steps: [
          { stepNumber: 1, skillId: 'marketing-strategy-generator', name: 'Strategic Formulation', status: 'PENDING', description: 'Analyze business context and generate strategy components' },
          { stepNumber: 2, skillId: 'brand-voice-quality-reviewer', name: 'Strategic Alignment Audit', status: 'PENDING', description: 'Verify positioning clarity and differentiation' }
        ]
      };
    }

    // 2. Content Pillars
    if (p.includes('pillar') || p.includes('content theme') || p.includes('topic category')) {
      return {
        intent: 'Generate structured content pillars and percentage allocations',
        primarySkillId: 'content-pillar-generator',
        steps: [
          { stepNumber: 1, skillId: 'content-pillar-generator', name: 'Pillar Architecture', status: 'PENDING', description: 'Generate 3-5 balanced content pillars with themes' }
        ]
      };
    }

    // 3. Content Ideas / Topics
    if (p.includes('idea') || p.includes('brainstorm') || p.includes('topic') || p.includes('hook')) {
      return {
        intent: 'Brainstorm high-leverage content ideas and angles',
        primarySkillId: 'content-ideas-generator',
        steps: [
          { stepNumber: 1, skillId: 'content-ideas-generator', name: 'Topic Discovery', status: 'PENDING', description: 'Brainstorm scroll-stopping post ideas' }
        ]
      };
    }

    // 4. Campaign
    if (p.includes('campaign') || p.includes('sprint') || p.includes('launch plan') || p.includes('product launch')) {
      return {
        intent: 'Architect multi-post campaign concept and messaging sprint',
        primarySkillId: 'campaign-brief-generator',
        steps: [
          { stepNumber: 1, skillId: 'campaign-brief-generator', name: 'Campaign Concept Synthesis', status: 'PENDING', description: 'Define core campaign concept and phases' },
          { stepNumber: 2, skillId: 'content-ideas-generator', name: 'Campaign Deliverables Planning', status: 'PENDING', description: 'Outline sequential content posts for campaign' }
        ]
      };
    }

    // 5. Multi-Platform Adaptation
    if (p.includes('adapt') || p.includes('multi-platform') || (p.includes('linkedin') && p.includes('instagram'))) {
      return {
        intent: 'Adapt master content brief into multi-platform native versions',
        primarySkillId: 'multi-platform-adapter',
        steps: [
          { stepNumber: 1, skillId: 'multi-platform-adapter', name: 'Platform Adaptation', status: 'PENDING', description: 'Draft tailored copy for LinkedIn, IG, FB and Twitter' },
          { stepNumber: 2, skillId: 'brand-voice-quality-reviewer', name: 'Quality Review', status: 'PENDING', description: 'Check platform limits and tone compliance' }
        ]
      };
    }

    // 6. Carousel Deck
    if (p.includes('carousel') || p.includes('slide') || p.includes('deck')) {
      return {
        intent: 'Architect carousel slides and visual instructions',
        primarySkillId: 'carousel-slide-architect',
        steps: [
          { stepNumber: 1, skillId: 'carousel-slide-architect', name: 'Carousel Slide Structuring', status: 'PENDING', description: 'Draft slide-by-slide copy and hooks' }
        ]
      };
    }

    // 7. Brand Launchpad
    if (p.includes('launchpad') || p.includes('from zero') || p.includes('new brand setup')) {
      return {
        intent: 'Synthesize brand foundation and initial launch setup',
        primarySkillId: 'launchpad-discovery-synthesizer',
        steps: [
          { stepNumber: 1, skillId: 'launchpad-discovery-synthesizer', name: 'Foundation Synthesis', status: 'PENDING', description: 'Formulate core positioning and initial pillars' }
        ]
      };
    }

    // Default: Social Post Copywriting
    return {
      intent: 'Draft engaging platform-specific social copy',
      primarySkillId: 'social-post-copywriter',
      steps: [
        { stepNumber: 1, skillId: 'social-post-copywriter', name: 'Copy Generation', status: 'PENDING', description: 'Craft post copy, hook, CTA and hashtags' },
        { stepNumber: 2, skillId: 'brand-voice-quality-reviewer', name: 'Brand Voice Audit', status: 'PENDING', description: 'Review tone and verify platform fit' }
      ]
    };
  }

  /**
   * Executes a specific skill with context assembly, LLM execution, schema validation, and database audit logging.
   */
  static async executeSkill(params: {
    skillId: string;
    input: Record<string, any>;
    brandId: string;
    userId: string;
    tenantId: string;
  }): Promise<{
    executionId: string;
    skill: SkillContract;
    output: any;
    executionTimeMs: number;
    steps: ExecutionStepPlan[];
  }> {
    const startTime = Date.now();
    const skill = await SkillRegistry.getSkill(params.skillId);
    if (!skill) {
      throw new Error(`Skill with ID '${params.skillId}' not found in registry.`);
    }

    // 1. Context Assembly from Brand Profile & Guidelines
    let brandContext = '';
    const brand = await prisma.brand.findUnique({
      where: { id: params.brandId },
      include: {
        voiceProfile: true,
        marketingStrategies: {
          where: { status: 'APPROVED' },
          take: 1,
          orderBy: { version: 'desc' }
        },
        contentPillars: true
      }
    });

    if (brand) {
      brandContext += `\n--- BRAND CONTEXT ---`;
      brandContext += `\nBrand Name: ${brand.name}`;
      if (brand.description) brandContext += `\nDescription: ${brand.description}`;
      if (brand.website) brandContext += `\nWebsite: ${brand.website}`;

      if (brand.voiceProfile) {
        brandContext += `\nTone: ${brand.voiceProfile.tone}`;
        if (brand.voiceProfile.writingStyle) brandContext += `\nWriting Style: ${brand.voiceProfile.writingStyle}`;
        if (brand.voiceProfile.targetAudience) brandContext += `\nTarget Audience: ${brand.voiceProfile.targetAudience}`;
        if (brand.voiceProfile.keyTerminology) brandContext += `\nKey Terms: ${brand.voiceProfile.keyTerminology}`;
        if (brand.voiceProfile.bannedKeywords) brandContext += `\nDisallowed Words: ${brand.voiceProfile.bannedKeywords}`;
      }

      if (brand.marketingStrategies.length > 0) {
        const strat = brand.marketingStrategies[0];
        brandContext += `\nApproved Positioning: ${strat.positioning}`;
        brandContext += `\nValue Proposition: ${strat.valueProposition}`;
      }

      if (brand.contentPillars.length > 0) {
        brandContext += `\nContent Pillars: ${brand.contentPillars.map(p => `${p.name} (${p.targetPercentage}%)`).join(', ')}`;
      }
    }

    // 2. Assemble System Prompt & Schema Instructions
    const systemPrompt = `${skill.instructions}

${brandContext}

CRITICAL: Return strictly valid JSON that matches the following output schema:
${JSON.stringify(skill.outputSchema, null, 2)}

Do NOT include any markdown code fencing, backticks, or explanatory chat outside the valid JSON object.`;

    const userPrompt = `TASK INPUT:
${JSON.stringify(params.input, null, 2)}

Generate the structured deliverable for this skill now.`;

    // 3. Execute via LLM
    const steps: ExecutionStepPlan[] = [
      { stepNumber: 1, skillId: skill.id, name: skill.name, status: 'RUNNING', description: 'Synthesizing deliverable with schema validation' }
    ];

    let rawResponse = '';
    let parsedOutput: any = null;

    try {
      const completion = await OpenRouterService.createChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], {
        temperature: 0.7,
        maxTokens: 2500,
        responseFormatJson: true,
        tenantId: params.tenantId,
        brandId: params.brandId,
        userId: params.userId,
        taskType: 'CONTENT_STUDIO'
      });

      rawResponse = completion.content || '';

      // Parse JSON safely
      const cleanJson = rawResponse
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      parsedOutput = JSON.parse(cleanJson);
      steps[0].status = 'COMPLETED';
    } catch (err: any) {
      steps[0].status = 'FAILED';
      console.warn(`Skill execution parsing note for ${skill.id}:`, err.message);
      // Fallback structured packaging if response wasn't strict JSON
      parsedOutput = {
        rawOutput: rawResponse,
        note: 'Completed with natural narrative output'
      };
    }

    const executionTimeMs = Date.now() - startTime;

    // 4. Persist deliverables directly into Workspace Domain tables if applicable
    if (parsedOutput && typeof parsedOutput === 'object') {
      // 4A. Strategy Deliverable -> MarketingStrategy table
      if (skill.id === 'brand_strategy' || skill.id.includes('strategy')) {
        try {
          const existingStrat = await prisma.marketingStrategy.findFirst({
            where: { brandId: params.brandId },
            orderBy: { version: 'desc' }
          });

          const stratData = {
            brandId: params.brandId,
            version: (existingStrat?.version || 0) + 1,
            status: 'DRAFT',
            positioning: parsedOutput?.positioning || parsedOutput?.positioningStatement || existingStrat?.positioning || 'Strategic Market Positioning',
            valueProposition: parsedOutput?.valueProposition || existingStrat?.valueProposition || 'High-Impact Value Proposition',
            targetPersonas: JSON.stringify(parsedOutput?.personas || parsedOutput?.targetPersonas || []),
            coreMessaging: JSON.stringify(parsedOutput?.coreMessaging || parsedOutput?.keyMessages || []),
            businessContext: JSON.stringify(parsedOutput?.businessContext || {
              businessName: brand?.name || 'Sentient Digital',
              description: brand?.description || ''
            }),
            marketingObjectives: JSON.stringify(parsedOutput?.objectives || parsedOutput?.marketingObjectives || []),
            channelStrategy: JSON.stringify(parsedOutput?.channelStrategy || []),
            channelRoadmap: JSON.stringify(parsedOutput?.roadmap || parsedOutput?.channelRoadmap || [])
          };

          if (existingStrat) {
            await prisma.marketingStrategy.update({
              where: { id: existingStrat.id },
              data: stratData
            });
          } else {
            await prisma.marketingStrategy.create({
              data: stratData
            });
          }
        } catch (stratErr: any) {
          console.warn('[SkillOrchestrator] Strategy persistence note:', stratErr.message);
        }
      }

      // 4B. Pillar Deliverable -> ContentPillar table (Safe upsert with deduplication)
      if ((skill.id === 'content_pillars' || skill.id.includes('pillar')) && Array.isArray(parsedOutput?.pillars)) {
        try {
          for (const p of parsedOutput.pillars) {
            if (p.name) {
              const trimmedName = p.name.trim();
              const existingPillar = await prisma.contentPillar.findFirst({
                where: {
                  brandId: params.brandId,
                  name: { equals: trimmedName, mode: 'insensitive' }
                }
              });

              if (existingPillar) {
                await prisma.contentPillar.update({
                  where: { id: existingPillar.id },
                  data: {
                    description: p.description || existingPillar.description,
                    targetPercentage: p.targetPercentage || p.percentage || existingPillar.targetPercentage
                  }
                });
              } else {
                await prisma.contentPillar.create({
                  data: {
                    brandId: params.brandId,
                    name: trimmedName,
                    description: p.description || '',
                    targetPercentage: p.targetPercentage || p.percentage || 25,
                    subThemes: JSON.stringify(p.subThemes || [])
                  }
                });
              }
            }
          }
        } catch (pillarErr: any) {
          console.warn('[SkillOrchestrator] Pillar persistence note:', pillarErr.message);
        }
      }

      // 4C. Ideas Deliverable -> ContentIdea table (Safe upsert with deduplication)
      if ((skill.id === 'ideas_intake' || skill.id.includes('idea')) && Array.isArray(parsedOutput?.ideas)) {
        try {
          for (const idea of parsedOutput.ideas) {
            if (idea.title) {
              const trimmedTitle = idea.title.trim();
              const existingIdea = await prisma.contentIdea.findFirst({
                where: {
                  brandId: params.brandId,
                  title: { equals: trimmedTitle, mode: 'insensitive' }
                }
              });

              if (!existingIdea) {
                await prisma.contentIdea.create({
                  data: {
                    brandId: params.brandId,
                    title: trimmedTitle,
                    description: idea.concept || idea.description || idea.hook || '',
                    source: 'AI_ORCHESTRATOR',
                    status: 'NEW',
                    tags: JSON.stringify(idea.tags || [idea.format || 'POST'])
                  }
                });
              }
            }
          }
        } catch (ideaErr: any) {
          console.warn('[SkillOrchestrator] Idea persistence note:', ideaErr.message);
        }
      }
    }

    // 5. Record SkillExecution in Database
    const executionRecord = await prisma.skillExecution.create({
      data: {
        tenantId: params.tenantId,
        brandId: params.brandId,
        skillId: skill.id,
        userId: params.userId,
        input: JSON.stringify(params.input),
        output: JSON.stringify(parsedOutput),
        status: steps[0].status === 'FAILED' ? 'FAILED' : 'COMPLETED',
        plan: JSON.stringify(steps),
        steps: JSON.stringify(steps),
        executionTimeMs
      }
    });

    return {
      executionId: executionRecord.id,
      skill,
      output: parsedOutput,
      executionTimeMs,
      steps
    };
  }
}

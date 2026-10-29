import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Prisma database seeding...');

  const passwordHash = await bcrypt.hash('Password123!', 10);

  // 1. Super Admin
  const superAdmin = await prisma.superAdmin.upsert({
    where: { email: 'superadmin@socialcore.io' },
    update: {},
    create: {
      id: 'super-admin-01',
      email: 'superadmin@socialcore.io',
      passwordHash,
      name: 'Super Platform Admin',
      role: 'SUPER_ADMIN'
    }
  });
  console.log(`✅ Seeded SuperAdmin: ${superAdmin.email}`);

  // 2. Subscription Plans
  const plansData = [
    {
      id: 'plan-free',
      name: 'Free Trial',
      code: 'FREE_TRIAL',
      description: 'Ideal for solo creators evaluating the platform',
      priceMonthly: 0,
      priceYearly: 0,
      maxBrands: 2,
      maxAccounts: 3,
      maxUsers: 1,
      aiTokensIncluded: 10000,
      features: JSON.stringify(['Meta 1-Click Connect', 'Unified Inbox', 'Basic AI Suggestions', 'Community Support']),
      isActive: true
    },
    {
      id: 'plan-starter',
      name: 'Starter Creator',
      code: 'STARTER',
      description: 'Perfect for growing brands and boutique creators',
      priceMonthly: 29,
      priceYearly: 290,
      maxBrands: 5,
      maxAccounts: 10,
      maxUsers: 3,
      aiTokensIncluded: 50000,
      features: JSON.stringify(['All Free Features', 'Multi-Brand Voice Profiles', 'Content Calendar', 'Sentiment Analysis', 'Standard Scheduling']),
      isActive: true
    },
    {
      id: 'plan-agency-pro',
      name: 'Agency Pro',
      code: 'AGENCY_PRO',
      description: 'Full multi-tenant power for marketing agencies and multi-brand operators',
      priceMonthly: 99,
      priceYearly: 990,
      maxBrands: 25,
      maxAccounts: 50,
      maxUsers: 15,
      aiTokensIncluded: 250000,
      features: JSON.stringify(['Custom Tenant BYOK Keys', 'Automated Human Approval Workflows', 'Smart Priority Queue', 'Bulk Publishing', 'Advanced Analytics', 'Priority Webhooks']),
      isActive: true
    },
    {
      id: 'plan-enterprise',
      name: 'Enterprise Scale',
      code: 'ENTERPRISE',
      description: 'Dedicated infrastructure with white-glove onboarding and unlimited scale',
      priceMonthly: 249,
      priceYearly: 2490,
      maxBrands: 100,
      maxAccounts: 200,
      maxUsers: 50,
      aiTokensIncluded: 1000000,
      features: JSON.stringify(['Custom White-Label Domain', 'Unlimited Brand Workspaces', 'Custom Model Integration', 'Dedicated Slack Channel', 'Custom SLA']),
      isActive: true
    }
  ];

  for (const plan of plansData) {
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan
    });
  }
  console.log(`✅ Seeded ${plansData.length} Subscription Plans`);

  // 3. Tenants
  const tenantApex = await prisma.tenant.upsert({
    where: { slug: 'apex-digital' },
    update: {},
    create: {
      id: 'tenant-apex',
      name: 'Apex Digital Media Agency',
      slug: 'apex-digital',
      domain: 'apexdigital.com',
      status: 'ACTIVE',
      subscriptionPlanId: 'plan-agency-pro',
      customMetaAppId: 'meta_app_apex_4492',
      customMetaAppSecret: 'sec_apex_9381749',
      customAiApiKey: 'ai_key_apex_live_2026',
      customAiProvider: 'GEMINI'
    }
  });

  const tenantPulse = await prisma.tenant.upsert({
    where: { slug: 'pulse-network' },
    update: {},
    create: {
      id: 'tenant-pulse',
      name: 'Pulse Creators Network',
      slug: 'pulse-network',
      domain: 'pulsenetwork.io',
      status: 'ACTIVE',
      subscriptionPlanId: 'plan-starter',
      customAiProvider: 'GEMINI'
    }
  });
  console.log('✅ Seeded Tenants: Apex & Pulse');

  // 4. Users
  const usersData = [
    {
      id: 'user-super-admin',
      email: 'superadmin@socialcore.io',
      passwordHash,
      name: 'Platform Super Admin',
      role: 'SUPER_ADMIN',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
      isActive: true,
      tenantId: null
    },
    {
      id: 'user-apex-admin',
      email: 'admin@apexdigital.com',
      passwordHash,
      name: 'Rajesh Sharma',
      role: 'TENANT_ADMIN',
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=120&fit=crop',
      isActive: true,
      tenantId: tenantApex.id
    },
    {
      id: 'user-apex-member',
      email: 'sarah@apexdigital.com',
      passwordHash,
      name: 'Sarah Jenkins',
      role: 'TEAM_MEMBER',
      avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&h=120&fit=crop',
      isActive: true,
      tenantId: tenantApex.id
    },
    {
      id: 'user-pulse-admin',
      email: 'creator@pulsenetwork.com',
      passwordHash,
      name: 'Alex Rivera',
      role: 'TENANT_ADMIN',
      avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&h=120&fit=crop',
      isActive: true,
      tenantId: tenantPulse.id
    }
  ];

  for (const user of usersData) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: user,
      create: user
    });
  }
  console.log(`✅ Seeded ${usersData.length} Users`);

  // 5. Businesses (for Tenant Apex)
  const bizAura = await prisma.business.upsert({
    where: { id: 'biz-aura-corp' },
    update: {},
    create: {
      id: 'biz-aura-corp',
      tenantId: tenantApex.id,
      name: 'Aura Lifestyle Group',
      legalName: 'Aura Lifestyle Retail Private Limited',
      industry: 'Fashion, Apparel & Lifestyle',
      website: 'https://auralifestyle.example.com',
      status: 'ACTIVE'
    }
  });

  const bizZenith = await prisma.business.upsert({
    where: { id: 'biz-zenith-cloud' },
    update: {},
    create: {
      id: 'biz-zenith-cloud',
      tenantId: tenantApex.id,
      name: 'Zenith Cloud Technologies',
      legalName: 'Zenith SaaS Solutions Inc.',
      industry: 'Enterprise Software & Cloud',
      website: 'https://zenithcloud.example.com',
      status: 'ACTIVE'
    }
  });
  console.log('✅ Seeded Businesses: Aura Lifestyle & Zenith Cloud');

  // 6. Brands
  const brandAura = await prisma.brand.upsert({
    where: { id: 'brand-aura' },
    update: {},
    create: {
      id: 'brand-aura',
      businessId: bizAura.id,
      name: 'Aura Wear',
      slug: 'aura-wear',
      logoUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=120&h=120&fit=crop',
      description: 'Sustainable, premium everyday wear and summer resort styles for young urban professionals.',
      website: 'https://aurawear.example.com',
      status: 'ACTIVE'
    }
  });

  const brandZenith = await prisma.brand.upsert({
    where: { id: 'brand-zenith' },
    update: {},
    create: {
      id: 'brand-zenith',
      businessId: bizZenith.id,
      name: 'Zenith Orchestrator',
      slug: 'zenith-orchestrator',
      logoUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=120&h=120&fit=crop',
      description: 'Next-generation AI cloud infrastructure monitoring and autoscaling platform.',
      website: 'https://zenithcloud.example.com/orchestrator',
      status: 'ACTIVE'
    }
  });
  console.log('✅ Seeded Brands: Aura Wear & Zenith Orchestrator');

  // 7. Brand Voice Profiles
  await prisma.brandVoiceProfile.upsert({
    where: { brandId: brandAura.id },
    update: {},
    create: {
      id: 'voice-aura',
      brandId: brandAura.id,
      tone: 'Trendy, energetic, warm, and highly engaging. Friendly, polite, and aspirational.',
      writingStyle: 'Conversational with tasteful emojis (✨, 🌿, 👗, 💛). Keep sentences punchy.',
      targetAudience: 'Fashion-conscious shoppers aged 22-38, focused on sustainable comfort and modern aesthetics.',
      keyTerminology: '100% Organic Cotton, Breathable Weave, Resort Collection, Eco-luxe, Conscious Fashion',
      bannedKeywords: 'cheap, bargain, substandard, fake, replica, guarantee 100% refund without return',
      standardFaqs: `Q: What is the return policy?\nA: We offer a hassle-free 7-day exchange or refund on unwashed items with tags attached.\nQ: Where do you ship?\nA: We ship pan-India with express 2-4 day delivery, and internationally to over 30 countries.\nQ: How do I choose my size?\nA: Our sizing is true to international fit. Refer to our interactive size guide on our website.`,
      responseGuidelines: 'Always thank the customer warmly. Mention product benefits naturally. In customer support questions, provide immediate clarity and invite them to DM their order number.',
      exampleReplies: JSON.stringify([
        {
          scenario: 'Customer asking if an out-of-stock dress will return',
          goodReply: 'Hey lovely! ✨ Yes, our Linen Breeze Maxi is getting restocked this Friday at 12 PM IST. Keep an eye on our stories for early VIP access! 💛',
          badReply: 'It is out of stock right now. Check back later.'
        }
      ])
    }
  });

  await prisma.brandVoiceProfile.upsert({
    where: { brandId: brandZenith.id },
    update: {},
    create: {
      id: 'voice-zenith',
      brandId: brandZenith.id,
      tone: 'Authoritative, precise, helpful, and technically astute with polite warmth.',
      writingStyle: 'Direct, clear, informative without marketing jargon.',
      targetAudience: 'DevOps engineers, CTOs, backend architects, and engineering managers.',
      keyTerminology: 'Zero-downtime, Kubernetes-native, Autoscaling, Low-latency, Observability, Telemetry',
      bannedKeywords: 'magic solution, fix everything instantly, impossible, hacks',
      standardFaqs: `Q: Does Zenith integrate with AWS and GCP?\nA: Yes, Zenith natively supports AWS (EKS, ECS, Lambda), GCP (GKE, Cloud Run), and Azure.\nQ: How does pricing work?\nA: We charge based on managed active nodes per hour with transparent zero-overage caps.`,
      responseGuidelines: 'Provide clear technical answers with relevant documentation links. Escalate enterprise SLA inquiries to direct email.',
      exampleReplies: JSON.stringify([
        {
          scenario: 'Technical question on Prometheus metrics export',
          goodReply: 'Hi! Yes, Zenith exposes standard OpenTelemetry and Prometheus endpoints on port 9090 by default. You can scrape directly via our Helm chart config.',
          badReply: 'Yes it works.'
        }
      ])
    }
  });
  console.log('✅ Seeded Brand Voice Profiles');

  // 8. Social Accounts
  const accountAuraFb = await prisma.socialAccount.upsert({
    where: { id: 'account-aura-fb' },
    update: {},
    create: {
      id: 'account-aura-fb',
      brandId: brandAura.id,
      platform: 'FACEBOOK',
      platformAccountId: '10984920485910',
      accountName: 'Aura Lifestyle Official',
      username: 'auralifestyle.official',
      profilePicUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=120&h=120&fit=crop',
      pageCategory: 'Clothing (Brand)',
      accessToken: 'EAAB_verified_meta_page_token_aura_fb_preview',
      tokenExpiresAt: new Date(Date.now() + 90 * 86400000),
      tokenStatus: 'VALID',
      isConnected: true,
      lastSyncedAt: new Date(Date.now() - 5 * 60000),
      capabilities: JSON.stringify(['COMMENTS', 'DIRECT_MESSAGES', 'PUBLISHING', 'INSIGHTS']),
      metadata: JSON.stringify({ followersCount: 48920, pageVerified: true, likesCount: 42100 })
    }
  });

  const accountAuraIg = await prisma.socialAccount.upsert({
    where: { id: 'account-aura-ig' },
    update: {},
    create: {
      id: 'account-aura-ig',
      brandId: brandAura.id,
      platform: 'INSTAGRAM',
      platformAccountId: '1784140089201948',
      accountName: 'Aura Lifestyle',
      username: 'aura_lifestyle',
      profilePicUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop',
      pageCategory: 'Apparel & Clothing',
      accessToken: 'EAAB_verified_meta_ig_token_aura_preview',
      tokenExpiresAt: new Date(Date.now() + 90 * 86400000),
      tokenStatus: 'VALID',
      isConnected: true,
      lastSyncedAt: new Date(Date.now() - 4 * 60000),
      capabilities: JSON.stringify(['COMMENTS', 'DIRECT_MESSAGES', 'PUBLISHING', 'REELS', 'STORIES']),
      metadata: JSON.stringify({ followersCount: 124800, mediaCount: 384, verified: true })
    }
  });
  console.log('✅ Seeded Social Accounts: Aura Facebook & Instagram');

  // 9. Content (Studio Posts)
  const content01 = await prisma.content.upsert({
    where: { id: 'content-01' },
    update: {},
    create: {
      id: 'content-01',
      brandId: brandAura.id,
      title: 'Spring Summer 2026 Collection Announcement',
      rawIdea: 'Announce the new pastel breathable linen collection with vibrant resort visuals and early access code.',
      caption: 'Breathe easy in effortless style. 🌿 Our Spring/Summer 2026 resort collection is officially live! Handcrafted from 100% sustainable European flax linen, designed for sunny escapes and everyday moments of calm.\n\nUse code RESORT15 for 15% off your first seasonal order. Link in bio to explore the drop! ✨',
      hashtags: JSON.stringify(['#AuraLifestyle', '#LinenWear', '#SummerResort2026', '#SustainableFashion', '#EffortlessStyle']),
      mediaUrls: JSON.stringify(['https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=1080&h=1080&fit=crop']),
      targetPlatforms: JSON.stringify(['FACEBOOK', 'INSTAGRAM']),
      format: 'POST',
      status: 'SCHEDULED',
      createdByUserId: 'user-apex-member'
    }
  });

  const content02 = await prisma.content.upsert({
    where: { id: 'content-02' },
    update: {},
    create: {
      id: 'content-02',
      brandId: brandAura.id,
      title: 'Styling Reel: 3 Ways to Style an Oversized White Linen Shirt',
      rawIdea: 'Casual weekend vs Beach cover-up vs Smart brunch styling transition reel.',
      caption: 'One shirt, three weekend moods. ☀️ Which look is your vibe? 1, 2, or 3? Tell us below! 👇 Available now in sizes XS to XXL.',
      hashtags: JSON.stringify(['#StylingHacks', '#OversizedShirt', '#Lookbook2026', '#StyleInspo', '#OOTD']),
      mediaUrls: JSON.stringify(['https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=1080&h=1920&fit=crop']),
      targetPlatforms: JSON.stringify(['INSTAGRAM']),
      format: 'REEL',
      status: 'PUBLISHED',
      createdByUserId: 'user-apex-member'
    }
  });
  console.log('✅ Seeded Contents: Posts 01 & 02');

  // 10. Publications (Scheduled)
  const tomorrow = new Date(Date.now() + 24 * 3600000);
  tomorrow.setHours(11, 0, 0, 0);

  await prisma.publication.upsert({
    where: { idempotencyKey: 'idem_pub_aura_fb_001' },
    update: {},
    create: {
      id: 'pub-01',
      contentId: content01.id,
      socialAccountId: accountAuraFb.id,
      scheduledFor: tomorrow,
      status: 'QUEUED',
      idempotencyKey: 'idem_pub_aura_fb_001'
    }
  });

  await prisma.publication.upsert({
    where: { idempotencyKey: 'idem_pub_aura_ig_002' },
    update: {},
    create: {
      id: 'pub-02',
      contentId: content01.id,
      socialAccountId: accountAuraIg.id,
      scheduledFor: tomorrow,
      status: 'QUEUED',
      idempotencyKey: 'idem_pub_aura_ig_002'
    }
  });

  await prisma.publication.upsert({
    where: { idempotencyKey: 'idem_pub_aura_ig_003' },
    update: {},
    create: {
      id: 'pub-03',
      contentId: content02.id,
      socialAccountId: accountAuraIg.id,
      scheduledFor: new Date(Date.now() - 20 * 3600000),
      publishedAt: new Date(Date.now() - 20 * 3600000),
      status: 'PUBLISHED',
      platformPostId: 'ig_media_pub_89210482',
      platformPostUrl: 'https://instagram.com/p/C4829104829',
      idempotencyKey: 'idem_pub_aura_ig_003'
    }
  });
  console.log('✅ Seeded Publications');

  // 11. Interactions, Classifications & Replies
  const int01 = await prisma.interaction.upsert({
    where: { platformInteractionId: 'ig_comment_982491823901' },
    update: {},
    create: {
      id: 'int-01',
      brandId: brandAura.id,
      socialAccountId: accountAuraIg.id,
      platform: 'INSTAGRAM',
      type: 'COMMENT',
      platformInteractionId: 'ig_comment_982491823901',
      parentPlatformId: 'ig_media_summer_drop_post_01',
      authorId: 'user_priya_k',
      authorName: 'Priya Kulkarni',
      authorUsername: 'priya_k',
      authorAvatarUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=120&h=120&fit=crop',
      contentText: 'Hey! Are the cotton summer dresses restocked yet? Need them for my Goa trip next week! ❤️✨',
      mediaUrls: JSON.stringify(['https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600&h=600&fit=crop']),
      permalinkUrl: 'https://instagram.com/p/C4829104829',
      platformCreatedAt: new Date(Date.now() - 25 * 60000),
      isRead: false,
      replyStatus: 'DRAFT_READY',
      priority: 'HIGH',
      assignedUserId: 'user-apex-member'
    }
  });

  await prisma.classification.upsert({
    where: { interactionId: int01.id },
    update: {},
    create: {
      id: 'class-01',
      interactionId: int01.id,
      sentiment: 'POSITIVE',
      sentimentScore: 0.94,
      isQuestion: true,
      isPricingInquiry: false,
      isLeadIntent: true,
      isSensitiveOrComplaint: false,
      urgencyScore: 4,
      rawAnalysis: JSON.stringify({ reason: 'Excited buyer preparing for upcoming vacation trip; ready to buy instantly.' })
    }
  });

  await prisma.reply.upsert({
    where: { id: 'reply-01' },
    update: {},
    create: {
      id: 'reply-01',
      interactionId: int01.id,
      generatedByAi: true,
      aiPrompt: 'Context: Aura Wear brand voice. Tone: Trendy, energetic, warm. Interaction: Priya Kulkarni asking about cotton summer dress restock for Goa trip.',
      aiSuggestion: 'Hey Priya! ✨ So exciting, Goa trips are the best! 🌴 Our Pure Cotton Summer Breeze collection is being restocked this Friday at 12 noon! Drop us a quick DM and we will send you early-bird notification! 💛',
      finalContent: 'Hey Priya! ✨ So exciting, Goa trips are the best! 🌴 Our Pure Cotton Summer Breeze collection is being restocked this Friday at 12 noon! Drop us a quick DM and we will send you early-bird notification! 💛',
      status: 'DRAFT'
    }
  });

  const int02 = await prisma.interaction.upsert({
    where: { platformInteractionId: 'fb_dm_conversation_89210982' },
    update: {},
    create: {
      id: 'int-02',
      brandId: brandAura.id,
      socialAccountId: accountAuraFb.id,
      platform: 'FACEBOOK',
      type: 'DIRECT_MESSAGE',
      platformInteractionId: 'fb_dm_conversation_89210982',
      authorId: 'user_vikram_m',
      authorName: 'Vikram Mehta',
      authorUsername: 'vikram.mehta.92',
      authorAvatarUrl: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&h=120&fit=crop',
      contentText: 'Hello team, I received order #8921 yesterday. The fabric is amazing, but size M is slightly loose on the shoulders. How can I exchange it for size S without delay?',
      permalinkUrl: null,
      platformCreatedAt: new Date(Date.now() - 55 * 60000),
      isRead: true,
      replyStatus: 'DRAFT_READY',
      priority: 'HIGH',
      assignedUserId: 'user-apex-member'
    }
  });

  await prisma.classification.upsert({
    where: { interactionId: int02.id },
    update: {},
    create: {
      id: 'class-02',
      interactionId: int02.id,
      sentiment: 'NEUTRAL',
      sentimentScore: 0.65,
      isQuestion: true,
      isPricingInquiry: false,
      isLeadIntent: false,
      isSensitiveOrComplaint: false,
      urgencyScore: 4,
      rawAnalysis: JSON.stringify({ reason: 'Customer requesting size exchange for existing order #8921. Needs swift reassurance.' })
    }
  });

  await prisma.reply.upsert({
    where: { id: 'reply-02' },
    update: {},
    create: {
      id: 'reply-02',
      interactionId: int02.id,
      generatedByAi: true,
      aiPrompt: 'Context: Aura Wear brand voice. Tone: Warm, helpful. Interaction: Size M to S exchange for order #8921.',
      aiSuggestion: 'Hello Vikram! 💛 So glad you loved the fabric! We will gladly arrange an exchange for size S right away. Our courier partner will pick up the current size and deliver the new one simultaneously. I have initiated the exchange request for Order #8921 for you!',
      finalContent: 'Hello Vikram! 💛 So glad you loved the fabric! We will gladly arrange an exchange for size S right away. Our courier partner will pick up the current size and deliver the new one simultaneously. I have initiated the exchange request for Order #8921 for you!',
      status: 'DRAFT'
    }
  });
  console.log('✅ Seeded Interactions, Classifications & AI Replies');

  // 12. Audit Events
  await prisma.auditEvent.upsert({
    where: { id: 'audit-01' },
    update: {},
    create: {
      id: 'audit-01',
      tenantId: tenantApex.id,
      userId: 'user-apex-member',
      action: 'AI_REPLY_APPROVED',
      entityType: 'Reply',
      entityId: 'reply-01',
      details: JSON.stringify({ interactionId: 'int-01', recipient: 'Priya Kulkarni' }),
      ipAddress: '192.168.1.45'
    }
  });

  await prisma.auditEvent.upsert({
    where: { id: 'audit-02' },
    update: {},
    create: {
      id: 'audit-02',
      tenantId: tenantApex.id,
      userId: 'user-apex-member',
      action: 'POST_SCHEDULED',
      entityType: 'Content',
      entityId: content01.id,
      details: JSON.stringify({ title: 'Spring Summer 2026 Collection Announcement', scheduledFor: tomorrow.toISOString() }),
      ipAddress: '192.168.1.45'
    }
  });
  console.log('✅ Seeded Audit Events');

  console.log('🎉 Seeding successfully completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


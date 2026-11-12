import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from './src/services/db.service';
import { config } from './src/config';

async function main() {
  console.log('--- Testing Instant 1-Click Post & External AI Tool Prompts ---');
  
  // 1. Get first active user
  const user = await prisma.user.findFirst({
    include: { tenant: true }
  });
  
  if (!user) {
    console.error('No user found');
    process.exit(1);
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId || null
    },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

  console.log(`User: ${user.email}, Tenant: ${user.tenantId}`);

  // 2. Call POST /api/ai/instant-post (Reel format)
  console.log('Testing 1-Click Reel Generation...');
  const resReel = await axios.post(
    'http://localhost:5000/api/ai/instant-post',
    {
      productOrTopic: 'Handmade organic turmeric sandalwood acne soap',
      postType: 'REEL',
      preset: 'PROBLEM_SOLUTION',
      targetPlatform: 'INSTAGRAM'
    },
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  console.log('Reel Generation Status:', resReel.status);
  const post = resReel.data.post;
  console.log('Title:', post.title);
  console.log('Hook:', post.hook);
  console.log('Format:', post.format);
  console.log('Media URL:', post.mediaUrl);
  console.log('Midjourney Prompt:', post.midjourneyPrompt);
  console.log('Runway/Kling Video Prompt:', post.videoPrompt);
  console.log('CapCut Teleprompter Script:', post.voiceoverScript);
  console.log('Canva Design Brief:', post.canvaDesignBrief);

  // 3. Test Deploying this single instant post into Content Calendar
  console.log('\nTesting 1-Click Deploy to Calendar for Instant Post...');
  const resDeploy = await axios.post(
    'http://localhost:5000/api/ai/deploy-campaign',
    {
      campaignName: `Quick Launch: ${post.title}`,
      posts: [post]
    },
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  console.log('Deploy Status:', resDeploy.status);
  console.log('Scheduled Count:', resDeploy.data.result.scheduledCount);
  console.log('Deployment Result:', resDeploy.data.result);

  console.log('\n✅ ALL INTEGRATION TESTS PASSED 100%!');
  process.exit(0);
}

main().catch(err => {
  console.error('Test Failed:', err.response?.data || err.message);
  process.exit(1);
});


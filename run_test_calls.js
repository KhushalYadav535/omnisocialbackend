const { CryptoService } = require('./dist/services/crypto.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const acc = await prisma.socialAccount.findFirst();
  const token = CryptoService.decrypt(acc.accessToken);
  const igUserId = '17841451672167206';

  console.log('Token snippet:', token.substring(0, 20));

  console.log('\n=============================================');
  console.log('1. TESTING instagram_manage_contents (GET media)');
  console.log('=============================================');
  let res = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media?fields=id,caption,media_type,timestamp&access_token=${token}`);
  const mediaData = await res.json();
  console.log('Media response:', mediaData);
  const mediaId = mediaData.data?.[0]?.id;

  console.log('\n=============================================');
  console.log('2. TESTING instagram_manage_engagement (GET engagement & comments)');
  console.log('=============================================');
  if (mediaId) {
    res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}?fields=id,comments_count,like_count,comments{id,text,from,timestamp}&access_token=${token}`);
    console.log('Engagement response:', await res.json());
  }

  console.log('\n=============================================');
  console.log('3. TESTING instagram_business_manage_comments (POST comment)');
  console.log('=============================================');
  if (mediaId) {
    res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Live verification test comment for Meta App Review', access_token: token })
    });
    console.log('Comment response:', await res.json());
  }

  console.log('\n=============================================');
  console.log('4. TESTING instagram_business_content_publish (POST container + publish)');
  console.log('=============================================');
  const createRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&h=1080&fit=crop',
      caption: 'API Test Verification for Meta App Review',
      access_token: token
    })
  });
  const container = await createRes.json();
  console.log('Container response:', container);

  if (container.id) {
    const pubRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: token })
    });
    console.log('Publish response:', await pubRes.json());
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());


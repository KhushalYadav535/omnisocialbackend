const { CryptoService } = require('./dist/services/crypto.service');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const acc = await prisma.socialAccount.findFirst();
  const token = CryptoService.decrypt(acc.accessToken);
  const igUserId = '17841451672167206';

  console.log('Testing exact endpoints for Meta Review...');

  // 1. Get media list
  const mediaRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media?limit=5&access_token=${token}`);
  const mediaList = await mediaRes.json();
  const mediaId = mediaList.data?.[0]?.id;
  console.log('Using Media ID:', mediaId);

  // 2. Test instagram_manage_engagement: POST /{ig_user_id}/likes
  console.log('\n--- Calling POST /{ig_user_id}/likes (instagram_manage_engagement) ---');
  const likeRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/likes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId, access_token: token })
  });
  console.log('Like result:', await likeRes.json());

  // 3. Test instagram_manage_contents: DELETE /{ig_media_id} (or create a draft/test post and delete it!)
  console.log('\n--- Creating a temporary post to test DELETE (instagram_manage_contents) ---');
  const createRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&h=1080&fit=crop',
      caption: 'Temp post to verify instagram_manage_contents delete API',
      access_token: token
    })
  });
  const container = await createRes.json();
  console.log('Temp container:', container);

  if (container.id) {
    const pubRes = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: token })
    });
    const published = await pubRes.json();
    console.log('Temp published post:', published);

    if (published.id) {
      console.log('--- Calling DELETE /{ig_media_id} for instagram_manage_contents ---');
      const delRes = await fetch(`https://graph.facebook.com/v26.0/${published.id}?access_token=${token}`, {
        method: 'DELETE'
      });
      console.log('Delete result:', await delRes.json());
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());


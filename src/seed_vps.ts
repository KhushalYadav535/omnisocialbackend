import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Local DB
const localPrisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
});

// VPS DB
const vpsPrisma = new PrismaClient({
  datasources: {
    db: { url: 'postgresql://Sentient%20Database:Sentient1234%40@213.210.37.237:32768/omnisocial?sslmode=disable' }
  }
});

async function main() {
  try {
    console.log('--- Checking VPS DB ---');
    const vpsUsers = await vpsPrisma.user.findMany();
    console.log(`VPS DB has ${vpsUsers.length} users.`);

    if (vpsUsers.length === 0) {
      console.log('--- Cloning Local Seed Data to VPS DB ---');
      // 1. Subscription Plans
      const localPlans = await localPrisma.subscriptionPlan.findMany();
      for (const p of localPlans) {
        await vpsPrisma.subscriptionPlan.upsert({
          where: { id: p.id },
          update: p,
          create: p
        });
      }
      console.log(`Synced ${localPlans.length} subscription plans.`);

      // 2. Tenants
      const localTenants = await localPrisma.tenant.findMany();
      for (const t of localTenants) {
        await vpsPrisma.tenant.upsert({
          where: { id: t.id },
          update: t,
          create: t
        });
      }
      console.log(`Synced ${localTenants.length} tenants.`);

      // 3. Users
      const localUsers = await localPrisma.user.findMany();
      for (const u of localUsers) {
        await vpsPrisma.user.upsert({
          where: { id: u.id },
          update: u,
          create: u
        });
        console.log(`Synced user: ${u.email}`);
      }

      // 4. Businesses
      const localBiz = await localPrisma.business.findMany();
      for (const b of localBiz) {
        await vpsPrisma.business.upsert({
          where: { id: b.id },
          update: b,
          create: b
        });
      }

      // 5. Brands
      const localBrands = await localPrisma.brand.findMany();
      for (const br of localBrands) {
        await vpsPrisma.brand.upsert({
          where: { id: br.id },
          update: br,
          create: br
        });
        console.log(`Synced brand: ${br.name} (${br.id})`);
      }

      // 6. Connected Social Accounts
      const localAccounts = await localPrisma.socialAccount.findMany();
      for (const acc of localAccounts) {
        await vpsPrisma.socialAccount.upsert({
          where: { id: acc.id },
          update: acc,
          create: acc
        });
        console.log(`Synced connected social account: ${acc.accountName} (${acc.platform})`);
      }

      // 7. Interactions
      const localInteractions = await localPrisma.interaction.findMany();
      for (const inter of localInteractions) {
        await vpsPrisma.interaction.upsert({
          where: { id: inter.id },
          update: inter,
          create: inter
        });
      }
      console.log(`Synced ${localInteractions.length} interactions.`);

      console.log('✅ ALL SEED, ACCOUNTS & USER DATA SUCCESSFULLY SYNCED TO VPS DATABASE!');
    }
  } catch (err: any) {
    console.error('Migration error:', err.message);
  } finally {
    await localPrisma.$disconnect();
    await vpsPrisma.$disconnect();
  }
}

main();


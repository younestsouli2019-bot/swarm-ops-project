import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== 1. Total ProcurementItem count ===');
  const total = await prisma.$queryRawUnsafe('SELECT count(*)::int as count FROM "ProcurementItem"');
  console.log(JSON.stringify(total));

  console.log('\n=== 2. Count by status ===');
  const byStatus = await prisma.$queryRawUnsafe('SELECT status, count(*)::int as count FROM "ProcurementItem" GROUP BY status ORDER BY count DESC');
  console.log(JSON.stringify(byStatus, null, 2));

  console.log('\n=== 3. All items (limit 20) ===');
  const items = await prisma.$queryRawUnsafe('SELECT * FROM "ProcurementItem" LIMIT 20');
  console.log(JSON.stringify(items, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());

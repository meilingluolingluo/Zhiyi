/**
 * CLI：查看候选记忆。
 * 用法：npm run candidates -- [status] [user_id]
 * 例：npm run candidates -- pending u1
 */
import { CandidateStore } from '../src/candidates';
import { loadConfig } from '../src/config';
import { Database } from '../src/db';
import type { CandidateStatus } from '../src/types';

function main(): void {
  const config = loadConfig();
  const status: string | undefined = process.argv[2];
  const userId: string = process.argv[3] ?? config.defaultIdentity.user_id;
  const db: Database = Database.open(config.databaseUrl);
  try {
    db.migrate();
    const items = new CandidateStore(db).list(userId, {
      status: status ? (status as CandidateStatus) : undefined,
      limit: 100,
    });
    console.log(`用户 ${userId} 的候选记忆（${items.length} 条）：`);
    for (const item of items) {
      console.log(
        `- [${item.status}] ${item.id} | ${item.scope}/${item.type} | 置信度 ${item.confidence.toFixed(2)} | ${item.content}`,
      );
    }
    console.log('提示：使用 POST /v1/memory-candidates/:id/approve 将其写入正式记忆库。');
  } finally {
    db.close();
  }
}

main();

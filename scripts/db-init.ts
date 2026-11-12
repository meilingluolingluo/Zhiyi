/** CLI：幂等初始化 SQLite 数据库并写入内置 Agent Profile。 */
import { AgentStore } from '../src/agents';
import { loadConfig } from '../src/config';
import { Database } from '../src/db';

function main(): void {
  const config = loadConfig();
  const db: Database = Database.open(config.databaseUrl);
  try {
    db.migrate();
    new AgentStore(db).seed();
    const row = db.get<{ version: string }>('SELECT version FROM schema_migrations LIMIT 1');
    console.log(`数据库初始化完成：${config.databaseUrl}（schema: ${row?.version ?? '001_init'}）`);
  } finally {
    db.close();
  }
}

main();

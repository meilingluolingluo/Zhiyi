#!/usr/bin/env node
/**
 * 本机内嵌 PostgreSQL 启动器（不依赖 Docker、不注册系统服务）。
 *
 * 使用 `embedded-postgres` 自带的 macOS 二进制，把数据目录固定在本项目
 * `data/pgdata`，仅监听 127.0.0.1:5433，供 ADP Chat Client 使用。
 *
 * 用法：
 *   node scripts/local/start-postgres.mjs            # 前台常驻（Ctrl+C 退出）
 *   node scripts/local/start-postgres.mjs --init     # 首次初始化集群并创建 adp_chat
 *
 * 说明：
 * - 首次运行会自动 initdb；数据目录已存在时直接启动，不会清空数据。
 * - 端口可用 PG_PORT 覆盖，数据目录可用 PG_DATA_DIR 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// embedded-postgres 安装在 data/pg-node（避免污染主项目依赖），因此显式解析。
const pgModuleDir = path.join(root, 'data/pg-node');
const requireFromPg = createRequire(path.join(pgModuleDir, 'package.json'));
const EmbeddedPostgres = requireFromPg('embedded-postgres').default ?? requireFromPg('embedded-postgres');

const dataDir = process.env.PG_DATA_DIR ?? path.join(root, 'data/pgdata');
const port = Number(process.env.PG_PORT ?? 5433);
const user = process.env.PG_USER ?? process.env.USER ?? 'postgres';
const password = process.env.PG_PASSWORD ?? 'localdev';
const database = process.env.PG_DATABASE ?? 'adp_chat';
const fresh = fs.existsSync(dataDir) === false || process.argv.includes('--init');

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
});

if (fresh) {
  console.log(`[pg] 初始化数据目录 ${dataDir}`);
  await pg.initialise();
} else {
  console.log(`[pg] 复用已有数据目录 ${dataDir}`);
}

await pg.start();
console.log(`[pg] 已启动：postgresql://${user}@127.0.0.1:${port}/${database}`);

try {
  await pg.createDatabase(database);
  console.log(`[pg] 已创建数据库 ${database}`);
} catch (error) {
  console.log(`[pg] 数据库 ${database} 已存在或无需创建（${error.message}）`);
}

const shutdown = async (signal) => {
  console.log(`[pg] 收到 ${signal}，正在停止…`);
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// 常驻，保持 postmaster 存活。
setInterval(() => undefined, 60_000);

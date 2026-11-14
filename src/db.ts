/**
 * SQLite 访问层。
 *
 * 使用 Node 22 内置的 `node:sqlite`（DatabaseSync，同步 API），
 * 避免 better-sqlite3 的原生编译依赖。通过 createRequire 加载，
 * 使同一份代码在 CommonJS 编译产物与 vitest 的 ESM 环境下都能运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

type SqlValue = string | number | bigint | null | Uint8Array;

interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (filename: string) => SqliteDatabase;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** 把 JS 值规整为 node:sqlite 支持的参数类型。 */
function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

/** 迁移版本清单：按数组顺序执行，新增迁移只需在此登记。 */
const MIGRATIONS: readonly string[] = [
  '001_init',
  '002_trajectory_request_scope',
  '003_personal_ai',
  '004_v1_5_phase1',
  '005_execution_lifecycle',
  '006_memory_evolution',
  '007_proactive_assistant',
  '008_butler_router_watchdog',
  '009_memory_extraction_pipeline',
];

/** 定位迁移脚本：优先工作目录，其次相对编译产物目录。 */
function findMigrationFile(version: string): string {
  const filename: string = `${version}.sql`;
  const candidates: string[] = [path.resolve(process.cwd(), 'migrations', filename)];
  if (typeof __dirname !== 'undefined') {
    candidates.push(
      path.resolve(__dirname, '..', 'migrations', filename),
      path.resolve(__dirname, '..', '..', 'migrations', filename),
      path.resolve(__dirname, 'migrations', filename),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`未找到 migrations/${filename}，请在项目根目录运行服务`);
}

export class Database {
  private readonly handle: SqliteDatabase;
  public readonly filename: string;

  private constructor(handle: SqliteDatabase, filename: string) {
    this.handle = handle;
    this.filename = filename;
  }

  /** 打开（或创建）数据库；相对路径基于当前工作目录。 */
  static open(databaseUrl: string): Database {
    const filename: string =
      databaseUrl === ':memory:' ? ':memory:' : path.resolve(process.cwd(), databaseUrl);
    if (filename !== ':memory:') {
      const parent: string = path.dirname(filename);
      fs.mkdirSync(parent, { recursive: true });
    }
    const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const sqlite = nodeRequire('node:sqlite') as SqliteModule;
    const handle: SqliteDatabase = new sqlite.DatabaseSync(filename);
    // WAL 在部分受限文件系统（沙箱 / 网络盘）上不可用，失败时降级为默认 journal 模式。
    try {
      handle.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // 保持 SQLite 默认 journal 模式，不影响功能正确性。
    }
    handle.exec('PRAGMA foreign_keys = ON;');
    return new Database(handle, filename);
  }

  /** 按登记顺序幂等执行迁移；已应用的版本直接跳过，保证旧库升级不重复重建表。 */
  migrate(): void {
    const base: string = MIGRATIONS[0];
    // 001 全部是 CREATE ... IF NOT EXISTS，无条件重复执行也安全，
    // 它同时负责创建 schema_migrations 版本表。
    this.handle.exec(fs.readFileSync(findMigrationFile(base), 'utf8'));
    this.run(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      [base, new Date().toISOString()],
    );

    for (const version of MIGRATIONS.slice(1)) {
      const applied = this.get<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = ?',
        [version],
      );
      if (applied) continue;
      this.handle.exec(fs.readFileSync(findMigrationFile(version), 'utf8'));
      this.run(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        [version, new Date().toISOString()],
      );
    }
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const result = this.handle
      .prepare(sql)
      .run(...params.map(toSqlValue));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.handle.prepare(sql).get(...params.map(toSqlValue)) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.handle.prepare(sql).all(...params.map(toSqlValue)) as T[];
  }

  private inTransaction = false;

  /** 简易事务包装，支持嵌套调用复用外层事务，失败时回滚。 */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.handle.exec('BEGIN IMMEDIATE');
    try {
      const result: T = fn();
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      this.handle.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.handle.close();
  }
}

/**
 * User Profile 持久化（users 表）。
 *
 * 时区优先级：user（显式保存）> header（合法 X-Timezone 请求头）> default（'UTC'）。
 * JSON 字段（work_style / preferences）采用严格白名单校验与受控浅合并。
 */
import type { Database } from '../../db';
import {
  DomainError,
  PROACTIVE_FREQUENCIES,
  PROACTIVE_NOTIFICATION_KINDS,
  RESPONSE_STYLES,
  type EnsureUserOptions,
  type ProactiveFrequency,
  type ProactiveNotificationKind,
  type ResponseStyle,
  type TimezoneSource,
  type UserPreferences,
  type UserProfile,
  type UserProfilePatch,
  type UserWorkStyle,
} from './types';

const MAX_JSON_BYTES = 8192;
const MAX_DISPLAY_NAME_LEN = 120;
const MAX_LANGUAGE_LEN = 32;
const MAX_CONVENTIONS = 20;
const MAX_CONVENTION_LEN = 200;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const WORK_STYLE_KEYS: ReadonlySet<string> = new Set([
  'response_style',
  'language',
  'coding_conventions',
]);
const PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  'default_project_id',
  'memory_injection_enabled',
  'proactive_enabled',
  'proactive_frequency',
  'proactive_types',
  'proactive_quiet_hours',
  'proactive_paused_until',
]);

interface UserRow {
  user_id: string;
  display_name: string;
  timezone: string;
  timezone_source: string;
  work_style: string;
  preferences: string;
  created_at: string;
  updated_at: string;
}

export function isValidIanaTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string') return false;
  const trimmed: string = timezone.trim();
  if (trimmed === '' || trimmed.length > 100) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeJsonKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DomainError(400, 'invalid_payload', `${label} 包含非法字段名: ${key}`);
    }
    if (!allowed.has(key)) {
      throw new DomainError(400, 'invalid_payload', `${label} 包含不支持的字段: ${key}`);
    }
  }
}

function validateAndMergeWorkStyle(existing: UserWorkStyle, patch: unknown): UserWorkStyle {
  if (!isPlainRecord(patch)) {
    throw new DomainError(400, 'invalid_work_style', 'work_style 必须为普通 JSON 对象');
  }
  assertSafeJsonKeys(patch, WORK_STYLE_KEYS, 'work_style');

  const merged: UserWorkStyle = { ...existing };
  if ('response_style' in patch) {
    const val: unknown = patch.response_style;
    if (val === null) {
      delete merged.response_style;
    } else if (typeof val === 'string' && RESPONSE_STYLES.includes(val as ResponseStyle)) {
      merged.response_style = val as ResponseStyle;
    } else {
      throw new DomainError(
        400,
        'invalid_work_style',
        `work_style.response_style 必须为 ${RESPONSE_STYLES.join(' | ')}`,
      );
    }
  }

  if ('language' in patch) {
    const val: unknown = patch.language;
    if (val === null) {
      delete merged.language;
    } else if (typeof val === 'string' && val.trim() !== '' && val.trim().length <= MAX_LANGUAGE_LEN) {
      merged.language = val.trim();
    } else {
      throw new DomainError(400, 'invalid_work_style', `work_style.language 必须为 1-${MAX_LANGUAGE_LEN} 字符`);
    }
  }

  if ('coding_conventions' in patch) {
    const val: unknown = patch.coding_conventions;
    if (val === null) {
      delete merged.coding_conventions;
    } else if (Array.isArray(val) && val.length <= MAX_CONVENTIONS) {
      const cleaned: string[] = [];
      for (const item of val) {
        if (typeof item !== 'string' || item.trim() === '' || item.trim().length > MAX_CONVENTION_LEN) {
          throw new DomainError(
            400,
            'invalid_work_style',
            `work_style.coding_conventions 每项必须为 1-${MAX_CONVENTION_LEN} 字符`,
          );
        }
        cleaned.push(item.trim());
      }
      merged.coding_conventions = cleaned;
    } else {
      throw new DomainError(
        400,
        'invalid_work_style',
        `work_style.coding_conventions 必须为最多 ${MAX_CONVENTIONS} 项的字符串数组`,
      );
    }
  }

  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > MAX_JSON_BYTES) {
    throw new DomainError(400, 'payload_too_large', `work_style 序列化后不得超过 ${MAX_JSON_BYTES} 字节`);
  }
  return merged;
}

function validateAndMergePreferences(
  db: Database,
  userId: string,
  existing: UserPreferences,
  patch: unknown,
): UserPreferences {
  if (!isPlainRecord(patch)) {
    throw new DomainError(400, 'invalid_preferences', 'preferences 必须为普通 JSON 对象');
  }
  assertSafeJsonKeys(patch, PREFERENCE_KEYS, 'preferences');

  const merged: UserPreferences = { ...existing };
  if ('default_project_id' in patch) {
    const val: unknown = patch.default_project_id;
    if (val === null) {
      merged.default_project_id = null;
    } else if (typeof val === 'string' && val.trim() !== '') {
      const projectId: string = val.trim();
      const owned = db.get<{ id: string }>(
        'SELECT id FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        [projectId, userId],
      );
      if (!owned) {
        throw new DomainError(404, 'not_found', 'default_project_id 对应的项目不存在或无权访问');
      }
      merged.default_project_id = projectId;
    } else {
      throw new DomainError(400, 'invalid_preferences', 'preferences.default_project_id 必须为非空字符串或 null');
    }
  }

  if ('memory_injection_enabled' in patch) {
    const val: unknown = patch.memory_injection_enabled;
    if (val === null) {
      delete merged.memory_injection_enabled;
    } else if (typeof val === 'boolean') {
      merged.memory_injection_enabled = val;
    } else {
      throw new DomainError(400, 'invalid_preferences', 'preferences.memory_injection_enabled 必须为布尔值');
    }
  }

  if ('proactive_enabled' in patch) {
    const val: unknown = patch.proactive_enabled;
    if (val === null) {
      delete merged.proactive_enabled;
    } else if (typeof val === 'boolean') {
      merged.proactive_enabled = val;
    } else {
      throw new DomainError(400, 'invalid_preferences', 'preferences.proactive_enabled 必须为布尔值');
    }
  }

  if ('proactive_frequency' in patch) {
    const val: unknown = patch.proactive_frequency;
    if (val === null) {
      delete merged.proactive_frequency;
    } else if (typeof val === 'string' && PROACTIVE_FREQUENCIES.includes(val as ProactiveFrequency)) {
      merged.proactive_frequency = val as ProactiveFrequency;
    } else {
      throw new DomainError(
        400,
        'invalid_preferences',
        `preferences.proactive_frequency 必须为 ${PROACTIVE_FREQUENCIES.join(' | ')}`,
      );
    }
  }

  if ('proactive_types' in patch) {
    const val: unknown = patch.proactive_types;
    if (val === null) {
      delete merged.proactive_types;
    } else if (Array.isArray(val)) {
      const cleaned: ProactiveNotificationKind[] = [];
      for (const item of val) {
        if (
          typeof item !== 'string' ||
          !PROACTIVE_NOTIFICATION_KINDS.includes(item as ProactiveNotificationKind)
        ) {
          throw new DomainError(
            400,
            'invalid_preferences',
            `preferences.proactive_types 包含非法提醒类型: ${String(item)}`,
          );
        }
        if (!cleaned.includes(item as ProactiveNotificationKind)) {
          cleaned.push(item as ProactiveNotificationKind);
        }
      }
      merged.proactive_types = cleaned;
    } else {
      throw new DomainError(400, 'invalid_preferences', 'preferences.proactive_types 必须为数组或 null');
    }
  }

  if ('proactive_quiet_hours' in patch) {
    const val: unknown = patch.proactive_quiet_hours;
    if (val === null) {
      merged.proactive_quiet_hours = null;
    } else if (isPlainRecord(val)) {
      assertSafeJsonKeys(val, new Set(['start', 'end']), 'preferences.proactive_quiet_hours');
      const start = typeof val.start === 'string' ? val.start.trim() : '';
      const end = typeof val.end === 'string' ? val.end.trim() : '';
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
        throw new DomainError(
          400,
          'invalid_preferences',
          'preferences.proactive_quiet_hours.start/end 必须为 HH:mm（00:00-23:59）',
        );
      }
      merged.proactive_quiet_hours = { start, end };
    } else {
      throw new DomainError(400, 'invalid_preferences', 'preferences.proactive_quiet_hours 必须为对象或 null');
    }
  }

  if ('proactive_paused_until' in patch) {
    const val: unknown = patch.proactive_paused_until;
    if (val === null || val === '') {
      merged.proactive_paused_until = null;
    } else if (typeof val === 'string' && Number.isFinite(Date.parse(val.trim()))) {
      merged.proactive_paused_until = new Date(Date.parse(val.trim())).toISOString();
    } else {
      throw new DomainError(
        400,
        'invalid_preferences',
        'preferences.proactive_paused_until 必须为合法 ISO 时间字符串或 null',
      );
    }
  }

  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > MAX_JSON_BYTES) {
    throw new DomainError(400, 'payload_too_large', `preferences 序列化后不得超过 ${MAX_JSON_BYTES} 字节`);
  }
  return merged;
}

function parseJsonField<T extends object>(raw: string): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function normalizeSource(raw: string): TimezoneSource {
  return raw === 'user' || raw === 'header' ? raw : 'default';
}

function rowToProfile(row: UserRow): UserProfile {
  return {
    user_id: row.user_id,
    display_name: row.display_name,
    timezone: row.timezone,
    timezone_source: normalizeSource(row.timezone_source),
    work_style: parseJsonField<UserWorkStyle>(row.work_style),
    preferences: parseJsonField<UserPreferences>(row.preferences),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class UserProfileStore {
  constructor(private readonly db: Database) {}

  get(userId: string): UserProfile | undefined {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ?', [userId]);
    return row ? rowToProfile(row) : undefined;
  }

  /**
   * 幂等确保用户记录存在（供已处于事务中的调用方复用，避免嵌套 BEGIN IMMEDIATE）。
   */
  ensureUserInTx(userId: string, options: EnsureUserOptions = {}): UserProfile {
    const normalizedId: string = userId.trim();
    if (normalizedId === '') {
      throw new DomainError(400, 'invalid_user_id', 'user_id 不能为空');
    }
    const headerTz: string | null = isValidIanaTimezone(options.headerTimezone)
      ? options.headerTimezone.trim()
      : null;

    const existing = this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ?', [normalizedId]);
    const now: string = new Date().toISOString();
    if (!existing) {
      const displayName: string =
        typeof options.displayName === 'string'
          ? options.displayName.trim().slice(0, MAX_DISPLAY_NAME_LEN)
          : '';
      const timezone: string = headerTz ?? 'UTC';
      const source: TimezoneSource = headerTz ? 'header' : 'default';
      this.db.run(
        `INSERT INTO users
           (user_id, display_name, timezone, timezone_source, work_style, preferences, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '{}', ?, ?)`,
        [normalizedId, displayName, timezone, source, now, now],
      );
      return rowToProfile(
        this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ?', [normalizedId]) as UserRow,
      );
    }

    const currentSource: TimezoneSource = normalizeSource(existing.timezone_source);
    if (currentSource !== 'user' && headerTz && (existing.timezone !== headerTz || currentSource !== 'header')) {
      this.db.run(
        `UPDATE users
            SET timezone = ?, timezone_source = 'header', updated_at = ?
          WHERE user_id = ? AND timezone_source != 'user'`,
        [headerTz, now, normalizedId],
      );
    }
    return rowToProfile(
      this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ?', [normalizedId]) as UserRow,
    );
  }

  /**
   * 幂等确保用户记录存在，并按 user > header > default 规则落实时区。
   * - 已显式保存过时区（timezone_source='user'）时，header 永不覆盖；
   * - 当前仍为 default 或 header 时，若本次提供合法 headerTimezone，则更新为该 header 时区；
   * - 非法或缺失 headerTimezone 时，绝不把已有 header 降级回 UTC。
   */
  ensureUser(userId: string, options: EnsureUserOptions = {}): UserProfile {
    return this.db.transaction((): UserProfile => this.ensureUserInTx(userId, options));
  }

  /**
   * 显式更新用户档案。传入 timezone 时校验合法 IANA 时区并将 timezone_source 提升为 'user'。
   */
  update(userId: string, patch: UserProfilePatch, options: EnsureUserOptions = {}): UserProfile {
    return this.db.transaction((): UserProfile => {
      const current: UserProfile = this.ensureUserInTx(userId, options);
      const assignments: string[] = [];
      const params: unknown[] = [];

      if ('display_name' in patch) {
        if (typeof patch.display_name !== 'string') {
          throw new DomainError(400, 'invalid_display_name', 'display_name 必须为字符串');
        }
        const trimmed: string = patch.display_name.trim();
        if (trimmed.length > MAX_DISPLAY_NAME_LEN) {
          throw new DomainError(
            400,
            'invalid_display_name',
            `display_name 长度不能超过 ${MAX_DISPLAY_NAME_LEN}`,
          );
        }
        assignments.push('display_name = ?');
        params.push(trimmed);
      }

      if ('timezone' in patch) {
        if (!isValidIanaTimezone(patch.timezone)) {
          throw new DomainError(400, 'invalid_timezone', 'timezone 必须为合法 IANA 时区名称');
        }
        assignments.push('timezone = ?', "timezone_source = 'user'");
        params.push(patch.timezone.trim());
      }

      if ('work_style' in patch) {
        const mergedStyle: UserWorkStyle = validateAndMergeWorkStyle(
          current.work_style,
          patch.work_style,
        );
        assignments.push('work_style = ?');
        params.push(JSON.stringify(mergedStyle));
      }

      if ('preferences' in patch) {
        const mergedPrefs: UserPreferences = validateAndMergePreferences(
          this.db,
          current.user_id,
          current.preferences,
          patch.preferences,
        );
        assignments.push('preferences = ?');
        params.push(JSON.stringify(mergedPrefs));
      }

      if (assignments.length === 0) return current;

      assignments.push('updated_at = ?');
      params.push(new Date().toISOString(), current.user_id);
      this.db.run(`UPDATE users SET ${assignments.join(', ')} WHERE user_id = ?`, params);

      return rowToProfile(
        this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ?', [current.user_id]) as UserRow,
      );
    });
  }
}

/**
 * Personal AI V1.5 领域类型与校验错误定义（Step 2 + Step 3）。
 */

export type TimezoneSource = 'default' | 'header' | 'user';
export type ResponseStyle = 'concise' | 'detailed' | 'structured';

export const TIMEZONE_SOURCES: readonly TimezoneSource[] = ['default', 'header', 'user'];
export const RESPONSE_STYLES: readonly ResponseStyle[] = ['concise', 'detailed', 'structured'];

export type PriorityLevel = 0 | 1 | 2 | 3 | 4;

export type GoalStatus = 'draft' | 'active' | 'paused' | 'achieved' | 'abandoned';
export const GOAL_STATUSES: readonly GoalStatus[] = [
  'draft',
  'active',
  'paused',
  'achieved',
  'abandoned',
];

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'active',
  'paused',
  'completed',
  'archived',
];

export type BusinessTaskStatus =
  | 'draft'
  | 'pending'
  | 'ready'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const BUSINESS_TASK_STATUSES: readonly BusinessTaskStatus[] = [
  'draft',
  'pending',
  'ready',
  'assigned',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
];

export const INITIAL_TASK_STATUSES: readonly BusinessTaskStatus[] = [
  'draft',
  'pending',
  'ready',
  'assigned',
];

export interface UserWorkStyle {
  response_style?: ResponseStyle;
  language?: string;
  coding_conventions?: string[];
}

export interface UserPreferences {
  default_project_id?: string | null;
  memory_injection_enabled?: boolean;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  timezone: string;
  timezone_source: TimezoneSource;
  work_style: UserWorkStyle;
  preferences: UserPreferences;
  created_at: string;
  updated_at: string;
}

export interface EnsureUserOptions {
  headerTimezone?: string | null;
  displayName?: string;
}

export interface UserProfilePatch {
  display_name?: string;
  timezone?: string;
  work_style?: unknown;
  preferences?: unknown;
}

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: PriorityLevel;
  target_date: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewGoalInput {
  title: string;
  description?: string;
  status?: GoalStatus;
  priority?: number;
  target_date?: string | null;
  project_ids?: string[];
}

export interface GoalPatch {
  title?: string;
  description?: string;
  status?: GoalStatus;
  priority?: number;
  target_date?: string | null;
}

export interface GoalFilters {
  status?: GoalStatus;
  limit?: number;
  offset?: number;
}

export interface Project {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewProjectInput {
  title: string;
  description?: string;
  status?: ProjectStatus;
  goal_ids?: string[];
}

export interface ProjectPatch {
  title?: string;
  description?: string;
  status?: ProjectStatus;
}

export interface ProjectFilters {
  status?: ProjectStatus;
  goal_id?: string;
  limit?: number;
  offset?: number;
}

export interface BusinessTask {
  id: string;
  user_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: BusinessTaskStatus;
  priority: PriorityLevel;
  assignee_agent_id: string | null;
  due_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewBusinessTaskInput {
  title: string;
  description?: string;
  project_id?: string | null;
  parent_task_id?: string | null;
  priority?: number;
  assignee_agent_id?: string | null;
  due_at?: string | null;
  status?: string;
}

export interface BusinessTaskPatch {
  title?: string;
  description?: string;
  project_id?: string | null;
  parent_task_id?: string | null;
  status?: string;
  priority?: number;
  assignee_agent_id?: string | null;
  due_at?: string | null;
}

export interface BusinessTaskFilters {
  project_id?: string;
  status?: BusinessTaskStatus;
  parent_task_id?: string | null;
  limit?: number;
  offset?: number;
}

export interface SubtaskStats {
  total: number;
  completed: number;
  in_progress: number;
  failed: number;
  cancelled: number;
  pending: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly type = 'invalid_request_error',
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

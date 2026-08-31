export const TASK_STATUSES = ["open", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_EVENT_TYPES = [
  "task_created",
  "users_assigned",
  "user_completed",
  "task_archived"
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

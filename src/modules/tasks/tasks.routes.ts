import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../common/errors/api-error";
import { idempotent } from "../../common/middleware/idempotency";
import { query } from "../../database/pool";

export const tasksRouter = Router();

const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).nullable().optional()
});

const taskStatusSchema = z.enum(["open", "archived"]);

const assignUsersSchema = z.strictObject({
  userIds: z.array(z.number().int().positive().safe()).min(1)
});

const completeTaskSchema = z.strictObject({
  userId: z.number().int().positive().safe()
});

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "archived";
  archived_at: string | null;
  created_at: string;
}

interface AssignedUser {
  id: number;
  name: string;
  lastName: string;
  email: string;
  completed: boolean;
  completedAt: string | null;
  assignedAt: string;
}

interface TaskDetailRow extends TaskRow {
  assigned_users: AssignedUser[];
}

interface NotificationAttempt {
  attemptNumber: number;
  attemptedAt: string;
  httpStatus: number | null;
  errorMessage: string | null;
}

interface NotificationHistoryRow {
  task_id: string;
  job_status: "pending" | "processing" | "succeeded" | "failed" | null;
  attempts: NotificationAttempt[];
}

function parseTaskId(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid task ID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid task ID");
  }
  return id;
}

function mapTask(task: TaskDetailRow) {
  return {
    id: Number(task.id),
    title: task.title,
    description: task.description,
    status: task.status,
    archivedAt: task.archived_at,
    createdAt: task.created_at,
    assignedUsers: task.assigned_users.map((user) => ({
      ...user,
      id: Number(user.id)
    }))
  };
}

const taskDetailsSql = `
  SELECT t.id,
         t.title,
         t.description,
         t.status,
         t.archived_at,
         t.created_at,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', u.id,
               'name', u.name,
               'lastName', u.last_name,
               'email', u.email,
               'completed', ta.completed_at IS NOT NULL,
               'completedAt', ta.completed_at,
               'assignedAt', ta.assigned_at
             ) ORDER BY ta.assigned_at, u.id
           ) FILTER (WHERE u.id IS NOT NULL),
           '[]'::jsonb
         ) AS assigned_users
    FROM tasks t
    LEFT JOIN task_assignments ta ON ta.task_id = t.id
    LEFT JOIN users u ON u.id = ta.user_id`;

tasksRouter.post("/", idempotent(async (request, client) => {
  const parsed = createTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid task data");
  }

  const result = await client.query<TaskRow>(
    `INSERT INTO tasks (title, description)
     VALUES ($1, $2)
     RETURNING id, title, description, status, archived_at, created_at`,
    [parsed.data.title, parsed.data.description ?? null]
  );
  const task = result.rows[0];

  return {
    statusCode: 201,
    body: {
      id: Number(task?.id),
      title: task?.title,
      description: task?.description,
      status: task?.status,
      archivedAt: task?.archived_at,
      createdAt: task?.created_at
    }
  };
}));

tasksRouter.post("/:idTask/assign", idempotent(async (request, client) => {
  const taskId = parseTaskId(request.params.idTask);
  const parsed = assignUsersSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid assignment data");
  }
  const userIds = [...new Set(parsed.data.userIds)];

  const task = await client.query<{ status: "open" | "archived" }>(
    "SELECT status FROM tasks WHERE id = $1 FOR UPDATE",
    [taskId]
  );
  if (!task.rows[0]) {
    throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
  }
  if (task.rows[0].status === "archived") {
    throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot receive assignments");
  }

  const users = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE id = ANY($1::bigint[])",
    [userIds]
  );
  if (users.rows.length !== userIds.length) {
    throw new ApiError(404, "USER_NOT_FOUND", "One or more users were not found");
  }

  await client.query(
    `INSERT INTO task_assignments (task_id, user_id)
     SELECT $1, user_id
       FROM unnest($2::bigint[]) AS user_id
     ON CONFLICT (task_id, user_id) DO NOTHING`,
    [taskId, userIds]
  );

  return {
    statusCode: 200,
    body: { message: "Users assigned successfully", taskId, assignedUserIds: userIds }
  };
}));

tasksRouter.post("/:idTask/complete", idempotent(async (request, client) => {
  const taskId = parseTaskId(request.params.idTask);
  const parsed = completeTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid completion data");
  }
  const { userId } = parsed.data;

  const task = await client.query<{
    title: string;
    status: "open" | "archived";
    archived_at: string | null;
  }>("SELECT title, status, archived_at FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
  const taskRow = task.rows[0];
  if (!taskRow) {
    throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
  }

  const user = await client.query("SELECT 1 FROM users WHERE id = $1", [userId]);
  if (!user.rows[0]) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  const assignment = await client.query<{ completed_at: string | null }>(
    `SELECT completed_at
       FROM task_assignments
      WHERE task_id = $1 AND user_id = $2
      FOR UPDATE`,
    [taskId, userId]
  );
  const assignmentRow = assignment.rows[0];
  if (!assignmentRow) {
    throw new ApiError(409, "USER_NOT_ASSIGNED", "User is not assigned to this task");
  }

  if (assignmentRow.completed_at === null) {
    await client.query(
      `UPDATE task_assignments
          SET completed_at = NOW()
        WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );
  }

  let status = taskRow.status;
  let archivedAt = taskRow.archived_at;
  if (status === "open") {
    const pending = await client.query(
      `SELECT 1
         FROM task_assignments
        WHERE task_id = $1 AND completed_at IS NULL
        LIMIT 1`,
      [taskId]
    );

    if (!pending.rows[0]) {
      const archived = await client.query<{ archived_at: string }>(
        `UPDATE tasks
            SET status = 'archived', archived_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'open'
          RETURNING archived_at`,
        [taskId]
      );
      const archivedRow = archived.rows[0];
      if (archivedRow) {
        status = "archived";
        archivedAt = archivedRow.archived_at;
        await client.query(
          `INSERT INTO notification_jobs (task_id)
           VALUES ($1)
           ON CONFLICT (task_id) DO NOTHING`,
          [taskId]
        );
      }
    }
  }

  return {
    statusCode: 200,
    body: {
      message: "User task participation completed",
      taskId,
      userId,
      taskStatus: status,
      archivedAt
    }
  };
}));

tasksRouter.get("/", async (request, response) => {
  let status: "open" | "archived" | undefined;
  if (request.query.status !== undefined) {
    const parsed = taskStatusSchema.safeParse(request.query.status);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid task status");
    }
    status = parsed.data;
  }

  const result = await query<TaskDetailRow>(
    `${taskDetailsSql}
      ${status ? "WHERE t.status = $1" : ""}
     GROUP BY t.id
     ORDER BY t.id`,
    status ? [status] : []
  );

  response.json(result.rows.map(mapTask));
});

tasksRouter.get("/:idTask/notifications", async (request, response) => {
  const taskId = parseTaskId(request.params.idTask);
  const result = await query<NotificationHistoryRow>(
    `SELECT t.id AS task_id,
            nj.status AS job_status,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'attemptNumber', na.attempt_number,
                  'attemptedAt', na.attempted_at,
                  'httpStatus', na.http_status,
                  'errorMessage', na.error_message
                ) ORDER BY na.attempt_number
              ) FILTER (WHERE na.id IS NOT NULL),
              '[]'::jsonb
            ) AS attempts
       FROM tasks t
       LEFT JOIN notification_jobs nj ON nj.task_id = t.id
       LEFT JOIN notification_attempts na ON na.job_id = nj.id
      WHERE t.id = $1
      GROUP BY t.id, nj.id`,
    [taskId]
  );
  const history = result.rows[0];
  if (!history) {
    throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
  }

  response.json({
    taskId: Number(history.task_id),
    status: history.job_status,
    attempts: history.attempts.map((attempt) => ({
      ...attempt,
      attemptNumber: Number(attempt.attemptNumber),
      httpStatus: attempt.httpStatus === null ? null : Number(attempt.httpStatus)
    }))
  });
});

tasksRouter.get("/:idTask", async (request, response) => {
  const taskId = parseTaskId(request.params.idTask);
  const result = await query<TaskDetailRow>(
    `${taskDetailsSql}
      WHERE t.id = $1
      GROUP BY t.id`,
    [taskId]
  );

  const task = result.rows[0];
  if (!task) {
    throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
  }

  response.json(mapTask(task));
});

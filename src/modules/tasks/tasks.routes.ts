import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../common/errors/api-error";
import { query } from "../../database/pool";

export const tasksRouter = Router();

const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).nullable().optional()
});

const taskStatusSchema = z.enum(["open", "archived"]);

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

function parseTaskId(value: string): number {
  if (!/^\d+$/.test(value)) {
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

tasksRouter.post("/", async (request, response) => {
  const parsed = createTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid task data");
  }

  const result = await query<TaskRow>(
    `INSERT INTO tasks (title, description)
     VALUES ($1, $2)
     RETURNING id, title, description, status, archived_at, created_at`,
    [parsed.data.title, parsed.data.description ?? null]
  );
  const task = result.rows[0];

  response.status(201).json({
    id: Number(task?.id),
    title: task?.title,
    description: task?.description,
    status: task?.status,
    archivedAt: task?.archived_at,
    createdAt: task?.created_at
  });
});

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

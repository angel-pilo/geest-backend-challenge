import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../common/errors/api-error";
import { query } from "../../database/pool";

export const usersRouter = Router();

const createUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().max(320).email()
});

interface UserRow {
  id: string;
  name: string;
  last_name: string;
  email: string;
}

interface PendingTask {
  id: number;
  title: string;
  description: string | null;
  status: "open";
  assignedAt: string;
}

interface UserWithTasksRow extends UserRow {
  pending_tasks: PendingTask[];
}

interface UserTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "archived";
  archived_at: string | null;
  assigned_at: string;
  completed_at: string | null;
}

function parseUserId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid user ID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid user ID");
  }
  return id;
}

function parseBody(body: unknown): z.infer<typeof createUserSchema> {
  const result = createUserSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid user data");
  }
  return result.data;
}

usersRouter.post("/", async (request, response) => {
  const input = parseBody(request.body);
  const result = await query<UserRow>(
    `INSERT INTO users (name, last_name, email)
     VALUES ($1, $2, $3)
     RETURNING id, name, last_name, email`,
    [input.name, input.lastName, input.email]
  );
  const user = result.rows[0];

  response.status(201).json({
    id: Number(user?.id),
    name: user?.name,
    lastName: user?.last_name,
    email: user?.email
  });
});

usersRouter.get("/", async (_request, response) => {
  const result = await query<UserWithTasksRow>(
    `SELECT u.id,
            u.name,
            u.last_name,
            u.email,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', t.id,
                  'title', t.title,
                  'description', t.description,
                  'status', t.status,
                  'assignedAt', ta.assigned_at
                ) ORDER BY ta.assigned_at, t.id
              ) FILTER (WHERE t.id IS NOT NULL),
              '[]'::jsonb
            ) AS pending_tasks
       FROM users u
       LEFT JOIN task_assignments ta
         ON ta.user_id = u.id
        AND ta.completed_at IS NULL
       LEFT JOIN tasks t
         ON t.id = ta.task_id
        AND t.status = 'open'
      GROUP BY u.id
      ORDER BY u.id`
  );

  response.json(
    result.rows.map((user) => ({
      id: Number(user.id),
      name: user.name,
      lastName: user.last_name,
      email: user.email,
      pendingTasks: user.pending_tasks.map((task) => ({
        ...task,
        id: Number(task.id)
      }))
    }))
  );
});

usersRouter.get("/:idUser/tasks", async (request, response) => {
  const userId = parseUserId(request.params.idUser);
  const user = await query<{ id: string }>("SELECT id FROM users WHERE id = $1", [userId]);
  if (!user.rows[0]) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  const result = await query<UserTaskRow>(
    `SELECT t.id,
            t.title,
            t.description,
            t.status,
            t.archived_at,
            ta.assigned_at,
            ta.completed_at
       FROM task_assignments ta
       JOIN tasks t ON t.id = ta.task_id
      WHERE ta.user_id = $1
      ORDER BY ta.assigned_at, t.id`,
    [userId]
  );

  response.json(
    result.rows.map((task) => ({
      id: Number(task.id),
      title: task.title,
      description: task.description,
      status: task.status,
      archivedAt: task.archived_at,
      assignedAt: task.assigned_at,
      completed: task.completed_at !== null,
      completedAt: task.completed_at
    }))
  );
});

import request from "supertest";
import { createApp } from "../../src/app";
import { closePool, query } from "../../src/database/pool";

interface IdRow {
  id: string;
}

describe("task assignment and completion", () => {
  const app = createApp();

  beforeEach(async () => {
    await query("TRUNCATE users, tasks CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  async function createUser(email: string): Promise<number> {
    const result = await query<IdRow>(
      "INSERT INTO users (name, last_name, email) VALUES ('Test', 'User', $1) RETURNING id",
      [email]
    );
    return Number(result.rows[0]?.id);
  }

  async function createTask(): Promise<number> {
    const result = await query<IdRow>("INSERT INTO tasks (title) VALUES ('Shared task') RETURNING id");
    return Number(result.rows[0]?.id);
  }

  it("assigns users without duplicating relationships", async () => {
    const taskId = await createTask();
    const userId = await createUser("one@example.com");

    await request(app).post(`/tasks/${taskId}/assign`).send({ userIds: [userId, userId] }).expect(200);
    await request(app).post(`/tasks/${taskId}/assign`).send({ userIds: [userId] }).expect(200);

    const assignments = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM task_assignments WHERE task_id = $1",
      [taskId]
    );
    expect(assignments.rows[0]?.count).toBe("1");
  });

  it("rolls back the entire assignment when any user does not exist", async () => {
    const taskId = await createTask();
    const userId = await createUser("one@example.com");

    const response = await request(app)
      .post(`/tasks/${taskId}/assign`)
      .send({ userIds: [userId, 999999] })
      .expect(404);

    expect(response.body.error.code).toBe("USER_NOT_FOUND");
    const assignments = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM task_assignments WHERE task_id = $1",
      [taskId]
    );
    expect(assignments.rows[0]?.count).toBe("0");
  });

  it("handles overlapping assignments concurrently without duplicates", async () => {
    const taskId = await createTask();
    const firstUser = await createUser("one@example.com");
    const secondUser = await createUser("two@example.com");
    const thirdUser = await createUser("three@example.com");

    const responses = await Promise.all([
      request(app).post(`/tasks/${taskId}/assign`).send({ userIds: [firstUser, secondUser] }),
      request(app).post(`/tasks/${taskId}/assign`).send({ userIds: [secondUser, thirdUser] })
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const assignments = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM task_assignments WHERE task_id = $1",
      [taskId]
    );
    expect(assignments.rows[0]?.count).toBe("3");
  });

  it("rejects completion by a user who is not assigned", async () => {
    const taskId = await createTask();
    const userId = await createUser("one@example.com");

    const response = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .send({ userId })
      .expect(409);

    expect(response.body).toEqual({
      error: { code: "USER_NOT_ASSIGNED", message: "User is not assigned to this task" }
    });
  });

  it("keeps a task open while an assigned user remains pending", async () => {
    const taskId = await createTask();
    const firstUser = await createUser("one@example.com");
    const secondUser = await createUser("two@example.com");
    await request(app)
      .post(`/tasks/${taskId}/assign`)
      .send({ userIds: [firstUser, secondUser] })
      .expect(200);

    const response = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .send({ userId: firstUser })
      .expect(200);

    expect(response.body).toMatchObject({ taskStatus: "open", archivedAt: null });
  });

  it("archives the task and creates one notification job after everyone completes", async () => {
    const taskId = await createTask();
    const userId = await createUser("one@example.com");
    await request(app).post(`/tasks/${taskId}/assign`).send({ userIds: [userId] }).expect(200);

    const response = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .send({ userId })
      .expect(200);

    expect(response.body).toMatchObject({ taskStatus: "archived", archivedAt: expect.any(String) });
    const jobs = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM notification_jobs WHERE task_id = $1",
      [taskId]
    );
    expect(jobs.rows[0]?.count).toBe("1");
  });

  it("handles the last two users completing concurrently with one archive and one job", async () => {
    const taskId = await createTask();
    const firstUser = await createUser("one@example.com");
    const secondUser = await createUser("two@example.com");
    await request(app)
      .post(`/tasks/${taskId}/assign`)
      .send({ userIds: [firstUser, secondUser] })
      .expect(200);

    const [first, second] = await Promise.all([
      request(app).post(`/tasks/${taskId}/complete`).send({ userId: firstUser }),
      request(app).post(`/tasks/${taskId}/complete`).send({ userId: secondUser })
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const state = await query<{
      status: string;
      completed: string;
      jobs: string;
      archive_events: string;
    }>(
      `SELECT t.status,
              COUNT(DISTINCT ta.user_id) FILTER (WHERE ta.completed_at IS NOT NULL)::text AS completed,
              COUNT(DISTINCT nj.id)::text AS jobs,
              COUNT(DISTINCT te.id) FILTER (WHERE te.event_type = 'task_archived')::text AS archive_events
         FROM tasks t
         JOIN task_assignments ta ON ta.task_id = t.id
         LEFT JOIN notification_jobs nj ON nj.task_id = t.id
         LEFT JOIN task_events te ON te.task_id = t.id
        WHERE t.id = $1
        GROUP BY t.id`,
      [taskId]
    );
    expect(state.rows[0]).toEqual({
      status: "archived",
      completed: "2",
      jobs: "1",
      archive_events: "1"
    });
  });

  it("returns not-found errors for missing tasks and users", async () => {
    const taskId = await createTask();

    const missingTask = await request(app)
      .post("/tasks/999999/assign")
      .send({ userIds: [1] })
      .expect(404);
    expect(missingTask.body.error.code).toBe("TASK_NOT_FOUND");

    const missingUser = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .send({ userId: 999999 })
      .expect(404);
    expect(missingUser.body.error.code).toBe("USER_NOT_FOUND");
  });
});

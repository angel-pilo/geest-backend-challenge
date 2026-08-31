import request from "supertest";
import { createApp } from "../../src/app";
import { closePool, query } from "../../src/database/pool";

describe("task query endpoints", () => {
  const app = createApp();

  beforeEach(async () => {
    await query("TRUNCATE users, tasks CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("creates an open task with an optional description", async () => {
    const response = await request(app)
      .post("/tasks")
      .send({ title: " Prepare report ", description: " Quarterly results " })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(Number),
      title: "Prepare report",
      description: "Quarterly results",
      status: "open",
      archivedAt: null,
      createdAt: expect.any(String)
    });
  });

  it.each([{}, { description: "Missing title" }, { title: "" }])(
    "rejects invalid task data",
    async (body) => {
      const response = await request(app).post("/tasks").send(body).expect(400);
      expect(response.body).toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid task data" }
      });
    }
  );

  it("filters tasks by status and reports assigned-user completion", async () => {
    const user = await query<{ id: string }>(
      "INSERT INTO users (name, last_name, email) VALUES ('Ana', 'López', 'ana@example.com') RETURNING id"
    );
    const openTask = await query<{ id: string }>(
      "INSERT INTO tasks (title) VALUES ('Open task') RETURNING id"
    );
    await query(
      "INSERT INTO task_assignments (task_id, user_id, completed_at) VALUES ($1, $2, NOW())",
      [openTask.rows[0]?.id, user.rows[0]?.id]
    );
    await query(
      "INSERT INTO tasks (title, status, archived_at) VALUES ('Archived task', 'archived', NOW())"
    );

    const response = await request(app).get("/tasks?status=open").expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: Number(openTask.rows[0]?.id),
      title: "Open task",
      status: "open",
      assignedUsers: [
        {
          id: Number(user.rows[0]?.id),
          completed: true,
          completedAt: expect.any(String)
        }
      ]
    });
  });

  it("rejects an unsupported status filter", async () => {
    const response = await request(app).get("/tasks?status=pending").expect(400);
    expect(response.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid task status" }
    });
  });

  it("returns complete task information", async () => {
    const task = await query<{ id: string }>(
      "INSERT INTO tasks (title, description) VALUES ('Task', 'Details') RETURNING id"
    );

    const response = await request(app).get(`/tasks/${task.rows[0]?.id}`).expect(200);

    expect(response.body).toEqual({
      id: Number(task.rows[0]?.id),
      title: "Task",
      description: "Details",
      status: "open",
      archivedAt: null,
      createdAt: expect.any(String),
      assignedUsers: []
    });
  });

  it("returns TASK_NOT_FOUND for an unknown task", async () => {
    const response = await request(app).get("/tasks/999999").expect(404);
    expect(response.body).toEqual({
      error: { code: "TASK_NOT_FOUND", message: "Task not found" }
    });
  });

  it("lists all tasks assigned to a user with their completion state", async () => {
    const user = await query<{ id: string }>(
      "INSERT INTO users (name, last_name, email) VALUES ('Ana', 'López', 'ana@example.com') RETURNING id"
    );
    const task = await query<{ id: string }>(
      "INSERT INTO tasks (title) VALUES ('Assigned task') RETURNING id"
    );
    await query("INSERT INTO task_assignments (task_id, user_id) VALUES ($1, $2)", [
      task.rows[0]?.id,
      user.rows[0]?.id
    ]);

    const response = await request(app)
      .get(`/users/${user.rows[0]?.id}/tasks`)
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        id: Number(task.rows[0]?.id),
        title: "Assigned task",
        completed: false,
        completedAt: null
      })
    ]);
  });

  it("returns USER_NOT_FOUND when listing tasks for an unknown user", async () => {
    const response = await request(app).get("/users/999999/tasks").expect(404);
    expect(response.body).toEqual({
      error: { code: "USER_NOT_FOUND", message: "User not found" }
    });
  });
});

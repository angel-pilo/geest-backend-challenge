import request from "supertest";
import { createApp } from "../../src/app";
import { closePool, query } from "../../src/database/pool";

describe("task activity history", () => {
  const app = createApp();

  beforeEach(async () => {
    await query("TRUNCATE idempotency_requests, users, tasks CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("records creation, effective assignments, completions and one archive", async () => {
    const user = await request(app)
      .post("/users")
      .send({ name: "Ana", lastName: "López", email: "ana@example.com" })
      .expect(201);
    const task = await request(app)
      .post("/tasks")
      .set("Idempotency-Key", "history-create")
      .send({ title: "Tarea con historial" })
      .expect(201);

    await request(app)
      .post(`/tasks/${task.body.id}/assign`)
      .send({ userIds: [user.body.id] })
      .expect(200);
    await request(app)
      .post(`/tasks/${task.body.id}/assign`)
      .send({ userIds: [user.body.id] })
      .expect(200);
    await request(app)
      .post(`/tasks/${task.body.id}/complete`)
      .send({ userId: user.body.id })
      .expect(200);
    await request(app)
      .post(`/tasks/${task.body.id}/complete`)
      .send({ userId: user.body.id })
      .expect(200);

    const response = await request(app).get(`/tasks/${task.body.id}/history`).expect(200);

    expect(response.body.taskId).toBe(task.body.id);
    expect(response.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "task_created",
      "users_assigned",
      "user_completed",
      "task_archived"
    ]);
    expect(response.body.events[1]).toMatchObject({
      userId: null,
      metadata: { userIds: [user.body.id] }
    });
    expect(response.body.events[2]).toMatchObject({ userId: user.body.id });
    expect(response.body.events[3].metadata.archivedAt).toEqual(expect.any(String));
  });

  it("does not duplicate creation history when an idempotent request is replayed", async () => {
    const body = { title: "Creación única" };
    await request(app).post("/tasks").set("Idempotency-Key", "one-history").send(body).expect(201);
    const replay = await request(app)
      .post("/tasks")
      .set("Idempotency-Key", "one-history")
      .send(body)
      .expect(201);

    const events = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM task_events WHERE task_id = $1",
      [replay.body.id]
    );
    expect(events.rows[0]?.count).toBe("1");
  });

  it("returns TASK_NOT_FOUND for unknown history", async () => {
    const response = await request(app).get("/tasks/999999/history").expect(404);
    expect(response.body).toEqual({
      error: { code: "TASK_NOT_FOUND", message: "Task not found" }
    });
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { closePool, query } from "../../src/database/pool";

describe("POST idempotency", () => {
  const app = createApp();

  beforeEach(async () => {
    await query("TRUNCATE idempotency_requests, users, tasks CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  const userBody = {
    name: "Angel",
    lastName: "Aceves",
    email: "angel@example.com"
  };

  it("replays the identical response for sequential duplicate requests", async () => {
    const first = await request(app)
      .post("/users")
      .set("Idempotency-Key", "sequential-user")
      .send(userBody);
    const second = await request(app)
      .post("/users")
      .set("Idempotency-Key", "sequential-user")
      .send(userBody);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const users = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
    expect(users.rows[0]?.count).toBe("1");
  });

  it("executes parallel duplicate requests exactly once", async () => {
    const calls = Array.from({ length: 8 }, () =>
      request(app)
        .post("/users")
        .set("Idempotency-Key", "parallel-user")
        .send(userBody)
    );

    const responses = await Promise.all(calls);

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const response of responses) {
      expect(response.body).toEqual(responses[0]?.body);
    }
    const users = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
    const requests = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM idempotency_requests"
    );
    expect(users.rows[0]?.count).toBe("1");
    expect(requests.rows[0]?.count).toBe("1");
  });

  it("returns IDEMPOTENCY_CONFLICT when the same key has a different body", async () => {
    await request(app)
      .post("/users")
      .set("Idempotency-Key", "conflicting-user")
      .send(userBody)
      .expect(201);

    const response = await request(app)
      .post("/users")
      .set("Idempotency-Key", "conflicting-user")
      .send({ ...userBody, email: "different@example.com" })
      .expect(409);

    expect(response.body).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key was already used with a different request body"
      }
    });
  });

  it("scopes a key to the concrete method and route", async () => {
    const user = await query<{ id: string }>(
      "INSERT INTO users (name, last_name, email) VALUES ('Test', 'User', 'test@example.com') RETURNING id"
    );
    const tasks = await query<{ id: string }>(
      "INSERT INTO tasks (title) VALUES ('First'), ('Second') RETURNING id"
    );
    const userId = Number(user.rows[0]?.id);

    for (const task of tasks.rows) {
      await request(app)
        .post(`/tasks/${task.id}/assign`)
        .set("Idempotency-Key", "same-key-different-task")
        .send({ userIds: [userId] })
        .expect(200);
    }

    const assignments = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM task_assignments"
    );
    expect(assignments.rows[0]?.count).toBe("2");
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { closePool, query } from "../../src/database/pool";

describe("user endpoints", () => {
  const app = createApp();

  beforeEach(async () => {
    await query("TRUNCATE users CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("creates a user and returns its generated ID", async () => {
    const response = await request(app)
      .post("/users")
      .send({ name: " Angel ", lastName: " Aceves ", email: "angel@example.com" })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(Number),
      name: "Angel",
      lastName: "Aceves",
      email: "angel@example.com"
    });
  });

  it.each([
    [{ lastName: "Aceves", email: "angel@example.com" }],
    [{ name: "Angel", email: "angel@example.com" }],
    [{ name: "Angel", lastName: "Aceves" }],
    [{ name: "Angel", lastName: "Aceves", email: "not-an-email" }]
  ])("rejects invalid user data", async (body) => {
    const response = await request(app).post("/users").send(body).expect(400);

    expect(response.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid user data"
      }
    });
  });

  it("lists users with only their pending open tasks", async () => {
    const user = await query<{ id: string }>(
      `INSERT INTO users (name, last_name, email)
       VALUES ('Angel', 'Aceves', 'angel@example.com')
       RETURNING id`
    );
    const task = await query<{ id: string }>(
      `INSERT INTO tasks (title, description)
       VALUES ('Tarea pendiente', 'Aún abierta')
       RETURNING id`
    );
    await query(
      `INSERT INTO task_assignments (task_id, user_id)
       VALUES ($1, $2)`,
      [task.rows[0]?.id, user.rows[0]?.id]
    );

    const response = await request(app).get("/users").expect(200);

    expect(response.body).toEqual([
      {
        id: Number(user.rows[0]?.id),
        name: "Angel",
        lastName: "Aceves",
        email: "angel@example.com",
        pendingTasks: [
          {
            id: Number(task.rows[0]?.id),
            title: "Tarea pendiente",
            description: "Aún abierta",
            status: "open",
            assignedAt: expect.any(String)
          }
        ]
      }
    ]);
  });
});

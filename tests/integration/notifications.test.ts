import { AddressInfo } from "node:net";
import { createServer, Server } from "node:http";
import request from "supertest";
import { createApp } from "../../src/app";
import { resetEnvForTests } from "../../src/config/env";
import { closePool, query } from "../../src/database/pool";
import { processNextNotificationJob } from "../../src/modules/notifications/notification.worker";

type ServerMode = "success" | "server-error" | "client-error" | "timeout" | "fail-once";

describe("reliable task notifications", () => {
  const app = createApp();
  let server: Server;
  let mode: ServerMode = "success";
  let receivedBodies: unknown[] = [];

  beforeAll(async () => {
    server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (mode === "timeout") return;
        if (mode === "client-error") {
          outgoing.writeHead(400).end();
          return;
        }
        if (mode === "server-error" || (mode === "fail-once" && receivedBodies.length === 1)) {
          outgoing.writeHead(503).end();
          return;
        }
        outgoing.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.NOTIFY_URL = `http://127.0.0.1:${address.port}/notify`;
    process.env.NOTIFY_TIMEOUT_MS = "150";
    process.env.NOTIFY_RETRY_BASE_MS = "2";
    resetEnvForTests();
  });

  beforeEach(async () => {
    await query("TRUNCATE users, tasks CASCADE");
    receivedBodies = [];
    mode = "success";
  });

  afterAll(async () => {
    await closePool();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  async function createJob(): Promise<{ taskId: number; jobId: number }> {
    const result = await query<{ task_id: string; job_id: string }>(
      `WITH task AS (
         INSERT INTO tasks (title, status, archived_at)
         VALUES ('Notify customer', 'archived', NOW())
         RETURNING id
       )
       INSERT INTO notification_jobs (task_id)
       SELECT id FROM task
       RETURNING task_id, id AS job_id`
    );
    return {
      taskId: Number(result.rows[0]?.task_id),
      jobId: Number(result.rows[0]?.job_id)
    };
  }

  async function waitUntilDue(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 8));
  }

  it("posts the required payload and records a successful attempt", async () => {
    const { taskId, jobId } = await createJob();

    await expect(processNextNotificationJob()).resolves.toBe(true);

    const job = await query<{ status: string; attempt_count: number; last_error: string | null }>(
      "SELECT status, attempt_count, last_error FROM notification_jobs WHERE id = $1",
      [jobId]
    );
    expect(job.rows[0]).toEqual({ status: "succeeded", attempt_count: 1, last_error: null });
    expect(receivedBodies).toEqual([
      { taskId, title: "Notify customer", archivedAt: expect.any(String) }
    ]);
  });

  it("retries a 5xx response and succeeds on the next attempt", async () => {
    mode = "fail-once";
    const { jobId } = await createJob();

    await processNextNotificationJob();
    await waitUntilDue();
    await processNextNotificationJob();

    const job = await query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_jobs WHERE id = $1",
      [jobId]
    );
    expect(job.rows[0]).toEqual({ status: "succeeded", attempt_count: 2 });
    expect(receivedBodies).toHaveLength(2);
  });

  it("stops after three 5xx attempts", async () => {
    mode = "server-error";
    const { jobId } = await createJob();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await waitUntilDue();
      await expect(processNextNotificationJob()).resolves.toBe(true);
    }

    const job = await query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_jobs WHERE id = $1",
      [jobId]
    );
    const attempts = await query<{ attempt_number: number; http_status: number }>(
      "SELECT attempt_number, http_status FROM notification_attempts WHERE job_id = $1 ORDER BY attempt_number",
      [jobId]
    );
    expect(job.rows[0]).toEqual({ status: "failed", attempt_count: 3 });
    expect(attempts.rows).toEqual([
      { attempt_number: 1, http_status: 503 },
      { attempt_number: 2, http_status: 503 },
      { attempt_number: 3, http_status: 503 }
    ]);
  });

  it("records a 4xx response without retrying", async () => {
    mode = "client-error";
    const { jobId } = await createJob();

    await processNextNotificationJob();
    await waitUntilDue();
    await expect(processNextNotificationJob()).resolves.toBe(false);

    const job = await query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_jobs WHERE id = $1",
      [jobId]
    );
    expect(job.rows[0]).toEqual({ status: "failed", attempt_count: 1 });
    expect(receivedBodies).toHaveLength(1);
  });

  it("retries timeouts three times and records a null HTTP status", async () => {
    mode = "timeout";
    const { jobId } = await createJob();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await waitUntilDue();
      await processNextNotificationJob();
    }

    const attempts = await query<{ http_status: number | null }>(
      "SELECT http_status FROM notification_attempts WHERE job_id = $1 ORDER BY attempt_number",
      [jobId]
    );
    expect(attempts.rows).toEqual([
      { http_status: null },
      { http_status: null },
      { http_status: null }
    ]);
  });

  it("retries connection errors up to three attempts", async () => {
    const unusedServer = createServer();
    await new Promise<void>((resolve) => unusedServer.listen(0, "127.0.0.1", resolve));
    const unusedPort = (unusedServer.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      unusedServer.close((error) => (error ? reject(error) : resolve()))
    );
    const activeUrl = process.env.NOTIFY_URL;
    process.env.NOTIFY_URL = `http://127.0.0.1:${unusedPort}/notify`;
    resetEnvForTests();
    const { jobId } = await createJob();

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await waitUntilDue();
        await processNextNotificationJob();
      }
    } finally {
      process.env.NOTIFY_URL = activeUrl;
      resetEnvForTests();
    }

    const job = await query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_jobs WHERE id = $1",
      [jobId]
    );
    const attempts = await query<{ http_status: number | null }>(
      "SELECT http_status FROM notification_attempts WHERE job_id = $1 ORDER BY attempt_number",
      [jobId]
    );
    expect(job.rows[0]).toEqual({ status: "failed", attempt_count: 3 });
    expect(attempts.rows).toEqual([
      { http_status: null },
      { http_status: null },
      { http_status: null }
    ]);
  });

  it("exposes all recorded attempts through the required endpoint", async () => {
    mode = "server-error";
    const { taskId } = await createJob();
    await processNextNotificationJob();
    await waitUntilDue();
    await processNextNotificationJob();

    const response = await request(app).get(`/tasks/${taskId}/notifications`).expect(200);

    expect(response.body).toEqual({
      taskId,
      status: "pending",
      attempts: [
        {
          attemptNumber: 1,
          attemptedAt: expect.any(String),
          httpStatus: 503,
          errorMessage: "Notification endpoint returned HTTP 503"
        },
        {
          attemptNumber: 2,
          attemptedAt: expect.any(String),
          httpStatus: 503,
          errorMessage: "Notification endpoint returned HTTP 503"
        }
      ]
    });
  });
});

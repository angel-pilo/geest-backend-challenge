import { getEnv } from "../../config/env";
import { query, withTransaction } from "../../database/pool";

interface ClaimedJob {
  id: string;
  task_id: string;
  title: string;
  archived_at: string;
  attempt_count: number;
}

interface DeliveryResult {
  httpStatus: number | null;
  errorMessage: string | null;
  retryable: boolean;
  succeeded: boolean;
}

async function claimJob(): Promise<ClaimedJob | undefined> {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedJob>(
      `SELECT nj.id, nj.task_id, nj.attempt_count, t.title, t.archived_at
         FROM notification_jobs nj
         JOIN tasks t ON t.id = nj.task_id
        WHERE nj.attempt_count < 3
          AND (
            (nj.status = 'pending' AND nj.next_attempt_at <= NOW())
            OR (nj.status = 'processing' AND nj.updated_at <= NOW() - INTERVAL '30 seconds')
          )
        ORDER BY nj.next_attempt_at, nj.id
        FOR UPDATE OF nj SKIP LOCKED
        LIMIT 1`
    );
    const job = result.rows[0];
    if (!job) {
      return undefined;
    }
    await client.query(
      "UPDATE notification_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1",
      [job.id]
    );
    return job;
  });
}

async function deliver(job: ClaimedJob): Promise<DeliveryResult> {
  const env = getEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.NOTIFY_TIMEOUT_MS);

  try {
    const response = await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: Number(job.task_id),
        title: job.title,
        archivedAt: job.archived_at
      }),
      signal: controller.signal
    });
    await response.arrayBuffer();

    if (response.status >= 200 && response.status < 300) {
      return { httpStatus: response.status, errorMessage: null, retryable: false, succeeded: true };
    }

    return {
      httpStatus: response.status,
      errorMessage: `Notification endpoint returned HTTP ${response.status}`,
      retryable: response.status >= 500,
      succeeded: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification request failed";
    return { httpStatus: null, errorMessage: message, retryable: true, succeeded: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordAttempt(job: ClaimedJob, result: DeliveryResult, attemptedAt: Date): Promise<void> {
  const attemptNumber = job.attempt_count + 1;
  const shouldRetry = result.retryable && attemptNumber < 3;
  const retryDelay = getEnv().NOTIFY_RETRY_BASE_MS * 2 ** (attemptNumber - 1);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO notification_attempts
         (job_id, attempt_number, attempted_at, http_status, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [job.id, attemptNumber, attemptedAt, result.httpStatus, result.errorMessage]
    );

    if (result.succeeded) {
      await client.query(
        `UPDATE notification_jobs
            SET status = 'succeeded', attempt_count = $2, last_error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [job.id, attemptNumber]
      );
      return;
    }

    if (shouldRetry) {
      await client.query(
        `UPDATE notification_jobs
            SET status = 'pending',
                attempt_count = $2,
                next_attempt_at = NOW() + ($3 * INTERVAL '1 millisecond'),
                last_error = $4,
                updated_at = NOW()
          WHERE id = $1`,
        [job.id, attemptNumber, retryDelay, result.errorMessage]
      );
      return;
    }

    await client.query(
      `UPDATE notification_jobs
          SET status = 'failed', attempt_count = $2, last_error = $3, updated_at = NOW()
        WHERE id = $1`,
      [job.id, attemptNumber, result.errorMessage]
    );
  });
}

export async function processNextNotificationJob(): Promise<boolean> {
  const job = await claimJob();
  if (!job) {
    return false;
  }

  const attemptedAt = new Date();
  const result = await deliver(job);
  await recordAttempt(job, result, attemptedAt);
  return true;
}

export function startNotificationWorker(): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (await processNextNotificationJob()) {
        // Drain all work that is currently due.
      }
    } catch (error) {
      console.error("Notification worker failed", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), getEnv().NOTIFICATION_POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

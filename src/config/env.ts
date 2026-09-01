import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanFromString,
  NOTIFY_URL: z.url(),
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NOTIFY_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000)
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid environment configuration: ${details}`);
    }
    cachedEnv = result.data;
  }
  return cachedEnv;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}

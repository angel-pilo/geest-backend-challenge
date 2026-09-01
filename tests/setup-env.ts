process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://geest:geest@localhost:5432/geest";
process.env.DATABASE_SSL ??= "false";
process.env.NOTIFY_URL ??= "http://127.0.0.1:3999/notify";
process.env.NOTIFY_TIMEOUT_MS ??= "50";
process.env.NOTIFY_RETRY_BASE_MS ??= "1";
process.env.NOTIFICATION_POLL_INTERVAL_MS ??= "10";

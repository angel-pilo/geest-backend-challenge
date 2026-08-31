process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://geest:geest@localhost:5432/geest";
process.env.DATABASE_SSL ??= "false";
process.env.NOTIFY_URL ??= "http://127.0.0.1:3999/notify";

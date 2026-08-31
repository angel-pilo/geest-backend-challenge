import express, { Express } from "express";
import { errorHandler } from "./common/middleware/error-handler";
import { notFoundHandler } from "./common/middleware/not-found";
import { tasksRouter } from "./modules/tasks/tasks.routes";
import { usersRouter } from "./modules/users/users.routes";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.use("/users", usersRouter);
  app.use("/tasks", tasksRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

import { ErrorRequestHandler } from "express";
import { ApiError } from "../errors/api-error";

type ErrorWithStatus = Error & { status?: number };

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  const status = (error as ErrorWithStatus).status === 400 ? 400 : 500;
  response.status(status).json({
    error: {
      code: status === 400 ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR",
      message: status === 400 ? "Request body contains invalid JSON" : "Internal server error"
    }
  });
};

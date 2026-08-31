import { ApiError } from "../../src/common/errors/api-error";

describe("ApiError", () => {
  it("keeps the HTTP status, code and message", () => {
    const error = new ApiError(404, "TASK_NOT_FOUND", "Task not found");

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("TASK_NOT_FOUND");
    expect(error.message).toBe("Task not found");
  });
});

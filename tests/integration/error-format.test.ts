import request from "supertest";
import { createApp } from "../../src/app";

describe("error response format", () => {
  const app = createApp();

  it("returns the required structure for an unknown route", async () => {
    const response = await request(app).get("/unknown").expect(404);

    expect(response.body).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found"
      }
    });
  });

  it("returns the required structure for malformed JSON", async () => {
    const response = await request(app)
      .post("/users")
      .set("Content-Type", "application/json")
      .send('{"name":')
      .expect(400);

    expect(response.body).toEqual({
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON"
      }
    });
  });
});

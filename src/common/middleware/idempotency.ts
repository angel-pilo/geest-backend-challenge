import { createHash } from "node:crypto";
import { Request, RequestHandler } from "express";
import { PoolClient } from "pg";
import { ApiError } from "../errors/api-error";
import { getPool } from "../../database/pool";
import { StoredResponse } from "../../domain/contracts";

type IdempotentOperation = (request: Request, client: PoolClient) => Promise<StoredResponse>;

interface StoredRequestRow {
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}

export function idempotent(operation: IdempotentOperation): RequestHandler {
  return async (request, response, next) => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const key = request.get("Idempotency-Key");
      let method = "";
      let route = "";
      let requestHash = "";

      if (key !== undefined) {
        if (key.trim().length === 0 || key.length > 255) {
          throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Invalid Idempotency-Key header");
        }

        method = request.method.toUpperCase();
        route = `${request.baseUrl}${request.path}`;
        requestHash = hashBody(request.body);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${method}:${route}:${key}`]
        );

        const stored = await client.query<StoredRequestRow>(
          `SELECT request_hash, response_status, response_body
             FROM idempotency_requests
            WHERE idempotency_key = $1 AND method = $2 AND route = $3`,
          [key, method, route]
        );
        const storedRow = stored.rows[0];
        if (storedRow) {
          if (storedRow.request_hash !== requestHash) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different request body"
            );
          }
          await client.query("COMMIT");
          response.status(storedRow.response_status).json(storedRow.response_body);
          return;
        }
      }

      const result = await operation(request, client);
      if (key !== undefined) {
        await client.query(
          `INSERT INTO idempotency_requests
             (idempotency_key, method, route, request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [key, method, route, requestHash, result.statusCode, result.body]
        );
      }
      await client.query("COMMIT");
      response.status(result.statusCode).json(result.body);
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  };
}

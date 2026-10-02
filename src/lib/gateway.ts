import { z } from "zod";

const gatewayResponseSchema = z.object({
  ok: z.boolean(),
  code: z.string().nullish(),
  message: z.string().nullish(),
  data: z.unknown().optional(),
});

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function mutateSheet(
  operation: string,
  payload: Record<string, unknown>,
) {
  const url = process.env.APPS_SCRIPT_GATEWAY_URL;
  const secret = process.env.APPS_SCRIPT_GATEWAY_SECRET;

  if (!url || !secret) {
    throw new GatewayError(
      "The booking service has not been configured yet.",
      503,
      "NOT_CONFIGURED",
    );
  }
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Invalid transport");
  } catch {
    throw new GatewayError("The club gateway requires a valid HTTPS URL.", 503, "NOT_CONFIGURED");
  }

  let response: Response;
  let body: unknown;
  try {
    response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...payload, operation, secret, spreadsheetId: process.env.GOOGLE_SHEET_ID }),
    });
    body = await response.json();
  } catch {
    throw new GatewayError("The club service is unavailable. Please retry the same request.", 503, "UNAVAILABLE");
  }
  const parsed = gatewayResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw new GatewayError("The booking service returned an invalid response.", 502);
  }
  if (!response.ok || !parsed.data.ok) {
    throw new GatewayError(
      parsed.data.message ?? "The booking service rejected this request.",
      response.ok ? gatewayStatus(parsed.data.code) : (response.status >= 400 ? response.status : 502),
      parsed.data.code ?? undefined,
    );
  }
  return parsed.data.data;
}

export function gatewayStatus(code?: string | null): number {
  if (code === "UNAUTHORIZED") return 401;
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "RATE_LIMITED") return 429;
  if (["NOT_CONFIGURED", "LOCK_TIMEOUT", "UNAVAILABLE", "RECOVERY_REQUIRED", "MIGRATION_REQUIRED", "STORAGE_LIMIT", "AUTH_UNAVAILABLE"].includes(code ?? "")) return 503;
  if (["STALE_VERSION", "DUPLICATE_BOOKING", "PUBLISHED_RUN_EXISTS", "IDEMPOTENCY_CONFLICT", "REQUEST_ID_REUSED", "WEEK_EXISTS"].includes(code ?? "")) return 409;
  if (["INTERNAL_ERROR", "INVALID_SCHEMA", "STATE_CORRUPT"].includes(code ?? "")) return 502;
  return 400;
}

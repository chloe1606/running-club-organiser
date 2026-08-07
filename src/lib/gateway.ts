import { z } from "zod";

const gatewayResponseSchema = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
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

  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ operation, secret, ...payload }),
  });
  const parsed = gatewayResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new GatewayError("The booking service returned an invalid response.", 502);
  }
  if (!response.ok || !parsed.data.ok) {
    throw new GatewayError(
      parsed.data.message ?? "The booking service rejected this request.",
      response.status || 502,
      parsed.data.code,
    );
  }
  return parsed.data.data;
}

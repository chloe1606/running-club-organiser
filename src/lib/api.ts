import { NextResponse } from "next/server";
import { GatewayError } from "./gateway";
import { mutationSchema } from "./platform-schema";
import { executeMutation, getPlatformSnapshot } from "./platform";

export function errorResponse(error: unknown) {
  if (error instanceof GatewayError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ message: "The club service is unavailable. No demo data has been substituted." }, { status: 503 });
}

export function sameOrigin(request: Request) {
  try {
    const expected = new URL(process.env.NEXTAUTH_URL ?? request.url);
    if (!["https:", "http:"].includes(expected.protocol) || expected.username || expected.password) return false;
    return request.headers.get("origin") === expected.origin &&
      request.headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}

export async function handleMutation(request: Request, operation?: string) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 16_000) return NextResponse.json({ message: "Request is too large." }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ message: "Invalid JSON." }, { status: 400 }); }
    const parsed = mutationSchema.safeParse(operation && body && typeof body === "object" ? { ...body, operation } : body);
    if (!parsed.success) return NextResponse.json({ message: "Invalid club request." }, { status: 400 });
    const data = await executeMutation(parsed.data);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 409) {
      try {
        const data = await getPlatformSnapshot();
        return NextResponse.json({ message: error.message, code: error.code, data }, { status: 409 });
      } catch { /* Preserve the original conflict if refreshing is unavailable. */ }
    }
    return errorResponse(error);
  }
}

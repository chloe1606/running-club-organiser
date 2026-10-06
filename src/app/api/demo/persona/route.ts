import { NextResponse } from "next/server";
import { demoEnabled } from "@/lib/platform";
import { sameOrigin } from "@/lib/api";

export async function POST(request: Request) {
  if (!demoEnabled()) return NextResponse.json({ message: "Demo mode is disabled." }, { status: 404 });
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  const text = await request.text();
  if (text.length > 1000) return NextResponse.json({ message: "Request is too large." }, { status: 413 });
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || !["runner", "leader", "admin"].includes(body.persona)) return NextResponse.json({ message: "Choose a demo persona." }, { status: 400 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("demo-persona", body.persona, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  return response;
}

import { NextResponse } from "next/server";
import { errorResponse, sameOrigin } from "../../../../../lib/api";
import { previewWeeklyLeaderImport } from "../../../../../lib/platform";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  try {
    return NextResponse.json({ data: await previewWeeklyLeaderImport() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
import { NextResponse } from "next/server";
import { getPlatformSnapshot } from "@/lib/platform";
import { errorResponse, handleMutation } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ data: await getPlatformSnapshot() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) { return handleMutation(request); }

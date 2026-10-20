import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, sameOrigin } from "../../../../../lib/api";
import { inviteClubMember } from "../../../../../lib/member-invitations";

const invitationSchema = z.object({ memberId: z.string().min(1).max(120) });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 1_000) return NextResponse.json({ message: "Request is too large." }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ message: "Invalid JSON." }, { status: 400 }); }
    const parsed = invitationSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ message: "Invalid invitation request." }, { status: 400 });
    return NextResponse.json({ invitation: await inviteClubMember(parsed.data.memberId) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

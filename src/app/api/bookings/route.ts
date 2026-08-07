import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { mutateSheet, GatewayError } from "@/lib/gateway";

const bookingSchema = z.object({
  runId: z.string().min(1),
  groupId: z.string().min(1),
  runVersion: z.number().int().nonnegative(),
  groupVersion: z.number().int().nonnegative(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ message: "Sign in to book a run." }, { status: 401 });
  }

  const parsed = bookingSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ message: "Invalid booking request." }, { status: 400 });
  }

  try {
    const data = await mutateSheet("book", { email, ...parsed.data });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof GatewayError) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
}

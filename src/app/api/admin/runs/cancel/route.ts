import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { GatewayError, mutateSheet } from "@/lib/gateway";

const cancellationSchema = z.object({
  runId: z.string().min(1),
  runVersion: z.number().int().nonnegative(),
  cancellationReason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ message: "Sign in as an administrator." }, { status: 401 });
  }
  const parsed = cancellationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ message: "Provide a cancellation reason." }, { status: 400 });
  }
  try {
    const data = await mutateSheet("cancelRun", { email, ...parsed.data });
    return NextResponse.json({ data });
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

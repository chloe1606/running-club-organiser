import { handleMutation } from "@/lib/api";

export async function POST(request: Request) { return handleMutation(request, "book"); }

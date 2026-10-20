"use client";

import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";

export function SignIn() {
  return <Link href="/sign-in">Sign In</Link>;
}

export function SignOut() {
  return <SignOutButton redirectUrl="/"><button type="button">Sign Out</button></SignOutButton>;
}

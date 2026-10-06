"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";

export function SignIn() {
  return <Link href="/auth/signin">Sign In</Link>;
}

export function SignOut() {
  return <button type="button" onClick={() => void signOut({ callbackUrl: "/" })}>Sign Out</button>;
}

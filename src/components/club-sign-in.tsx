"use client";

import { SignIn, useAuth } from "@clerk/nextjs";
import { RunningLoader } from "./running-loader";

export function ClubSignIn() {
  const { isSignedIn } = useAuth();
  return <div className="club-sign-in" data-signed-in={isSignedIn ? "true" : "false"}>
    <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/"
      fallback={<RunningLoader message="Loading sign-in..." />}
      appearance={{ elements: { headerTitle: { fontSize: "1.25rem", lineHeight: "1.4" } } }} />
    <div className="sign-in-progress"><RunningLoader message={isSignedIn ? "Loading your club runs..." : "Signing you in..."} /></div>
  </div>;
}

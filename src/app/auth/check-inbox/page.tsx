import { redirect } from "next/navigation";

export default function LegacyCheckInboxPage() {
  redirect("/sign-in");
}

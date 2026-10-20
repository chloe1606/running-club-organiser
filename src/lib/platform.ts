import { cookies } from "next/headers";
import { getClubMember } from "./auth";
import { GatewayError, mutateSheet } from "./gateway";
import { getDemoSnapshot, mutateDemo } from "./demo-store";
import { snapshotSchema, weeklyLeaderImportPreviewSchema, type ClubMutation } from "./platform-schema";
import { visibleSnapshot } from "./privacy";
import type { PlatformSnapshot, WeeklyLeaderImportPreview } from "./platform-types";

export function demoEnabled() {
  return process.env.CLUB_DEMO_MODE === "true";
}

async function demoPersona() {
  return (await cookies()).get("demo-persona")?.value ?? "runner";
}

export async function getPlatformSnapshot(): Promise<PlatformSnapshot> {
  if (demoEnabled()) {
    const snapshot = getDemoSnapshot(await demoPersona());
    return visibleSnapshot(snapshot, snapshot.currentMemberId);
  }
  const identity = await getClubMember();
  return snapshotForIdentity(identity);
}

async function snapshotForIdentity(identity: Awaited<ReturnType<typeof getClubMember>>): Promise<PlatformSnapshot> {
  const email = identity?.email;
  const data = await mutateSheet("snapshot", { email });
  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) throw new GatewayError("The club workbook schema is invalid. Contact an administrator.", 502, "INVALID_SCHEMA");
  const member = parsed.data.members.find((candidate) => candidate.active && candidate.id === identity?.memberId &&
    candidate.email.trim().toLowerCase() === email);
  return visibleSnapshot(parsed.data, member?.id);
}

export async function executeMutation(mutation: ClubMutation): Promise<PlatformSnapshot> {
  if (demoEnabled()) {
    if (mutation.operation === "importWeeklyLeaders") throw new GatewayError("Weekly leader imports are unavailable in demo mode.", 400, "INVALID_REQUEST");
    const snapshot = mutateDemo(mutation.operation, mutation, await demoPersona());
    return visibleSnapshot(snapshot, snapshot.currentMemberId);
  }
  const member = await getClubMember();
  if (!member) throw new GatewayError("Sign in to continue.", 401, "UNAUTHORIZED");
  const adminOperations = ["moveRunner", "addTrialRunner", "createWeek", "updateWeekLocation", "updateWeekTime", "updateWeeklyAutomation", "updateLocations", "publishRun", "cancelRun", "archiveRun", "assignLeader", "addMember", "updateMember", "importWeeklyLeaders", "restoreGroup"];
  if (adminOperations.includes(mutation.operation) && !member.roles.split(",").map((role) => role.trim()).includes("admin")) {
    throw new GatewayError("Administrator access is required.", 403, "FORBIDDEN");
  }
  if (["updateRoute", "assignSweeper", "recordAttendance"].includes(mutation.operation) &&
      !member.roles.split(",").map((role) => role.trim()).includes("admin")) {
    const snapshot = snapshotSchema.safeParse(await mutateSheet("snapshot", { email: member.email }));
    if (!snapshot.success) throw new GatewayError("Invalid club workbook schema.", 502, "INVALID_SCHEMA");
    const groupId = "groupId" in mutation ? mutation.groupId : undefined;
    const group = snapshot.data.groups.find((candidate) => candidate.id === groupId);
    if (!member.roles.split(",").map((role) => role.trim()).includes("leader") || group?.leaderId !== member.memberId) {
      throw new GatewayError("Only the assigned weekly leader may manage this group.", 403, "FORBIDDEN");
    }
  }
  try {
    await mutateSheet(mutation.operation, { ...mutation, email: member.email });
  } catch (error) {
    if (error instanceof GatewayError && error.code === "STALE_IMPORT") throw new GatewayError(error.message, 409, error.code);
    throw error;
  }
  return snapshotForIdentity(member);
}

export async function previewWeeklyLeaderImport(): Promise<WeeklyLeaderImportPreview> {
  if (demoEnabled()) throw new GatewayError("Weekly leader imports are unavailable in demo mode.", 400, "INVALID_REQUEST");
  const member = await getClubMember();
  if (!member) throw new GatewayError("Sign in to continue.", 401, "UNAUTHORIZED");
  if (!member.roles.split(",").map(role => role.trim()).includes("admin")) {
    throw new GatewayError("Administrator access is required.", 403, "FORBIDDEN");
  }
  const parsed = weeklyLeaderImportPreviewSchema.safeParse(await mutateSheet("previewWeeklyLeaders", { email: member.email }));
  if (!parsed.success) throw new GatewayError("Invalid leader import preview.", 502, "INVALID_SCHEMA");
  return parsed.data;
}

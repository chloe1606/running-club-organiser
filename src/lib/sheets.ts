import { google } from "googleapis";
import { z } from "zod";
import { mutateSheet } from "./gateway";

const memberSchema = z.object({
  memberId: z.string().min(1),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  displayName: z.string().min(1),
  roles: z.string(),
  active: z.enum(["TRUE", "FALSE"]),
  version: z.coerce.number().int().nonnegative(),
});

export type Member = z.infer<typeof memberSchema>;

const canonicalMembersSchema = z.object({
  members: z.array(z.object({
    id: z.string().min(1), email: z.string(), name: z.string().min(1),
    roles: z.array(z.enum(["runner", "leader", "sweeper", "admin"])).min(1),
    active: z.boolean(), version: z.number().int().positive(),
  })),
});

export function parseCanonicalMembers(data: unknown): Member[] {
  const { members } = canonicalMembersSchema.parse(data);
  return parseMembers(
    ["memberId", "email", "displayName", "roles", "active", "version"],
    members.map((member) => [member.id, member.email, member.name, member.roles.join(","), member.active, member.version]),
  );
}

export function parseMembers(headers: unknown[], rows: unknown[][]): Member[] {
  const names = headers.map(String);
  const modern = names.includes("Email");
  const required = modern
    ? ["User ID", "Email", "Name", "Role", "Active", "Version"]
    : ["memberId", "email", "displayName", "roles", "active", "version"];
  if (new Set(names).size !== names.length || required.some((header) => !names.includes(header))) {
    throw new Error("The membership sheet headers do not match the required schema.");
  }
  const members = rows.filter((row) => row.some((value) => String(value ?? "").length)).map((row) => {
    const record = Object.fromEntries(names.map((header, index) => [header, row[index] ?? ""]));
    const parsed = memberSchema.parse(modern ? {
      memberId: record["User ID"], email: record.Email, displayName: record.Name,
      roles: record.Role, active: String(record.Active).toUpperCase(), version: record.Version,
    } : { ...record, active: String(record.active).toUpperCase() });
    parsed.email = parsed.email.trim().toLowerCase();
    const roles = parsed.roles.split(",").map((role) => role.trim());
    if (!roles.length || roles.some((role) => !["runner", "leader", "sweeper", "admin"].includes(role))) {
      throw new Error("The membership sheet contains an invalid role.");
    }
    return parsed;
  });
  if (new Set(members.map((member) => member.email)).size !== members.length ||
      new Set(members.map((member) => member.memberId)).size !== members.length) {
    throw new Error("Membership identities must be unique.");
  }
  return members;
}

function configuredAuth() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sheetId || !serviceAccount) {
    throw new Error("Google Sheets read access is not configured.");
  }
  return {
    sheetId,
    auth: new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccount) as Record<string, string>,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    }),
  };
}

export async function readMembers(): Promise<Member[]> {
  const { auth, sheetId } = configuredAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets.properties.title",
  });
  if (metadata.data.sheets?.some((sheet) => sheet.properties?.title === "_PlatformState")) {
    // Read the committed source, not potentially lagging Users projections.
    return parseCanonicalMembers(await mutateSheet("snapshot", {}));
  }
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Members!A:Z",
  });
  const [headers, ...rows] = response.data.values ?? [];
  if (!headers) {
    throw new Error("The Members sheet has no header row.");
  }
  return parseMembers(headers, rows);
}

export async function findActiveMemberByEmail(email: string): Promise<Member | undefined> {
  const members = await readMembers();
  return members.find(
    (member) => member.active === "TRUE" && member.email === email.trim().toLowerCase(),
  );
}

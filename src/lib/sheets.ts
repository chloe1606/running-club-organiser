import { google } from "googleapis";
import { z } from "zod";

const memberSchema = z.object({
  memberId: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1),
  roles: z.string(),
  active: z.enum(["TRUE", "FALSE"]),
  version: z.coerce.number().int().nonnegative(),
});

export type Member = z.infer<typeof memberSchema>;

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
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Members!A:Z",
  });
  const [headers, ...rows] = response.data.values ?? [];
  if (!headers) {
    throw new Error("The Members sheet has no header row.");
  }
  const requiredHeaders = ["memberId", "email", "displayName", "roles", "active", "version"];
  if (requiredHeaders.some((header) => !headers.includes(header))) {
    throw new Error("The Members sheet headers do not match the required schema.");
  }
  return rows.map((row) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    return memberSchema.parse(record);
  });
}

export async function findActiveMemberByEmail(email: string): Promise<Member | undefined> {
  const members = await readMembers();
  return members.find(
    (member) => member.active === "TRUE" && member.email.toLowerCase() === email.toLowerCase(),
  );
}

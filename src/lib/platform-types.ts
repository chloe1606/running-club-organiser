import type { Booking, Group, Run } from "./domain";

export interface ClubMember {
  id: string;
  email: string;
  name: string;
  roles: string[];
  active: boolean;
  version: number;
}

export interface Attendance {
  id: string;
  runId: string;
  groupId: string;
  memberId: string;
  outcome: "present" | "absent";
  recordedAt: string;
}

export interface AuditEvent {
  id: string;
  runId: string;
  groupId?: string;
  memberId?: string;
  actorId: string;
  action: string;
  at: string;
  requestId: string;
  queueSize?: number;
}

export interface ClubConfig {
  location: string;
  locations?: string[];
  locationMaps?: Record<string, string>;
  timeZone: string;
  startTime: string;
  demoConfiguration: boolean;
}

export interface PlatformSnapshot {
  weeks: Run[];
  groups: Group[];
  bookings: Booking[];
  members: ClubMember[];
  attendance: Attendance[];
  audit: AuditEvent[];
  config: ClubConfig;
  demo: boolean;
  currentMemberId?: string;
}

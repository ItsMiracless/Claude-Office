/** staff.d.ts - types for shared/staff.js (the resident staff roster). */

export interface StaffMember {
  /** The subagent_type Claude Code reports for this subagent */
  agentType: string
  /** The name shown in the office */
  name: string
  /** The desk / sprite role it borrows (src/config.ts ROLE_TO_CHAR) */
  role: string
  /** A short job title for its tooltip ("AirBNB") */
  title?: string
  /** A team lead: does rounds of the desks and works by the meeting-room whiteboard */
  manager?: boolean
}

export function normalizeStaffMember(raw: unknown): StaffMember | null
export function staffRoster(setting: unknown, fallback?: unknown[]): StaffMember[]

/**
 * staff.js - the office's resident staff: the owner's own subagents, who are
 * in the office all day whether or not they have work (src/residentStaff.ts).
 *
 * The default roster is shared/resident-staff.json. office.config.json may
 * replace it or switch it off with a `staff` field:
 *
 *   (absent)                          the default roster
 *   "staff": false                    no resident staff
 *   "staff": [ {...}, ... ]           this roster instead
 *   "staff": { "enabled": false }     no resident staff
 *   "staff": { "members": [...] }     this roster instead
 *
 * Each member: { agentType, name, title?, role?, manager? } — `agentType` is
 * the subagent_type Claude Code reports (what a real spawn is matched on),
 * `role` the desk / sprite it borrows (default general-purpose), `title` a
 * short job title for its tooltip, `manager` a team lead who does rounds.
 *
 * Pure: the page (bundled) and the server (GET /config) share it.
 */

const TEXT_MAX = 60

function text(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  return s ? s.slice(0, max) : undefined
}

/**
 * One roster entry, cleaned, or null when it has no usable agentType / name.
 * @param {unknown} raw
 * @returns {import('./staff').StaffMember | null}
 */
export function normalizeStaffMember(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const agentType = text(raw.agentType, 80)
  const name = text(raw.name)
  if (!agentType || !name) return null
  const member = { agentType, name, role: text(raw.role, 40) ?? 'general-purpose' }
  const title = text(raw.title)
  if (title) member.title = title
  if (raw.manager === true) member.manager = true
  return member
}

/**
 * The roster a `staff` setting asks for.
 * @param {unknown} setting office.config.json's `staff` field
 * @param {unknown[]} fallback the default roster (shared/resident-staff.json)
 * @returns {import('./staff').StaffMember[]} [] when switched off; one entry per agentType (first wins)
 */
export function staffRoster(setting, fallback = []) {
  let list = fallback
  if (setting === false) return []
  if (Array.isArray(setting)) list = setting
  else if (setting && typeof setting === 'object') {
    if (setting.enabled === false) return []
    if (Array.isArray(setting.members)) list = setting.members
  }
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const m = normalizeStaffMember(raw)
    if (!m || seen.has(m.agentType)) continue
    seen.add(m.agentType)
    out.push(m)
  }
  return out
}

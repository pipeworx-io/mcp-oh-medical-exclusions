interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Ohio Department of Medicaid (ODM) Provider Exclusion & Suspension List
 * screening — fleet #3278, the seventh state exclusion pack after
 * ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions,
 * fl-medical-exclusions, pa-medical-exclusions and ga-medical-exclusions.
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, Ohio runs its own Medicaid exclusion/suspension list
 * through ODM: individuals and organizations excluded from or currently
 * suspended from Ohio's Medicaid program. This is that list, for Ohio
 * only — one pack per jurisdiction (root CLAUDE.md rule 5).
 *
 * SOURCE AND SHAPE. ODM's "Provider Exclusion & Suspension List" page
 * (medicaid.ohio.gov/resources-for-providers/enrollment-and-support/
 * provider-enrollment/provider-exclusion-and-suspension-list) is the
 * correct, current page — a stale 404 on it from a plain `curl` request is
 * a UA-SNIFFING BLOCK on Ohio's CDN, not a dead page; the identical request
 * with a browser-shaped UA returns 200 (verified live 2026-10-17, see
 * bake-index.mjs for the reproduction). The page links a direct .xlsx on
 * Ohio's asset CDN whose FILENAME embeds the publication date and is not
 * stable, so bake-index.mjs resolves the current link from the listing page
 * every run.
 *
 * Root CLAUDE.md's standing rule 3 still applies: the baked table never
 * sits in gateway module scope. It is baked into src/oh-odm-index-data.ts,
 * registered in workers/gateway/src/pack-baked-indexes.json, uploaded to
 * KV at deploy, and injected here as `args._bakedIndex` — same pattern as
 * the six precedent packs (fleet #2754).
 *
 * TWO SHEETS, ONE UNIFIED SHAPE — ODM publishes this as "Individuals"
 * (1,867 rows at capture: name, DOB, NPI, Provider ID, Status, Action
 * Date, Date Added, Provider Type) and "Organizations" (255 rows: NPI,
 * organization name, address, Provider ID, Status, Action Date, Date
 * Added, Provider Type). Both are baked into one row shape tagged
 * `record_type`.
 *
 * NO HOME ADDRESS, NO DATE OF BIRTH — the Individuals sheet carries DOB and
 * the Organizations sheet carries a full street address; neither is
 * carried into this pack, matching the field set the six precedent state
 * packs serve (none of them serve a street address or a date of birth —
 * see bake-index.mjs).
 *
 * ACTION DATE VS. DATE ADDED — same trap as every precedent pack's
 * effective-date/added-date pair, verified directly: the two dates differ
 * on the large majority of rows that carry both (1,035/1,064 Individuals,
 * 123/133 Organizations). This pack counts by Action Date (when the
 * exclusion/suspension took effect), never Date Added.
 *
 * NPI, PROVIDER ID AND PROVIDER TYPE CAN BE COMMA-JOINED LISTS — some
 * providers are excluded under multiple Medicaid registrations on one row
 * (e.g. NPI "1447317433, 1598934424" with matching Provider ID
 * "2744918, 2798898"). Matching splits on comma and compares each
 * fragment, so a query for either value finds the row.
 *
 * STATUS IS MESSY — currently_excluded IS DERIVED AND LABELLED. ODM's own
 * Status field carries whitespace/case variants and at least one data-entry
 * typo ("susepnded"). This pack trims+lowercases for its own
 * active/inactive classification (Excluded/Suspended -> true; anything
 * else, including the rare "Terminated" or a blank, -> null with
 * status_unknown:true) but serves the status text as published
 * (whitespace-trimmed only).
 *
 * MATCHING MODEL, same discipline as the six precedent packs: an NPI or
 * Provider ID match identifies a specific provider or business (both are
 * exact identifiers ODM assigns/records). A name match — even an exact one
 * — is a CANDIDATE, never an identification: this pack carries no date of
 * birth, and common surnames repeat across ~2,100 rows spanning 2005-2026.
 *
 * Keyless.
 */
import type { OhOdmRow } from './oh-odm-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table is injected by the
// gateway as `args._bakedIndex`, loaded from KV once per isolate. NEVER
// value-import ./oh-odm-index-data.js here — only the type-only import
// above, which is erased at compile time. A value import puts the whole
// table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: OhOdmRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.OH_ODM_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no match found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean screening result.
    throw new Error(
      `oh-medical-exclusions: the baked OH ODM exclusions index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as OhOdmRow[];
  DATA_AS_OF = String(idx?.OH_ODM_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.OH_ODM_SOURCE_URL ?? 'https://medicaid.ohio.gov/resources-for-providers/enrollment-and-support/provider-enrollment/provider-exclusion-and-suspension-list');
  CAPTURED_AT = String(idx?.OH_ODM_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.OH_ODM_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Ohio Department of Medicaid (ODM) — Provider Exclusion & Suspension List';

const ACTIVE_STATUSES = new Set(['excluded', 'suspended']);

const STATUS_CAVEAT =
  'ODM\'s own Status field is mostly "Excluded" or "Suspended" (whitespace/case variants and a rare data-entry typo exist in the live file), but a few rows carry "Terminated" or no status at all. currently_excluded is true only for a recognized Excluded/Suspended status; anything else is reported with currently_excluded:null and status_unknown:true rather than a guess.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart. Only an NPI or Provider ID match identifies a specific provider or business. Confirm a name match against one of those before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function splitList(s: string | null): string[] {
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function fullName(r: OhOdmRow): string {
  const parts = [r.first_name, r.middle_name, r.last_name].filter((p): p is string => Boolean(p));
  return parts.join(' ');
}

function displayName(r: OhOdmRow): string {
  return fullName(r) || r.organization_name || 'Unknown';
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

function currentlyExcluded(status: string | null): boolean | null {
  if (!status) return null;
  const norm = status.trim().toLowerCase();
  if (ACTIVE_STATUSES.has(norm)) return true;
  return null; // neither blindly true nor false — "Terminated"/typos/blank are genuinely ambiguous here
}

type MatchType = 'npi_match' | 'provider_id_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against one of this provider\'s listed NPIs. An NPI identifies one provider, so this is an identification.',
  provider_id_match: 'The Provider ID matched exactly against one of this provider\'s listed Provider IDs (ODM\'s own identifier). This is an identification.',
  name_candidate_exact: 'The name matched exactly (individual name or organization name), but this list has no date of birth to confirm it is the same person or entity — several excluded providers can share a name. Confirm with NPI or Provider ID before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the provider\'s individual name and organization name. Treat as a lead to check, not a finding. Confirm with NPI or Provider ID.',
};

function shape(r: OhOdmRow, matchType: MatchType) {
  const current = currentlyExcluded(r.status);
  return {
    record_type: r.record_type,
    provider_name: displayName(r),
    organization_name: r.organization_name,
    provider_type: r.provider_type,
    npi: r.npi,
    provider_id: r.provider_id,
    status: r.status,
    currently_excluded: current,
    status_unknown: current === null,
    action_date: r.action_date,
    date_added: r.date_added,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const providerIdRaw = typeof args.provider_id === 'string' ? args.provider_id.trim() : '';

  if (!nameRaw && !npiRaw && !providerIdRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or provider_id. An NPI or Provider ID match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw)
    ? ROWS.filter((r) => splitList(r.npi).some((v) => digitsOnly(v) === npiRaw))
    : [];
  const providerIdMatches = providerIdRaw
    ? ROWS.filter((r) => splitList(r.provider_id).some((v) => v.replace(/^0+/, '') === providerIdRaw.replace(/^0+/, '') && v))
    : [];

  const identitySeen = new Set<OhOdmRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of providerIdMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'provider_id_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const fullNorm = normalize(fullName(r));
      const orgNorm = r.organization_name ? normalize(r.organization_name) : '';
      if ((fullNorm && qNorm === fullNorm) || (orgNorm && qNorm === orgNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => fullNorm.includes(t) || orgNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the Ohio ODM Provider Exclusion & Suspension List for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, provider_id: providerIdRaw || null },
      caveat: `This checks the Ohio ODM exclusion/suspension list only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list (see ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions, pa-medical-exclusions, ga-medical-exclusions). ${STATUS_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, provider_id: providerIdRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    status_caveat: STATUS_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const individuals = ROWS.filter((r) => r.record_type === 'individual').length;
  const organizations = ROWS.filter((r) => r.record_type === 'organization').length;
  const currentlyExcludedCount = ROWS.filter((r) => currentlyExcluded(r.status) === true).length;
  const statusUnknownCount = ROWS.filter((r) => currentlyExcluded(r.status) === null).length;
  const dates = ROWS.map((r) => r.action_date).filter((d): d is string => Boolean(d)).sort();

  // fleet #3170: count-by-date-range mode, same as the six precedent state
  // packs. Counted field is action_date (ODM's Action Date — when the
  // exclusion/suspension took effect), NOT date_added.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.action_date, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'action_date — ODM\'s Action Date (when the exclusion/suspension took effect). NOT date_added (when ODM added the row to this published file), which gives a different, wrong number for the same range.',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (2,100+ rows), not a page',
      total_rows_all_time: TOTAL_ROWS,
      oldest_action_date: dates[0] ?? null,
      newest_action_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      status_caveat: STATUS_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    individuals,
    organizations,
    currently_excluded: currentlyExcludedCount,
    status_unknown: statusUnknownCount,
    with_npi: withNpi,
    oldest_action_date: dates[0] ?? null,
    newest_action_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    status_caveat: STATUS_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'oh_medical_check_exclusion',
    description:
      'Is this healthcare provider excluded from, or suspended from, the Ohio Medicaid program? Screens a person or organization name, an NPI, and/or an ODM Provider ID against the Ohio Department of Medicaid (ODM) Provider Exclusion & Suspension List — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for Ohio specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California), tx_medical_check_exclusion (Texas), fl_medical_check_exclusion (Florida), pa_medical_check_exclusion (Pennsylvania) and ga_medical_check_exclusion (Georgia). Answers "is this provider excluded from Ohio Medicaid", "check this NPI against the Ohio ODM exclusion list", or pre-payment/credentialing screening for an Ohio Medicaid provider. '
      + 'An NPI or Provider ID match is an IDENTIFICATION (both are exact identifiers ODM assigns/records, and either can be a comma-joined list on one row when a provider is excluded under multiple registrations); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth. Every match carries ODM\'s own Status field (Excluded, Suspended, or occasionally Terminated/blank) and a currently_excluded flag DERIVED from it — null with status_unknown:true when the status is not a recognized Excluded/Suspended value, rather than a guess. Pass npi or provider_id to turn a name lead into an identification. Sourced from the Ohio ODM Provider Exclusion & Suspension List, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or organization name to screen, e.g. "John Smith" or "Acme Home Health". Matched against the provider\'s individual name and organization name, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        provider_id: { type: 'string', description: 'ODM\'s own Provider ID, if known. A Provider ID match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'oh_medical_exclusion_coverage',
    description:
      'What the Ohio ODM exclusion/suspension data covers and how current it is: total rows (individuals plus organizations), how many are currently excluded/suspended vs. status-unknown, how many carry an NPI, and the oldest/newest exclusion effective date. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line note on the status field\'s gaps. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many exclusions have an effective date in that year or range, counted over the whole 2,100+ row list, not a page — answers "how many Ohio ODM exclusions took effect in 2025". The response names the date field counted (action_date / ODM\'s Action Date — never date_added, which answers a different question and gives a different number). Sourced from the Ohio ODM Provider Exclusion & Suspension List, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'oh_medical_check_exclusion':
      return checkExclusion(args);
    case 'oh_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

# @pipeworx/oh-medical-exclusions

Ohio Department of Medicaid (ODM) Provider Exclusion & Suspension List
screening — check a provider by name, NPI, or ODM Provider ID against the
~2,122-row list of individuals and organizations excluded or suspended
from Ohio's Medicaid program, the state-level counterpart to the federal
HHS OIG LEIE (`leie` pack) and the sibling of `ny-omig-exclusions` (New
York), `ca-medical-exclusions` (California), `tx-medical-exclusions`
(Texas), `fl-medical-exclusions` (Florida), `pa-medical-exclusions`
(Pennsylvania) and `ga-medical-exclusions` (Georgia).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1831+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `oh_medical_check_exclusion(name?, npi?, provider_id?, limit?)` —
  screens a provider against the ODM exclusion/suspension list. An NPI or
  Provider ID match is an **identification** (both are exact identifiers,
  and either can be a comma-joined list on one row when a provider is
  excluded under multiple registrations); a name match — even an exact one
  — is a **candidate lead only**, since this list carries no date of
  birth. Every match carries ODM's own `status` and a `currently_excluded`
  flag derived from it.
- `oh_medical_exclusion_coverage()` — total rows (individuals plus
  organizations), how many are currently excluded/suspended vs.
  status-unknown, how many carry an NPI, and the oldest/newest exclusion
  effective date. Pass `year` or `start_date`/`end_date` to instead count
  exclusions whose effective date falls in that range, over the whole
  list.

## Auth

Keyless.

## Data sources

- Ohio Department of Medicaid (ODM), Provider Exclusion & Suspension List
  — the state's published roster of individuals and organizations excluded
  from, or currently suspended from, Ohio's Medicaid program, published at
  <https://medicaid.ohio.gov/resources-for-providers/enrollment-and-support/provider-enrollment/provider-exclusion-and-suspension-list>.

### The listing page 404s for a plain `curl` — that is a UA block, not a dead page

Verified live 2026-10-17: a request with no browser-shaped `User-Agent`
gets a stale CloudFront 404 fallback from Ohio's CDN; the identical
request with a browser-shaped UA string returns 200. This is the
UA-sniffing class the "public data is public data" ruling already covers
— not a login wall, not a CAPTCHA. `scripts/bake-index.mjs` still
identifies the pack honestly (its UA string names it and carries a
contact URL); the string is shaped to get past a bot filter, not to
impersonate a browser. The asset CDN that actually serves the `.xlsx` does
not need this — only the page that names its current URL does.

### The download link is NOT stable — resolved fresh every bake

The linked `.xlsx` lives on Ohio's asset CDN
(`dam.assets.ohio.gov/raw/upload/medicaid.ohio.gov/...`) and its FILENAME
embeds the publication date (e.g.
`ExclusionSuspensionList_10_15_2026-3.xlsx`). `scripts/bake-index.mjs`
resolves the current link from the listing page every run — the same
"resolve from the listing page, never guess the filename" discipline
`ga-medical-exclusions` and `scripts/ingest-dmepos.mjs` use for their own
unstable upstream filenames.

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(2,122 rows at capture time) is baked into `src/oh-odm-index-data.ts`,
registered in `workers/gateway/src/pack-baked-indexes.json`, uploaded to
KV at deploy, and injected into every call as `args._bakedIndex` — never a
static module-scope import (fleet #2754). A missing or malformed
injection throws loudly rather than answering "not found" — see
`src/index.test.ts`.

### No external XLSX library — hand-rolled, same discipline as the sibling packs

Reuses `ga-medical-exclusions/scripts/bake-index.mjs`'s pure-Node zip
reader (itself from `scripts/ingest-dmepos.mjs`: Node's built-in
`zlib.inflateRawSync` over a hand-walked central directory — no `unzip`
CLI, no npm package). This workbook needs sheets resolved **by name**
("Individuals" is `rId2`/`worksheets/sheet2.xml`, "Organizations" is
`rId3`/`worksheets/sheet3.xml` — not the first sheet, which is
"Instructions" prose), unlike `ga-medical-exclusions`, which only needed
the workbook's first sheet.

### Two sheets, one unified row shape

ODM publishes this as **Individuals** (1,867 rows at capture: name, DOB,
NPI, Provider ID, Status, Action Date, Date Added, Provider Type) and
**Organizations** (255 rows: NPI, organization name, address, Provider ID,
Status, Action Date, Date Added, Provider Type). Both are baked into one
row shape tagged `record_type: 'individual' | 'organization'`.

### Dates are Excel serials, except two rows that are plain text

Verified directly against all ~2,122 rows: Action Date and Date Added are
untyped numeric cells (Excel date serials) for all but 2 Individuals rows,
where ODM's own data entry put literal `"9/24/2025"` text into the cell
instead. `bake-index.mjs` decodes both shapes — by cell TYPE here (string
vs. numeric), not magnitude, since there is no 8-digit-YYYYMMDD ambiguity
in this file the way there was in `ga-medical-exclusions`'s SANCDATE
column.

### Action Date vs. Date Added — same trap as every precedent pack

Verified directly: of the rows carrying both dates, 1,035/1,064
(Individuals) and 123/133 (Organizations) have **different** values.
Action Date is when the exclusion/suspension took effect; Date Added is
when ODM added the row to this published file. This pack counts by
Action Date only, never Date Added.

### NPI, Provider ID and Provider Type can be comma-joined lists

31 Individuals rows and 11 Organizations rows carry more than one NPI on a
single row (one person/entity excluded under multiple Medicaid
registrations), e.g. `"1447317433, 1598934424"` with a matching Provider
ID pair `"2744918, 2798898"`. Matching splits on comma and compares each
fragment, so a query for either value finds the row.

### Status has whitespace/case/typo variants

Besides clean "Excluded"/"Suspended", the live file has `" Excluded"`
(leading space), `"Excluded "` (trailing space), `"suspended"`
(lowercase), a single `"susepnded"` (typo), a handful of `"Terminated"`,
and a few blank cells. This pack trims+lowercases for its own
active/inactive classification (`currently_excluded: true` only for a
recognized Excluded/Suspended value; everything else —
including the typo and "Terminated" — gets `currently_excluded: null` and
`status_unknown: true`) but serves the status text as published, trimmed
only, never "corrected."

### No home address, no date of birth

The Individuals sheet carries a date-of-birth column and the
Organizations sheet carries a full street address (Address 1/2, City,
State, Zip). Neither is carried into this pack — the task's house rule is
to serve the same fields the six precedent state packs serve and add no
new personal identifier or address beyond them; none of those packs serve
a street address or a date of birth. `bake-index.mjs` reads both columns
only to parse past them.

### Matching

An `npi` query matches only exact 10-digit numeric NPI values, checked
against every comma-separated fragment on a row. A `provider_id` query
matches ODM's own Provider ID, leading-zero-tolerant, also checked against
every fragment. Name queries match against the provider's assembled
individual name or organization name, any word order,
case/punctuation-insensitive.

### Reachability

Verified live 2026-10-17: the listing page (with a browser-shaped UA)
resolves a current download link, and that link returns `200` with an
Excel 2007+ file, 2,122 data rows across both sheets.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "oh-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/oh-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/oh-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1831+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/oh_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"Abdi"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/oh_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "oh-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-oh-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-oh-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Oh Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

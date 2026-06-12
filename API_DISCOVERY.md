## Selected API

- Endpoint: `POST https://api.ziprecruiter.com/mcp`
- Tool: `search_jobs`
- Method: JSON-RPC over HTTP
- Auth: None required for the tested flows
- Pagination: `offset` argument, current server page size observed as `5`
- Fields available: `title`, `company`, `location`, `is_remote`, `salary.min_annual`, `salary.max_annual`, `company_logo`, `job_redirect_url`, `job_type`, `benefits`, `days_ago`
- Fields currently missing in actor after the switch: full description, company profile detail, apply destination metadata, canonical job page URLs, and listing IDs are not exposed by the MCP tool
- Works with plain HTTP: Yes. No browser bootstrap or search-page clearance was needed.

## Why this API won

- The existing `jobs-search` HTML path and `job-redirect` URLs both returned Cloudflare challenge pages during direct HTTP testing on June 12, 2026.
- The older embedded `serializedJobCardsData` payload only worked when the challenged search page could be loaded first, which was the current failure mode in Apify logs.
- The MCP endpoint initialized and served live search results immediately through direct HTTP, making it the least protected working source currently found.

## Weaker candidates rejected

- `GET https://www.ziprecruiter.com/jobs-search?...`
  Rejected because it returned HTTP `403` with a Cloudflare verification page during direct testing.
- `GET https://www.ziprecruiter.com/Jobs/...`
  Rejected because the SEO routes also returned HTTP `403` challenge pages during direct testing.
- `POST /job_services.job_card.api_public.public.api.v1.API/GetJobDetails`
  Rejected as a primary source because it still depends on first obtaining search results from the blocked site flow.
- URLScan anonymous scan submission
  Rejected for this run because the current API returned HTTP `401` without an API key.

## Field count comparison

- Previous working target: potentially 30+ fields, but current Apify run produced `0` jobs because the source page was blocked.
- Selected endpoint: 11 stable listing-level fields, with reliable live extraction confirmed locally.

## API scoring

- Returns JSON directly: +30
- Has >15 unique fields: +0
- No auth required: +20
- Has pagination support: +15
- Matches/extends current fields: +10
- Total: **75 / 100**

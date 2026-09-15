# ZipRecruiter Access Discovery

## Current decision

The actor no longer uses the MCP endpoint, direct HTTP API calls, or third-party aggregators. The selected path is one Camoufox Firefox browser context opened through Apify Unblocker, with a Residential retry route when the first route fails, and the same context reused while pagination is processed. The page is opened normally and the actor reads the current Next.js flight payload (`serializedJobCardsData.jobKeysMap`) before falling back to the older embedded JSON bootstrap and rendered job cards.

This choice follows the current evidence:

- The MCP endpoint repeatedly returned HTTP 429 during local reproduction.
- The mobile jobs endpoint returned HTTP 403 `forbidden cf-waf` from the discovery environment.
- Direct ZipRecruiter search-page requests returned Cloudflare HTTP 403 challenge pages.
- A live ZipRecruiter search page currently returns a Next.js flight payload with `serializedJobCardsData.jobKeysMap`, `jobKeys`, `totalListings`, and `pageNumber`; the records contain the listing fields required by the actor.
- The same live page also exposes an `ItemList` JSON-LD block and rendered job cards, providing evidence-backed fallbacks when the flight payload is unavailable.
- The maintained `jobspy-js` implementation remains the reference for the older `hydrateJobCardsResponse.jobCards` bootstrap shape.
- A Camoufox browser context plus a managed Unblocker route gives the target a real page navigation flow and preserves cookies/runtime state for subsequent pages. A failed first route is retried in a fresh context with Residential.

The browser route is not described as a guaranteed anti-bot bypass. A successful production run must be verified on Apify with the selected proxy route.

## Selected page flow

- Keyword mode: `https://www.ziprecruiter.com/jobs-search?search=...&location=...` (page 1 and later pages; later pages add `page=N`)
- URL mode page 1: the caller's `searchUrl` exactly, with search fields ignored
- URL mode later pages: the supplied URL with `page=N`
- Browser: Camoufox Firefox, headless mode
- Proxy: Apify `UNBLOCKER` by default, with no session ID passed
- Context lifecycle: one proxy URL and one browser context for the run
- Speed controls: response commit, targeted JSON polling, and abort media/analytics resources without blocking images or fonts
- Extraction markers, in order: `serializedJobCardsData.jobKeysMap`, `hydrateJobCardsResponse.jobCards`, then rendered `article[id^="job-card-"]` cards with `ItemList` JSON-LD URLs
- Pagination marker: `pageNumber` and `totalListings` from the Next.js payload, or embedded `page` and `maxPages` from the older bootstrap
- Stable identity: `listingKey`, then canonical job URL, then conservative listing fields

## Fields confirmed by public implementation evidence

The maintained `jobspy-js` ZipRecruiter source reads these payload paths or equivalent values:

- `hydrateJobCardsResponse.jobCards`
- `getJobDetailsResponse.jobDetails`
- `listingKey`
- `title`
- `company.name`
- `location.city`, `location.stateCode`, `location.countryCode`
- `employmentTypes`
- `status.postedAtUtc`
- `pay.interval`, `pay.min`, `pay.max`
- `shortDescription`
- `applyButtonConfig.externalApplyUrl`
- `rawCanonicalZipJobPageUrl`

The actor maps these into its existing public record names and adds `source`, `provider`, stable listing key, description, posting date, and compensation interval fields. Arrays remain arrays.

## Candidate matrix

| Candidate                                | Evidence                                                                                              |                                 Status | Decision                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------: | -------------------------------------------------------------------------------- |
| Camoufox page navigation + embedded JSON | Maintained JS implementation documents the payload shape; browser route addresses page-level blocking |                Selected implementation | Use as the only runtime source                                                   |
| Plain HTTP search page                   | Local GET returned a Cloudflare challenge                                                             |                                Blocked | Not used alone                                                                   |
| MCP `search_jobs`                        | Historical structured response, but current local requests returned HTTP 429                          |                            Unavailable | Removed from actor                                                               |
| Mobile `/jobs-app/jobs`                  | Maintained Python implementation documents `continue`; local request returned HTTP 403 WAF            |                        Proxy-dependent | Removed from actor to keep one browser path                                      |
| `jobspy-js` package                      | Active MIT package with ZipRecruiter support and TLS-aware page session                               |                        Valid reference | Ported its ZipRecruiter JSON mapping without adding its full multi-board runtime |
| Old unofficial API wrappers              | Archived or obsolete API contracts                                                                    |                               Rejected | Not current                                                                      |
| JobsPipe, JSearch, Adzuna                | Require credentials and may not preserve ZipRecruiter provenance                                      | Not suitable as an implicit dependency | Rejected                                                                         |
| Arbeitnow, Remotive, Remote OK, USAJobs  | Free feeds but not ZipRecruiter-specific                                                              |                       Wrong provenance | Rejected                                                                         |

## Proxy policy

The input uses the exact Apify `proxyConfiguration` key. The default cloud preference is `UNBLOCKER`. The actor does not construct proxy credentials, does not log proxy URLs, and does not pass a session ID to Unblocker. Custom proxy configurations are passed through `Actor.createProxyConfiguration()`. Camoufox receives the same proxy URL, but its optional `geoip` lookup is disabled because `camoufox-js` performs external public-IP requests that can fail certificate validation in the Apify runtime; WebRTC remains blocked.

Local runs without Apify credentials intentionally run without the managed proxy and may receive a Cloudflare challenge. That is an environment limitation, not a reason to label a blocked smoke test as successful.

## Validation requirements

A release run must confirm:

- Apify run starts with a usable Unblocker route.
- The first page contains either `serializedJobCardsData.jobKeysMap` or the older `hydrateJobCardsResponse.jobCards` payload; rendered-card fallback is only accepted when job cards are present.
- Dataset is non-empty for a search known to have matches.
- `maxJobs` is respected.
- `maxPages` and the payload's `maxPages` stop pagination.
- Duplicate listing keys are not emitted twice.
- Arrays and numeric salary fields retain their declared types.
- No credentials, cookies, full responses, or proxy URLs appear in logs.

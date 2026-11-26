# ZipRecruiter API discovery

Last verified: 2026-11-26. Evidence was collected live from a residential PK connection and from Apify cloud runs. ZipRecruiter changes its payload shape without notice, so this document describes the markers to look for, not a single immutable schema.

## Selected flow

- Endpoint: `https://www.ziprecruiter.com/jobs-search`
- Method: `GET`
- Authentication: none
- Required request header: `accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`
- Request language: `accept-language: en-US,en;q=0.9`
- Transport: Scrapling `AsyncFetcher` (curl_cffi impersonation) with a documented browser profile
- Pagination: `page` query parameter, 1-based, 20 cards per page
- Description data: `shortDescription` from the listing payload. The actor stays listing-only and does not request job detail pages.

The request `accept` header is kept because it matches a real navigation request. It is not a bypass on its own: on 2026-10-21 the impit transport was challenged with `accept: */*` and passed with the navigation value, while on 2026-11-26 curl_cffi `chrome` returned HTTP 200 with both. The transport profile is the deciding factor today.

The headers above are the only headers the actor sets. The user-agent, `sec-ch-ua` and `sec-fetch-*` values come from the impersonated profile and must not be overridden, or the fingerprint contradicts the TLS hello and Cloudflare challenges the request.

## Request examples

Keyword and location search:

```text
https://www.ziprecruiter.com/jobs-search?search=software%20engineer&location=New%20York%2C%20NY&page=2
```

Search URL input:

```text
https://www.ziprecruiter.com/jobs-search?search=data%20analyst&location=Chicago%2C%20IL&page=3
```

Posting-age filter:

```text
https://www.ziprecruiter.com/jobs-search?search=product%20manager&location=California&days=7
```

Use `days`, not `days_ago`. A live comparison showed `days=7` reducing the result count from 748 to 269 with recent cards first, while `days_ago=7` left the result set unchanged.

## Response layout

The page is a Next.js server-rendered document. Job data is embedded in the React flight stream:

```text
<script>self.__next_f.push([1,"..."])</script>
```

Join every `self.__next_f.push` string in document order. The current job payload is a container object with these keys:

```json
{
    "jobKeys": [{ "listingKey": "...", "matchId": "..." }],
    "jobCards": [{ "listingKey": "...", "title": "...", "company": { "name": "..." } }],
    "totalListings": 761,
    "extensions": { "breakroom": {} },
    "placementId": 44072
}
```

Search metadata is stored in a nearby flight row:

```json
{ "requesterCountryCode": "PK", "jobCount": 761, "pageNumber": 1 }
```

A `GetJobDetailsResponse` is also present for one listing:

```json
{
    "$typeName": "job_services.job_card.api_public.public.api.v1.GetJobDetailsResponse",
    "rsp": { "jobDetails": { "listingKey": "...", "htmlFullDescription": "$36" } }
}
```

`$36` is an unresolved flight reference, not a description. It is rejected by the output mapper. The actor uses `shortDescription` from each card for fast listing-only extraction.

### Payload markers in priority order

1. `jobCards` array inside a flight container also containing `jobKeys` and `totalListings`.
2. Legacy `serializedJobCardsData.jobKeysMap` + `jobKeys` array.
3. Legacy `hydrateJobCardsResponse.jobCards` embedded JSON.
4. `application/ld+json` `ItemList` fallback. This only has title and URL, so it is a last resort.

The extractor walks backwards from `"jobCards"` and accepts the first balanced object that contains a non-empty `jobCards` array. Field order changes do not break this lookup.

## Available fields

Each card currently provides:

`listingKey`, `matchId`, `title`, `benefits`, `employmentTypes`, `enhancementTypes`, `locationTypes`, `shortDescription`, `saved`, `locationUrl`, `companyUrl`, `isNew`, `companyLogoUrl` (sometimes), `companyLogo`, `jobRedirectPageUrl`, `rawCanonicalZipJobPageUrl`, `openSeatId`, `seoJobRedirectPageUrl`, `shareShortUrl`, `htmlFullDescription` (usually empty), `status`, `pay`, `company`, `location`, `applyButtonConfig`, `buttonConfig`, `display`, `updatedAt`.

Human-readable values are duplicated in `display`:

- `display.location` — `Manhattan, NY`
- `display.employmentTypes.fullDisplay` — `Full-time`
- `display.locationTypesV2.fullDisplay` — `On-site`
- `display.benefits` — `Medical, Dental, Vision, Life, Retirement, PTO`
- `display.rollingPostedAt` — `18 days ago`
- `display.pay.text` — salary text when the source publishes one

Timestamps use protobuf objects:

```json
{ "seconds": "1788418800", "nanos": 0 }
```

## Browser profile matrix

Same URL and same headers, one request per profile, no proxy, from a residential PK connection, 2026-11-26, using Scrapling `AsyncFetcher` with `stealthy_headers=False`:

| Profile | Status | Body | Job cards | Decision |
| --- | ---: | ---: | --- | --- |
| `chrome` | 200 | 718 KB | yes | selected primary |
| `chrome150` | 200 | 719 KB | yes | fallback |
| `safari` | 200 | 715 KB | yes | fallback |
| `firefox` | 403 | 6 KB | no | last resort (challenge) |
| `chrome133a`, `chrome136`, `chrome142`, `chrome145`, `chrome124` | 403 | 6 KB | no | rejected (challenge) |
| `edge`, `edge101` | 403 | 6 KB | no | rejected (challenge) |
| `safari184` | 403 | 6 KB | no | rejected (challenge) |
| `firefox133`, `firefox135`, `firefox147`, `firefox153`, `firefox155` | 403 | 6 KB | no | rejected (challenge) |

On 2026-10-21 the same endpoint accepted the Firefox profiles and rejected `chrome`, which is why the profile list is a runtime rotation instead of one hardcoded fingerprint: the Cloudflare rule set that selects an accepted fingerprint changes over time. `firefox` stays last in the chain because it may win again from another exit IP.

`stealthy_headers` is not the deciding factor: on 2026-11-26 both `True` and `False` returned the payload on the same exit IP. The actor pins `False` so the only headers on the wire are the documented ones.

Historical reference (impit transport, 2026-10-21, same connection):

| Profile | Status | Body | Job cards |
| --- | ---: | ---: | --- |
| `firefox` | 200 | 749 KB | yes |
| `firefox128` | 200 | 746 KB | yes |
| `firefox133` | 200 | 746 KB | yes |
| `chrome125` | 200 | 750 KB | yes |
| `chrome` | 403 | 6 KB | no |
| `okhttp`, `okhttp3`, `okhttp4`, `okhttp5` | 403 | 6 KB | no |
| `chrome100`–`chrome116`, `ios18` | connect error | — | no |

## Transport options evaluated

One request per client, same URL, same connection, 2026-11-26. Every client that fails here returns the Cloudflare challenge page, not an error:

| Client | Profile / headers | Status | Body | Job cards |
| --- | --- | ---: | ---: | --- |
| `requests` 2.32 | Chrome UA, navigation headers | 403 | 6 KB | no |
| `httpx` 0.28 | Chrome UA, navigation headers, HTTP/1.1 | 403 | 6 KB | no |
| `tls_client` 1.0.1 | `chrome_120`, navigation headers | 403 | 5.8 KB | no |
| `impit` 0.15.1 (Python) | `browser="chrome"` | 403 | 6.2 KB | no |
| `curl_cffi` 0.17 | `impersonate="chrome"`, default headers | 200 | 716 KB | yes |
| `curl_cffi` 0.17 | `impersonate="chrome"`, navigation headers | 200 | 717 KB | yes |
| Scrapling 0.5.1 | `chrome`, `stealthy_headers=True` | 200 | 721 KB | yes |
| Scrapling 0.5.1 | `chrome`, `stealthy_headers=False` | 200 | 722 KB | yes |

The split is the TLS fingerprint, not the wrapper: `requests`, `httpx`, `tls_client` (`chrome_120`) and Python `impit` do not reproduce the accepted Chrome hello, while curl_cffi's `chrome` does. Scrapling is a thin layer over curl_cffi, so it inherits the same result and adds proxy sessions, retry plumbing and HTML parsing that the actor already uses. `tls_client` is not a drop-in replacement: its bundled `chrome_120` profile was challenged while curl_cffi's `chrome` was not.

A browser fetcher (Scrapling `StealthyFetcher` / Camoufox, both installed in this environment) would also pass, but it costs a browser download and roughly an order of magnitude more run time for a server-rendered payload that is available over HTTP.

## Rejected sources

| Candidate                                             | Result                                      | Why rejected                                                                  |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `https://api.ziprecruiter.com/jobs/v1?...api_key=...` | HTTP 404 HTML error page                    | Public publisher key from old tutorials no longer maps to this endpoint       |
| `https://www.ziprecruiter.com/candidate/search`       | 200 but geolocated to the requester country | Legacy route ignores the supplied location in this environment                |
| Chrome, okhttp, iOS profiles                          | 403 or TLS failure                          | Cloudflare rejects these fingerprints for this endpoint                       |
| Playwright/Chromium browser rendering                 | Works but slow and resource-heavy           | The direct HTTP payload contains the same cards, so a browser is not required |

## Cloud validation

Python actor, US residential Apify Proxy, 2026-11-26:

| Build | Run | Input | Result |
| --- | --- | --- | --- |
| 1.0.10 | `cjsKSedxUPYZ5sYwd` | keyword, `maxJobs: 5` | `SUCCEEDED`, 5 records, 2 s, `{"chrome": 1}`, 0 blocked |
| 1.0.10 | `ithPrQ2f3NAKPb9HP` | `{}` (search URL prefill, the Store health test) | `SUCCEEDED`, 20 records, 16 s, 4 blocked, 1 transport error, 2 proxy rotations, `{"chrome": 3, "chrome150": 1, "safari": 1}` |
| 1.0.11 | `9wJRXn2Kg32iSbkFo` | keyword, `maxJobs: 5` | `SUCCEEDED`, 5 records, 44 s, 18 blocked, 5 proxy rotations, `{"chrome": 6, "chrome150": 5, "safari": 4, "firefox": 4}` |
| 1.0.12 | `kc4MHoBnaLPAuNBLb` | keyword, `maxJobs: 5` | `SUCCEEDED`, 5 records, 2 s, 0 blocked, 0 rotations, `{"chrome": 1}` |

The third run is the important one for access: every profile was challenged on the first proxy exits, all five rotations were used, and the loop still returned a payload and pushed the requested records. No browser step in any run.

Historical impit runs (2026-10-21): the first run used the default input (search URL only) with US residential Apify Proxy and parsed 20 cards. A run using `UNBLOCKER` was rejected by the account before startup (`You currently do not have access to proxy groups: UNBLOCKER`), so the actor default is `RESIDENTIAL` with `apifyProxyCountry: US`.

Profile rotation was observed in the impit runs as well: page 1 was served by `firefox`, page 2 by `firefox128` after `firefox` returned HTTP 200 without a job payload.

Proxy-country check (impit era): US residential completed a 40-record, 2-page run in 12 seconds; the same run without a country completed 10 records in 43 seconds, so the default keeps `US` for speed and consistency.

## Session recovery

Each page request can use up to six proxy sessions (initial session plus five rotations) across the four verified profiles. Retry selection is:

1. Keep the profile that last succeeded in first position.
2. If that profile is challenged or returns an unusable page, rotate the proxy once before demoting it.
3. If it still fails, try the remaining profiles on the new session.
4. Continue rotating sessions until a usable payload is returned or the three-minute per-page budget is exhausted.
5. When a later page cannot be recovered, keep the already-saved records and finish with `stopReason: partial_failure` instead of failing the whole run.

A 10-page `admin` / `New York` run completed 195 unique records in 26 seconds with no challenge warnings in the run log.

## Failure diagnostics

When a request fails, read this section before changing code:

1. `HTTP 403` with `Just a moment...` means the profile or IP was challenged. Rotate to the next verified profile, then rotate the proxy session.
2. `HTTP 429` means rate limiting. Honor `Retry-After`, then retry with bounded backoff.
3. `HTTP 200` without a `jobCards` marker means the payload changed. Check whether the flight stream still exists, whether the container keys changed, and whether a new response layout is present.
4. `HTTP 200` with an empty `jobCards` array means the query matched no listings. Stop pagination; this is not an error.
5. WebSocket, gRPC, or GraphQL endpoints found in the browser are not required for this flow. Do not replace the working server-rendered payload with a speculative endpoint.
6. A `requesterCountryCode` different from `US` is expected when the proxy exit is outside the US. The requested `location` parameter still controls the result set.

## Validation requirements

- `GET /jobs-search` returns a `self.__next_f.push` flight stream.
- The stream contains a non-empty `jobCards` array.
- `pageNumber` matches the requested page.
- `jobCount` or `totalListings` provides the page-count bound.
- Card `listingKey` is stable across pages and used for deduplication.
- At least one card exposes `title`, `company.name`, `location`, and `rawCanonicalZipJobPageUrl`.
- `accept` is the navigation HTML accept header.
- The transport uses one of the verified profiles in `src/http_client.py`.

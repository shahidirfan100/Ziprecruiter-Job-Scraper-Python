# ZipRecruiter API discovery

Last verified: 2026-10-21. Evidence was collected live from a residential PK connection and from Apify cloud runs. ZipRecruiter changes its payload shape without notice, so this document describes the markers to look for, not a single immutable schema.

## Selected flow

- Endpoint: `https://www.ziprecruiter.com/jobs-search`
- Method: `GET`
- Authentication: none
- Required request header: `accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`
- Request language: `accept-language: en-US,en;q=0.9`
- Transport: `impit` with a documented Firefox browser profile
- Pagination: `page` query parameter, 1-based, 20 cards per page
- Description data: `shortDescription` from the listing payload. The actor stays listing-only and does not request job detail pages.

The request `accept` header is not cosmetic. A live test with impit's default `*/*` accept value returned HTTP 403 with the Cloudflare challenge page. Supplying the navigation accept header on the same profile returned HTTP 200 with the full job payload.

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

Same URL and same headers, one request per profile, no proxy, 2026-10-21:

| Profile                                            |        Status |   Body | Job cards | Decision                 |
| -------------------------------------------------- | ------------: | -----: | --------- | ------------------------ |
| `firefox`                                          |           200 | 749 KB | yes       | selected primary         |
| `firefox128`                                       |           200 | 746 KB | yes       | fallback                 |
| `firefox133`                                       |           200 | 746 KB | yes       | fallback                 |
| `chrome125`                                        |           200 | 750 KB | yes       | fallback                 |
| `chrome`                                           |           403 |   6 KB | no        | rejected (challenge)     |
| `chrome124`                                        |           403 |   6 KB | no        | rejected (challenge)     |
| `chrome131`, `chrome136`, `chrome142`, `chrome151` |           403 |   6 KB | no        | rejected (challenge)     |
| `chrome100`–`chrome116`                            | connect error |      — | no        | rejected (TLS handshake) |
| `firefox135`, `firefox144`                         |           403 |   6 KB | no        | rejected (challenge)     |
| `okhttp`, `okhttp3`, `okhttp4`, `okhttp5`          |           403 | 5.7 KB | no        | rejected (challenge)     |
| `ios18`                                            | connect error |      — | no        | rejected (TLS handshake) |

Repeat test: five consecutive requests on the `firefox` profile all returned HTTP 200 and a full payload.

## Rejected sources

| Candidate                                             | Result                                      | Why rejected                                                                  |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `https://api.ziprecruiter.com/jobs/v1?...api_key=...` | HTTP 404 HTML error page                    | Public publisher key from old tutorials no longer maps to this endpoint       |
| `https://www.ziprecruiter.com/candidate/search`       | 200 but geolocated to the requester country | Legacy route ignores the supplied location in this environment                |
| Chrome, okhttp, iOS profiles                          | 403 or TLS failure                          | Cloudflare rejects these fingerprints for this endpoint                       |
| Playwright/Chromium browser rendering                 | Works but slow and resource-heavy           | The direct HTTP payload contains the same cards, so a browser is not required |

## Cloud validation

The first Apify cloud run used the default input (search URL only) with US residential Apify Proxy. It returned HTTP 200, parsed 20 cards, and pushed the requested records with no browser step. A run using `UNBLOCKER` was rejected by the account before startup (`You currently do not have access to proxy groups: UNBLOCKER`), so the actor default is `RESIDENTIAL` with `apifyProxyCountry: US`.

Profile rotation was observed in production behavior: page 1 was served by `firefox`, page 2 by `firefox128` after `firefox` returned HTTP 200 without a job payload. The run completed with 25 unique records. A later prefill-only run (the Store health-test input) completed in 3 seconds with 20 records and status `SUCCEEDED`.

Proxy-country check: US residential (`apifyProxyCountry: US`) completed a 40-record, 2-page run in 12 seconds. The same run without a country completed 10 records in 43 seconds, so the default keeps `US` for speed and consistency. Any residential exit can work, but non-US exits triggered more hidden retries.

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

1. `HTTP 403` with `Just a moment...` means the profile or IP was challenged. Rotate to the next working Firefox profile, then rotate the proxy session.
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
- The transport uses one of the four verified profiles.

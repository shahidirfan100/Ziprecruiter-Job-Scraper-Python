# ZipRecruiter Jobs Scraper

Extract and collect ZipRecruiter job listings into structured datasets for analysis, research, and automation. Gather job titles, companies, locations, salary ranges, work-style labels, benefits, and apply links at scale. This actor is built for fast, reliable job data collection workflows.

## Features

- **Structured Listing Data** — Collect job titles, companies, locations, salary ranges, work-style labels, benefits, and apply links.
- **Flexible Search Inputs** — Start from a direct search URL or use keywords and location.
- **Automatic Pagination** — Continue across result batches until you hit your limits.
- **Freshness Filtering** — Restrict results to recent postings using a day-range filter.
- **Duplicate Handling** — Automatically removes repeated listings across overlapping result batches.
- **Structured Exports** — Use JSON, CSV, Excel, and other dataset export formats.
- **Automation Ready** — Run manually, on schedule, or through API integrations.

## Use Cases

### Recruitment Pipeline Enrichment
Collect targeted job datasets by role and location to enrich recruiting workflows. Track openings from specific regions or categories and sync clean listing data downstream.

### Job Market Intelligence
Analyze hiring demand by title, location, compensation range, work style, and posting recency. Use the data for reporting, trend analysis, and competitive monitoring.

### Lead Generation for B2B Services
Find companies actively hiring in your service niche and create prospect lists. Use job activity as an intent signal for outreach campaigns.

### Career Research and Content
Gather current job trends for salary guides, skills reports, and job-seeker resources. Build data-backed insights from recent posting activity.

### Internal BI and Dashboards
Feed datasets into warehouse or BI tools for recurring reporting. Monitor role distribution, market shifts, and hiring spikes over time.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `searchUrl` | String | No | — | Direct ZipRecruiter search URL. When provided, it overrides search query and location fields. |
| `searchQuery` | String | No | `"software engineer"` | Keywords or job title to search for. Required when `searchUrl` is not provided. |
| `location` | String | No | `"United States"` | Target location for search results. |
| `maxJobs` | Integer | No | `20` | Maximum number of jobs to collect. Use `0` for unlimited until other limits are reached. |
| `maxPages` | Integer | No | `10` | Maximum number of result pages to process. |
| `scrapeMode` | String | No | `"listing_only"` | `listing_only` is the native mode. `listing_with_details` is accepted for compatibility and currently returns the same listing-level dataset. |
| `daysBack` | String | No | `"any"` | Posting recency filter. Allowed values: `any`, `1`, `3`, `7`, `14`, `30`. |
| `proxyConfiguration` | Object | No | Residential proxy preset | Proxy configuration for reliable collection. |

---

## Output Data

Each dataset item contains job listing data like:

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Job title. |
| `company` | String | Company display name. |
| `location` | String | Display location text. |
| `isRemote` | Boolean | Indicates remote classification. |
| `locationTypes` | String | Work style labels such as `Remote`, `Hybrid`, or `On-site`. |
| `locationType` | String | Joined work style summary. |
| `employmentTypes` | String | Employment type labels such as `Full-time` or `Contract`. |
| `jobType` | String | Combined job type summary returned with the listing. |
| `salary` | String | Human-readable salary summary. |
| `salaryMinAnnual` | Number | Minimum annual salary when available. |
| `salaryMaxAnnual` | Number | Maximum annual salary when available. |
| `companyLogoUrl` | String | Company logo URL when available. |
| `benefits` | String | Benefits summary when available. |
| `daysAgo` | Number | Age of the listing in days. |
| `url` | String | Job redirect URL. |
| `searchQuery` | String | Input keyword used in the run. |
| `searchLocation` | String | Input location used in the run. |
| `page` | Number | Result batch number processed by the actor. |
| `offset` | Number | Offset used for the result batch request. |
| `scrapedAt` | String | Extraction timestamp. |

---

## Usage Examples

### Basic Keyword Search

Collect software engineering jobs in New York:

```json
{
    "searchQuery": "software engineer",
    "location": "New York, NY",
    "maxJobs": 50,
    "scrapeMode": "listing_only"
}
```

### Direct Search URL

Use a ZipRecruiter search URL directly:

```json
{
    "searchUrl": "https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote",
    "maxJobs": 100,
    "maxPages": 20,
    "scrapeMode": "listing_only"
}
```

### Recent Jobs with Proxy Configuration

Focus on fresh jobs and use proxy settings:

```json
{
    "searchQuery": "product manager",
    "location": "California",
    "daysBack": "7",
    "maxJobs": 200,
    "maxPages": 50,
    "scrapeMode": "listing_only",
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"],
        "apifyProxyCountry": "US"
    }
}
```

---

## Sample Output

```json
{
    "title": "Senior Software Engineer",
    "company": "Example Company",
    "location": "Austin, Texas",
    "isRemote": false,
    "locationTypes": "On-site",
    "jobType": "Full-time · On-site",
    "salary": "$120,000 - $150,000 / year",
    "salaryMinAnnual": 120000,
    "salaryMaxAnnual": 150000,
    "companyLogoUrl": "https://www.ziprecruiter.com/svc/fotomat/public-nosensitive-ziprecruiter-logos/company/example.png",
    "benefits": "Medical, Vision, Dental, Paid time off",
    "daysAgo": 1,
    "url": "https://www.ziprecruiter.com/job-redirect?match_token=example",
    "searchQuery": "software engineer",
    "searchLocation": "United States",
    "page": 1,
    "offset": 0,
    "scrapedAt": "2026-06-12T11:00:00.000Z"
}
```

---

## Tips for Best Results

### Start with Tight Searches
- Use specific keywords to reduce irrelevant results.
- Narrow by location when possible for cleaner datasets.

### Control Volume Intentionally
- Start with `maxJobs` 20-100 for test runs.
- Increase `maxPages` and `maxJobs` for production runs.

### Use Recency Filters
- Set `daysBack` to `1`, `3`, or `7` for fresher monitoring workflows.
- Use `any` when building historical-style snapshots.

### Keep Proxy Enabled
- Use residential proxy settings for stronger reliability.
- Keep proxy configuration consistent for scheduled runs.

### Expect Listing-Level Coverage
- Some listings do not expose salary, logo, or benefits details.
- The actor removes empty values so your dataset stays cleaner.

### Schedule for Monitoring
- Run daily or hourly schedules to detect new listings quickly.
- Connect runs to notifications or downstream automations.

---

## Integrations

Connect extracted data to:

- **Google Sheets** — Share and analyze job datasets quickly.
- **Airtable** — Build searchable recruiting and market tables.
- **Slack** — Send run notifications to your team.
- **Webhooks** — Trigger custom backend workflows after each run.
- **Make** — Build no-code pipelines and enrichment flows.
- **Zapier** — Connect jobs data to business apps automatically.

### Export Formats

- **JSON** — API and engineering workflows.
- **CSV** — Spreadsheet analysis and reporting.
- **Excel** — Business-ready reports.
- **XML** — System-to-system integrations.

---

## Frequently Asked Questions

### Do I need both `searchUrl` and `searchQuery`?
No. Use either `searchUrl` or `searchQuery` (with optional `location`).

### How many jobs can I collect?
Set `maxJobs` to your target value. If set to `0`, collection continues until page limits or result availability stops it.

### Can I collect only recent jobs?
Yes. Use `daysBack` with values like `1`, `3`, `7`, `14`, or `30`.

### Why are some fields missing?
Some listings do not expose salary, benefits, or company logo details. Empty values are automatically removed from the dataset.

### Can I automate this actor?
Yes. You can run it on schedules, call it through API, and send results to downstream tools.

### Is output available as CSV and Excel?
Yes. You can export dataset items in CSV, Excel, JSON, and additional formats from Apify.

---

## Support

For issues or feature requests, use the Apify Console issue/support channels for this actor.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Schedules](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection and research use. You are responsible for complying with applicable laws, platform terms, and data usage policies in your jurisdiction.

## What does ZipRecruiter Jobs Scraper do?

ZipRecruiter Jobs Scraper collects public job listings from ZipRecruiter and saves them as structured Apify dataset records. Search by job keywords and location, or provide a ZipRecruiter search URL. The dataset includes job titles, employers, locations, work style, compensation, descriptions, posting dates, and application links when published by the listing.

This Actor is designed for hiring research, recruiting workflows, job market monitoring, company research, and scheduled data collection.

## Why use ZipRecruiter Jobs Scraper?

- **Search-focused collection** - Use a keyword, location, or an existing ZipRecruiter results URL.
- **Useful hiring fields** - Collect compensation, employment type, work style, short descriptions, logos, and apply links when available.
- **Fast listing extraction** - Collects job cards directly from result pages without per-job detail requests.
- **Freshness controls** - Restrict collection to postings from the last day, 3 days, 7 days, 14 days, or 30 days.
- **Duplicate protection** - Repeated listings are removed using stable listing identifiers or job URLs.
- **Fast dataset delivery** - Records are saved as result pages are processed instead of waiting for the entire run.
- **Automation ready** - Schedule repeat runs, call the Actor through the Apify API, or connect the dataset to downstream tools.

## What data can you extract from ZipRecruiter?

| Field                                 | Type    | Description                                                   |
| ------------------------------------- | ------- | ------------------------------------------------------------- |
| `title`                               | String  | Job title.                                                    |
| `company`                             | String  | Employer name.                                                |
| `location`                            | String  | City, state, country, or displayed location.                  |
| `isRemote`                            | Boolean | Whether the listing is marked remote.                         |
| `employmentTypes`                     | Array   | Employment labels such as Full-time, Contract, or Internship. |
| `locationTypes`                       | Array   | Work style labels such as Remote, Hybrid, or On-site.         |
| `jobType`                             | String  | Combined job type summary.                                    |
| `salary`                              | String  | Human-readable compensation range.                            |
| `salaryMin` / `salaryMax`             | Number  | Published compensation bounds in the source interval.         |
| `salaryInterval`                      | String  | Compensation interval such as hourly, monthly, or annual.     |
| `salaryMinAnnual` / `salaryMaxAnnual` | Number  | Annualized compensation when conversion is possible.          |
| `salaryCurrency`                      | String  | Compensation currency.                                        |
| `description`                         | String  | Full description when supplied by the listing payload.        |
| `shortDescription`                    | String  | Short listing summary when available.                         |
| `benefits`                            | String  | Benefits text when published.                                 |
| `postedDate`                          | String  | Published posting timestamp or date.                          |
| `daysAgo`                             | Number  | Listing age when supplied by the source.                      |
| `url`                                 | String  | ZipRecruiter job page or listing URL.                         |
| `externalApplyUrl`                    | String  | Employer application URL when available.                      |
| `companyLogoUrl`                      | String  | Employer logo URL when available.                             |
| `listingKey`                          | String  | Stable ZipRecruiter listing identifier when available.        |
| `source`                              | String  | Collection source used for the record.                        |
| `provider`                            | String  | Provider label matching `source`.                             |
| `searchQuery`                         | String  | Keyword used for the run.                                     |
| `searchLocation`                      | String  | Location used for the run.                                    |
| `page`                                | Number  | Result page number.                                           |
| `offset`                              | Number  | First-page offset when supplied by the source.                |
| `scrapedAt`                           | String  | ISO timestamp for collection.                                 |

Each record also includes additional listing metadata when ZipRecruiter publishes it: `matchId`, `isActive`, `isNew`, `salarySource`, `companyId`, `companyCanonicalName`, `companyUrl`, `companyLogoSource`, `locationCity`, `locationState`, `locationStateCode`, `locationCountry`, `locationCountryCode`, `locationCounty`, `locationLocId`, `locationGranularity`, `locationAreaSize`, `locationUrl`, `applyType`, `applyDestination`, `jobRedirectPageUrl`, `seoJobRedirectPageUrl`, `shareShortUrl`, `openSeatId`, `displayPay`, `displayLocationTypes`, `rollingPostedAt`, `postedTime`, and `updatedAt`.

## How to use the Actor

1. Open the Actor in Apify Console.
2. Enter a `searchQuery` with an optional `location`, or leave both empty to use the default `searchUrl`.
3. Set the number of jobs and maximum pages.
4. Choose an optional posting-age filter.
5. Run the Actor and download the dataset or connect it to your workflow.

ZipRecruiter can restrict datacenter traffic. The default proxy preference uses US residential Apify Proxy for cloud runs. Proxy availability and target access can vary by run.

## Input Parameters

| Parameter            | Type    | Required | Default                                | Description                                                                                  |
| -------------------- | ------- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `searchUrl`          | String  | No       | Software engineer in the United States | ZipRecruiter search URL. Used when `searchQuery` and `location` are empty.                   |
| `searchQuery`        | String  | No       | -                                      | Job title or keyword search. Takes precedence over `location` and `searchUrl`.               |
| `location`           | String  | No       | -                                      | Optional city, state, country, or remote location filter. Takes precedence over `searchUrl`. |
| `maxJobs`            | Integer | No       | `20`                                   | Maximum jobs to save. Use `0` to continue until page limits or source results are exhausted. |
| `maxPages`           | Integer | No       | `10`                                   | Maximum result pages to open.                                                                |
| `daysBack`           | String  | No       | `any`                                  | Allowed values: `any`, `1`, `3`, `7`, `14`, or `30`.                                         |
| `proxyConfiguration` | Object  | No       | US residential Apify Proxy             | Apify Proxy configuration. Residential access is recommended for ZipRecruiter.               |

## Usage Examples

### Basic keyword search

Collect software engineering jobs in New York:

```json
{
    "searchQuery": "software engineer",
    "location": "New York, NY",
    "maxJobs": 50,
    "maxPages": 5
}
```

### Use a ZipRecruiter search URL

Provide a URL copied from a ZipRecruiter results page. The URL is used when no keyword or location is supplied:

```json
{
    "searchUrl": "https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote",
    "maxJobs": 100,
    "maxPages": 10
}
```

### Recent jobs with residential proxies

Collect fresh product manager jobs through US residential Apify Proxy:

```json
{
    "searchQuery": "product manager",
    "location": "California",
    "daysBack": "7",
    "maxJobs": 200,
    "maxPages": 20,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## Sample Output

```json
{
    "title": "Senior Software Engineer",
    "company": "Example Technology Inc.",
    "location": "Austin, TX",
    "isRemote": false,
    "employmentTypes": ["Full-time"],
    "locationTypes": ["On-site"],
    "locationType": "On-site",
    "jobType": "Full-time",
    "salary": "$120,000 - $150,000 / annual",
    "salaryMin": 120000,
    "salaryMax": 150000,
    "salaryInterval": "annual",
    "salaryCurrency": "USD",
    "salaryMinAnnual": 120000,
    "salaryMaxAnnual": 150000,
    "description": "Design and build reliable software services for a growing product team.",
    "shortDescription": "Build backend services and collaborate with product and infrastructure teams.",
    "url": "https://www.ziprecruiter.com/jobs//j?lvk=example-listing",
    "externalApplyUrl": "https://careers.example.com/jobs/example-listing",
    "listingKey": "example-listing",
    "source": "ziprecruiter_json",
    "provider": "ziprecruiter_json",
    "searchQuery": "software engineer",
    "searchLocation": "Austin, TX",
    "page": 1,
    "offset": 0,
    "scrapedAt": "2026-09-15T10:30:00.000Z"
}
```

## Tips for best results

- Use specific search terms such as `registered nurse`, `warehouse supervisor`, or `senior data analyst`.
- Add a city, state, or country to reduce unrelated results.
- Start with `maxJobs` between 5 and 20 when checking a new search.
- Use `daysBack` for recurring hiring alerts and monitoring.
- Keep the US residential proxy preference enabled for cloud runs when ZipRecruiter restricts direct access.
- Review several records before treating missing salary, benefits, or logo values as an extraction issue. Those fields are optional on the source listing.
- Use a moderate `maxPages` value for scheduled runs and increase it only when you need a larger snapshot.

## Integrations and exports

Apify datasets can be used with:

- **JSON** - Application and engineering workflows.
- **CSV** - Spreadsheet analysis and reporting.
- **Excel** - Business reports and recruiting reviews.
- **Google Sheets** - Shared hiring research tables.
- **Airtable** - Searchable recruiting and market databases.
- **Webhooks** - Trigger downstream processing after a run.
- **Make or Zapier** - Connect job data to business applications.
- **Apify API** - Retrieve datasets programmatically.

## Frequently Asked Questions

### Do I need both `searchUrl` and `searchQuery`?

No. Use `searchQuery` with an optional `location`, or use `searchUrl` by itself. When `searchQuery` is supplied it takes precedence, then `location`, then `searchUrl`.

### How many jobs can I collect?

Set `maxJobs` to the desired limit. Set it to `0` to continue until `maxPages` or the available results stop the run.

### Can I collect only recent jobs?

Yes. Set `daysBack` to `1`, `3`, `7`, `14`, or `30`.

### Why does a run need a proxy?

ZipRecruiter may restrict datacenter traffic. US residential Apify Proxy is the default cloud preference because it provides geographically consistent access. No proxy service guarantees access to every target response.

### Why are some fields missing?

Some job postings do not publish salary, benefits, company logos, descriptions, or external application links. Empty values are omitted from the dataset.

### Can I schedule this Actor?

Yes. Create an Apify schedule to refresh a search hourly, daily, weekly, or on a custom interval.

### Is the data available as CSV or Excel?

Yes. Apify provides CSV, Excel, JSON, and other dataset export formats.

## Run locally

Requires Python 3.12 or newer.

```bash
pip install -r requirements.txt
python -m src
```

Local input is read from `storage/key_value_stores/default/INPUT.json`. Parser tests: `python -m unittest discover -s test`.

## Support

For issues or feature requests, use the support and issue channels available for this Actor in Apify Console.

## Legal Notice

This Actor is intended for legitimate collection of public job information. You are responsible for complying with ZipRecruiter terms, applicable law, privacy requirements, and any restrictions on data use in your jurisdiction.

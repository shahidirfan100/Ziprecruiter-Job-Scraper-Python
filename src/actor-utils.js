export function asArray(value) {
    return Array.isArray(value) ? value : [];
}

export function hasValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

export function normalizeInputString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function firstValue(...values) {
    return values.find((value) => value !== null && value !== undefined && value !== '');
}

function decodeUrlFragment(value) {
    try {
        return decodeURIComponent(String(value)).replace(/\+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    } catch {
        return String(value).trim();
    }
}

export function parseSearchUrl(searchUrl) {
    if (!searchUrl) return { searchQuery: '', location: '', daysBack: 'any', page: 1 };

    const parsed = new URL(searchUrl);
    const pathnameParts = parsed.pathname.split('/').filter(Boolean);
    let searchQuery = normalizeInputString(parsed.searchParams.get('search') || parsed.searchParams.get('q') || '');
    let location = normalizeInputString(parsed.searchParams.get('location') || '');
    const daysBack =
        normalizeInputString(parsed.searchParams.get('days') || parsed.searchParams.get('days_ago') || 'any') || 'any';
    const page = Math.max(Number(parsed.searchParams.get('page')) || 1, 1);

    if (!searchQuery && pathnameParts[0]?.toLowerCase() === 'jobs' && pathnameParts[1]) {
        searchQuery = decodeUrlFragment(pathnameParts[1]);
    }
    if (!location) {
        const locationSegment = pathnameParts.find((part) => part.toLowerCase().startsWith('-in-'));
        if (locationSegment) location = decodeUrlFragment(locationSegment.slice(4));
    }
    return { searchQuery, location, daysBack, page };
}

// Search modes are isolated. A caller-supplied keyword wins over a location,
// which wins over a search URL. The search URL also has a schema default, so it
// must lose to explicitly supplied modes or the default would contaminate them.
export function resolveEffectiveSearch(input) {
    const searchQuery = normalizeInputString(input.searchQuery);
    const location = normalizeInputString(input.location);
    const searchUrl = normalizeInputString(input.searchUrl);
    const daysBack = normalizeInputString(input.daysBack) || 'any';

    if (searchQuery) {
        return { mode: 'keyword', searchUrl: '', searchQuery, location, daysBack, startPage: 1 };
    }
    if (location) {
        return { mode: 'location', searchUrl: '', searchQuery: '', location, daysBack, startPage: 1 };
    }
    if (searchUrl) {
        const parsed = parseSearchUrl(searchUrl);
        return {
            mode: 'url',
            searchUrl,
            searchQuery: parsed.searchQuery,
            location: parsed.location,
            daysBack: parsed.daysBack !== 'any' ? parsed.daysBack : daysBack,
            startPage: parsed.page,
        };
    }
    return { mode: 'none', searchUrl: '', searchQuery: '', location: '', daysBack, startPage: 1 };
}

function numberOrNull(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
    if (typeof value === 'boolean') return value;
    return /^(true|1|yes)$/i.test(String(value || '').trim());
}

function locationText(location) {
    if (!location) return '';
    if (typeof location === 'string') return location;
    return (
        location.displayName ||
        [location.city, location.stateCode || location.state, location.countryCode].filter(Boolean).join(', ')
    );
}

const employmentTypeNames = {
    1: 'Full-time',
    2: 'Part-time',
    3: 'Contract',
    4: 'Internship',
    5: 'Temporary',
};

export function extractEmbeddedJson(scriptTexts) {
    for (const text of asArray(scriptTexts)) {
        try {
            const data = JSON.parse(text);
            if (data?.hydrateJobCardsResponse?.jobCards) return data;
        } catch {
            // Ignore unrelated JSON scripts.
        }
    }
    throw new Error('ZipRecruiter page did not contain the expected embedded job data.');
}

const NEXT_FLIGHT_MARKER = 'self.__next_f.push(';

function extractBalanced(text, start, open, close) {
    if (start < 0 || text[start] !== open) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === open) depth += 1;
        else if (character === close && --depth === 0) {
            try {
                return JSON.parse(text.slice(start, index + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

function extractBalancedObject(text, start) {
    return extractBalanced(text, start, '{', '}');
}

function objectAfterMarker(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    return extractBalancedObject(text, text.indexOf('{', markerIndex + marker.length));
}

// Next.js streams the flight payload as many `self.__next_f.push([1, "..."])`
// fragments. Joining them in document order reconstructs the full RSC stream so
// the job payload is found even when it is split across multiple chunks.
function collectNextFlightFragments(scriptTexts) {
    const fragments = [];
    for (const scriptText of asArray(scriptTexts)) {
        let searchFrom = 0;
        while (searchFrom < scriptText.length) {
            const markerIndex = scriptText.indexOf(NEXT_FLIGHT_MARKER, searchFrom);
            if (markerIndex < 0) break;
            const argumentStart = scriptText.indexOf('[', markerIndex + NEXT_FLIGHT_MARKER.length);
            const payload = extractBalanced(scriptText, argumentStart, '[', ']');
            if (Array.isArray(payload) && typeof payload[1] === 'string') fragments.push(payload[1]);
            searchFrom = markerIndex + NEXT_FLIGHT_MARKER.length;
        }
    }
    return fragments;
}

export function extractNextFlightStream(scriptTexts) {
    return collectNextFlightFragments(scriptTexts).join('');
}

function numberFromFlight(flightText, key) {
    const match = flightText.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    return match ? Number(match[1]) : null;
}

// The current page shape stores job cards directly in a container that also
// holds jobKeys and totalListings. The container position is not fixed, so walk
// backwards from the jobCards key and accept the first balanced object that
// actually contains a non-empty jobCards array.
function findJobCardsContainer(flightText) {
    const cardsIndex = flightText.indexOf('"jobCards"');
    if (cardsIndex < 0) return null;

    const isContainer = (payload) => {
        if (!payload || !Array.isArray(payload.jobCards)) return false;
        return (
            payload.jobCards.length > 0 ||
            asArray(payload.jobKeys).length > 0 ||
            payload.totalListings !== undefined ||
            payload.placementId !== undefined
        );
    };

    const anchors = ['{"jobKeys"', '{"jobCards"', '{"totalListings"'];
    for (const anchor of anchors) {
        let position = flightText.lastIndexOf(anchor, cardsIndex);
        while (position >= 0) {
            const payload = extractBalancedObject(flightText, position);
            if (isContainer(payload)) {
                return {
                    cards: asArray(payload.jobCards),
                    totalListings: Number(payload.totalListings) || null,
                };
            }
            position = flightText.lastIndexOf(anchor, position - 1);
        }
    }

    let position = cardsIndex;
    for (let guard = 0; guard < 4000; guard += 1) {
        position = flightText.lastIndexOf('{', position - 1);
        if (position < 0) break;
        const payload = extractBalancedObject(flightText, position);
        if (isContainer(payload)) {
            return {
                cards: asArray(payload.jobCards),
                totalListings: Number(payload.totalListings) || null,
            };
        }
    }
    return null;
}

function findJobDetails(flightText) {
    const detailsIndex = flightText.indexOf('"jobDetails"');
    if (detailsIndex < 0) return null;

    let position = detailsIndex;
    for (let guard = 0; guard < 600; guard += 1) {
        position = flightText.lastIndexOf('{', position - 1);
        if (position < 0) break;
        const payload = extractBalancedObject(flightText, position);
        const details = payload?.rsp?.jobDetails || payload?.jobDetails;
        if (details && typeof details === 'object') return details;
    }
    return null;
}

export function extractNextFlightData(scriptTexts) {
    const flightText = extractNextFlightStream(scriptTexts);
    if (!flightText) {
        throw new Error('ZipRecruiter page did not contain a supported Next.js job payload.');
    }

    const current = findJobCardsContainer(flightText);
    if (current) {
        const { cards } = current;
        const page = numberFromFlight(flightText, 'pageNumber') || 1;
        const totalListings = current.totalListings || numberFromFlight(flightText, 'jobCount') || cards.length;
        const maxPages = cards.length ? Math.max(page, Math.ceil(totalListings / cards.length)) : page;

        return {
            hydrateJobCardsResponse: { jobCards: cards },
            getJobDetailsResponse: { jobDetails: findJobDetails(flightText) },
            page,
            maxPages,
            totalListings,
            layout: 'flight-jobcards',
        };
    }

    const cardsPayload = objectAfterMarker(flightText, 'serializedJobCardsData');
    const jobKeysMap = cardsPayload?.jobKeysMap;
    if (jobKeysMap && typeof jobKeysMap === 'object') {
        const jobCards = asArray(cardsPayload.jobKeys)
            .map((jobKey) => jobKeysMap[jobKey?.listingKey])
            .filter(Boolean);
        const fallbackCards = Object.values(jobKeysMap);
        const cards = jobCards.length ? jobCards : fallbackCards;
        const detailsPayload = objectAfterMarker(flightText, 'serializedJobDetailsData');
        const page = numberFromFlight(flightText, 'pageNumber') || 1;
        const totalListings = Number(cardsPayload.totalListings) || cards.length;
        const maxPages = cards.length ? Math.max(page, Math.ceil(totalListings / cards.length)) : page;

        return {
            hydrateJobCardsResponse: { jobCards: cards },
            getJobDetailsResponse: { jobDetails: detailsPayload?.jobDetails || null },
            page,
            maxPages,
            totalListings,
            layout: 'serialized-jobcards',
        };
    }
    throw new Error('ZipRecruiter page did not contain a supported Next.js job payload.');
}

export function extractScriptTextsFromHtml(html) {
    if (typeof html !== 'string' || !html) return [];
    const scripts = [];
    const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html))) {
        const text = match[1].trim();
        if (text) scripts.push(text);
    }
    return scripts;
}

export function extractEmbeddedJsonFromHtml(html) {
    try {
        return extractEmbeddedJson(extractScriptTextsFromHtml(html));
    } catch {
        const payload = objectAfterMarker(String(html || ''), 'hydrateJobCardsResponse');
        if (payload?.jobCards) return { hydrateJobCardsResponse: payload };
        throw new Error('ZipRecruiter page did not contain the expected embedded job data.');
    }
}

export function extractListingKeyFromUrl(value) {
    if (!value) return '';
    try {
        const parsed = new URL(String(value), 'https://www.ziprecruiter.com');
        return parsed.searchParams.get('jid') || parsed.searchParams.get('lvk') || '';
    } catch {
        return '';
    }
}

export function extractJsonLdItemList(html) {
    if (typeof html !== 'string' || !html) return [];
    const items = [];
    const regex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html))) {
        let parsed;
        try {
            parsed = JSON.parse(match[1].trim());
        } catch {
            continue;
        }
        for (const block of Array.isArray(parsed) ? parsed : [parsed]) {
            if (block?.['@type'] !== 'ItemList') continue;
            for (const item of asArray(block.itemListElement)) {
                const url = typeof item?.url === 'string' ? item.url : '';
                const title = typeof item?.name === 'string' ? item.name : '';
                if (!url && !title) continue;
                items.push({
                    listingKey: extractListingKeyFromUrl(url),
                    title,
                    rawCanonicalZipJobPageUrl: url,
                });
            }
        }
    }
    return items;
}

export function parseSearchHtml(html) {
    const scripts = extractScriptTextsFromHtml(html);
    try {
        return extractEmbeddedJson(scripts);
    } catch {
        // Fall through to the Next.js flight payload.
    }
    try {
        return extractNextFlightData(scripts);
    } catch {
        // Fall through to the whole-document embedded JSON marker.
    }
    try {
        return extractEmbeddedJsonFromHtml(html);
    } catch {
        // Fall through to the JSON-LD ItemList fallback.
    }
    const jsonLdCards = extractJsonLdItemList(html);
    return jsonLdCards.length ? { hydrateJobCardsResponse: { jobCards: jsonLdCards } } : null;
}

const BLOCK_TITLE_PATTERN =
    /just a moment|attention required|access denied|are you a robot|verify you are human|unusual traffic/i;
const BLOCK_BODY_PATTERN =
    /just a moment\.\.\.|enable javascript and cookies to continue|__cf_chl_|cf-chl-|verifying you are human/i;

export function detectBlockedPage({ status, title = '', body = '' } = {}) {
    const code = Number(status) || 0;
    if (code === 403 || code === 429 || code === 503) return true;
    if (BLOCK_TITLE_PATTERN.test(title)) return true;
    return BLOCK_BODY_PATTERN.test(String(body || ''));
}

export function responseSnapshot({ url, status, title, body, contentType, transport, profile } = {}) {
    const text = typeof body === 'string' ? body : '';
    return {
        url,
        status: Number(status) || 0,
        contentType: contentType || '',
        title: String(title || '').slice(0, 120),
        bodyLength: text.length,
        transport: transport || '',
        profile: profile || '',
        blocked: detectBlockedPage({ status, title, body: text }),
        markers: {
            embedded: text.includes('hydrateJobCardsResponse'),
            nextFlight: text.includes('self.__next_f.push') || text.includes('serializedJobCardsData'),
            jobCards: text.includes('"jobCards"'),
            jsonLd: text.includes('ItemList') || text.includes('JobPosting'),
        },
    };
}

function enumDisplayName(value, prefix, names = {}) {
    const rawValue = value?.name ?? value;
    if (rawValue === null || rawValue === undefined || rawValue === '') return '';
    if (typeof rawValue === 'number') return names[rawValue] || String(rawValue);

    const normalized = String(rawValue)
        .replace(new RegExp(`^${prefix}`), '')
        .toLowerCase();
    if (names[normalized]) return names[normalized];
    return normalized
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('-');
}

function normalizeCurrency(value) {
    const normalized = String(value || 'USD')
        .replace(/^PAY_CURRENCY_/i, '')
        .toUpperCase();
    return /^[A-Z]{3}$/.test(normalized) ? normalized : 'USD';
}

function benefitsText(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => enumDisplayName(item, 'BENEFIT_TYPE_NAME_', {}))
            .filter((label) => label && !/^\d+$/.test(label))
            .join(' · ');
    }
    return typeof value === 'string' ? value : '';
}

function displayList(value) {
    if (!value) return [];
    if (typeof value === 'string') {
        return value
            .split(/[,·|]/)
            .map((part) => part.trim())
            .filter(Boolean);
    }
    return displayList(value.fullDisplay || value.compactDisplay || '');
}

function timestampToIso(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'object' && value.seconds !== undefined) {
        const milliseconds = Number(value.seconds) * 1000 + Math.floor(Number(value.nanos || 0) / 1_000_000);
        return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? new Date(value).toISOString() : '';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

const locationTypeNames = { 1: 'On-site', 2: 'Remote', 3: 'Hybrid' };

export function adaptWebCard(card, details = null) {
    const listingKey = firstValue(card.listingKey, card.listing_key);
    const pay = card.pay || details?.pay || {};
    const display = card.display || details?.display || {};
    const mappedEmploymentTypes = asArray(card.employmentTypes || details?.employmentTypes)
        .map((item) =>
            enumDisplayName(item, 'EMPLOYMENT_TYPE_NAME_', {
                ...employmentTypeNames,
                full_time: 'Full-time',
                part_time: 'Part-time',
            }),
        )
        .filter(Boolean);
    const mappedLocationTypes = asArray(card.locationTypes || details?.locationTypes)
        .map((item) => enumDisplayName(item, 'LOCATION_TYPE_NAME_', locationTypeNames))
        .filter(Boolean);
    const employmentTypes = displayList(display.employmentTypes);
    const normalizedEmploymentTypes = employmentTypes.length ? employmentTypes : mappedEmploymentTypes;
    const locationTypes = displayList(display.locationTypesV2 || display.locationTypes);
    const normalizedLocationTypes = locationTypes.length ? locationTypes : mappedLocationTypes;
    const canonicalPath = firstValue(card.rawCanonicalZipJobPageUrl, card.canonicalUrl);
    let jobUrl = '';
    if (canonicalPath?.startsWith('http')) jobUrl = canonicalPath;
    else if (canonicalPath) jobUrl = `https://www.ziprecruiter.com${canonicalPath}`;
    else if (listingKey) jobUrl = `https://www.ziprecruiter.com/jobs//j?lvk=${listingKey}`;

    const location = card.location || details?.location || {};

    return {
        listing_key: listingKey,
        match_id: card.matchId,
        title: firstValue(card.title, details?.title),
        company: firstValue(card.company?.name, card.companyName, details?.company?.name, details?.hiringCompany?.name),
        company_id: firstValue(card.company?.id, details?.company?.id),
        company_canonical_name: firstValue(card.company?.canonicalDisplayName, details?.company?.canonicalDisplayName),
        company_url: firstValue(card.companyUrl, details?.companyUrl),
        location: firstValue(display.location, locationText(card.location), card.locationText, details?.location),
        location_city: location.city,
        location_state: location.state,
        location_state_code: location.stateCode,
        location_country: location.country,
        location_country_code: location.countryCode,
        location_county: location.county,
        location_loc_id: location.locId,
        location_granularity: location.granularityType,
        location_area_size: numberOrNull(location.areaSize),
        location_url: card.locationUrl,
        is_remote:
            booleanValue(card.isRemote) ||
            booleanValue(card.location?.isRemote) ||
            [...normalizedLocationTypes, String(display.locationTypes || '')].some((value) => /remote/i.test(value)),
        job_type: firstValue(card.jobType, display.employmentTypes?.fullDisplay, normalizedEmploymentTypes.join(' · ')),
        employment_types: normalizedEmploymentTypes,
        location_types: normalizedLocationTypes,
        salary: {
            min: numberOrNull(pay.min),
            max: numberOrNull(pay.max),
            min_annual: numberOrNull(pay.minAnnual),
            max_annual: numberOrNull(pay.maxAnnual),
            interval: pay.interval,
            currency: normalizeCurrency(pay.currency),
            source: pay.metadata?.sourceType,
        },
        company_logo: firstValue(
            card.company?.logoUrl,
            card.companyLogo?.logoUrl,
            card.companyLogoUrl,
            details?.companyLogoUrl,
        ),
        company_logo_source: card.companyLogo?.source,
        job_redirect_url: jobUrl,
        external_apply_url: firstValue(
            card.applyButtonConfig?.externalApplyUrl,
            card.buttonConfig?.externalApplyUrl,
            details?.externalApplyUrl,
        ),
        apply_type: firstValue(card.applyButtonConfig?.applyButtonType, card.buttonConfig?.buttonType),
        apply_destination: firstValue(card.applyButtonConfig?.destination, card.buttonConfig?.destination),
        job_redirect_page_url: card.jobRedirectPageUrl,
        seo_job_redirect_page_url: card.seoJobRedirectPageUrl,
        share_short_url: card.shareShortUrl,
        open_seat_id: card.openSeatId,
        benefits: firstValue(
            display.benefits,
            details?.display?.benefits,
            benefitsText(firstValue(card.benefits, details?.benefits)),
        ),
        days_ago: firstValue(numberOrNull(card.daysAgo), parseDaysAgo(display.rollingPostedAt)),
        description: firstValue(
            cleanDescription(details?.htmlFullDescription),
            cleanDescription(card.htmlFullDescription),
            cleanDescription(card.description),
        ),
        short_description: firstValue(card.shortDescription, details?.shortDescription),
        posted_at: timestampToIso(firstValue(card.status?.postedAtUtc, card.postedAtUtc, details?.status?.postedAtUtc)),
        rolling_posted_at: timestampToIso(
            firstValue(card.status?.rollingPostedAtUtc, card.status?.postedAtUtc, details?.status?.rollingPostedAtUtc),
        ),
        updated_at: timestampToIso(card.updatedAt),
        is_active: firstValue(card.status?.isActive, details?.status?.isActive),
        is_new: firstValue(card.isNew, details?.isNew),
        display_pay: firstValue(display.pay?.text, details?.display?.pay?.text),
        display_location_types: firstValue(display.locationTypesV2?.fullDisplay, display.locationTypes),
        posted_time: firstValue(display.rollingPostedAt, details?.display?.rollingPostedAt),
        source: 'ziprecruiter_json',
    };
}

// Next.js flight payloads replace large values with references such as "$2d".
// Those are not real text, so they are rejected instead of saved as a description.
function cleanDescription(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    if (/^\$[0-9a-f]+$/i.test(text)) return '';
    if (text.length < 30) return '';
    return text;
}

function parseDaysAgo(text) {
    const value = String(text || '')
        .toLowerCase()
        .trim();
    if (!value) return null;
    if (/today|just posted|new label/.test(value)) return 0;
    if (/yesterday/.test(value)) return 1;
    const match = value.match(/(\d+)\s*(minute|hour|day|week|month)/);
    if (!match) return null;
    const multipliers = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30 };
    const days = Number(match[1]) * (multipliers[match[2]] || 1);
    return Math.round(days * 100) / 100;
}

const payIntervalNames = { 1: 'hourly', 2: 'daily', 3: 'weekly', 4: 'monthly', 5: 'annual' };

function normalizeInterval(interval) {
    if (typeof interval === 'number' || /^\d+$/.test(String(interval || '')))
        return payIntervalNames[Number(interval)] || '';
    const normalized = String(interval || '').toLowerCase();
    const enumIntervals = {
        pay_interval_hour: 'hourly',
        pay_interval_hourly: 'hourly',
        pay_interval_day: 'daily',
        pay_interval_daily: 'daily',
        pay_interval_week: 'weekly',
        pay_interval_weekly: 'weekly',
        pay_interval_month: 'monthly',
        pay_interval_monthly: 'monthly',
        pay_interval_year: 'annual',
        pay_interval_annual: 'annual',
        pay_interval_yearly: 'annual',
    };
    return enumIntervals[normalized] || (normalized === 'yearly' ? 'annual' : normalized);
}

function annualAmount(amount, interval) {
    if (!Number.isFinite(amount)) return null;
    const multipliers = { hourly: 2080, daily: 260, weekly: 52, monthly: 12, annual: 1, yearly: 1 };
    const multiplier = multipliers[normalizeInterval(interval)];
    return multiplier ? amount * multiplier : null;
}

function formatSalary(min, max, interval, currency = 'USD') {
    if (!Number.isFinite(min) && !Number.isFinite(max)) return '';
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
    const unit = normalizeInterval(interval) || 'annual';
    if (Number.isFinite(min) && Number.isFinite(max))
        return `${formatter.format(min)} - ${formatter.format(max)} / ${unit}`;
    if (Number.isFinite(min)) return `${formatter.format(min)}+ / ${unit}`;
    return `Up to ${formatter.format(max)} / ${unit}`;
}

function splitJobType(jobTypeText, isRemote, employmentTypes = [], locationTypes = []) {
    const parts = String(jobTypeText || '')
        .split('·')
        .map((part) => part.trim())
        .filter(Boolean);
    const normalizedEmployment = employmentTypes.length ? employmentTypes : [];
    if (!normalizedEmployment.length && parts[0]) normalizedEmployment.push(parts[0]);
    const normalizedLocation = locationTypes.length ? locationTypes : [];
    if (!normalizedLocation.length) {
        if (isRemote || parts.some((part) => /remote/i.test(part))) normalizedLocation.push('Remote');
        else if (parts.some((part) => /hybrid/i.test(part))) normalizedLocation.push('Hybrid');
        else if (parts.some((part) => /on[\s-]?site/i.test(part))) normalizedLocation.push('On-site');
    }
    return {
        employmentTypes: normalizedEmployment,
        locationTypes: normalizedLocation,
        jobType: parts.join(' · ') || normalizedEmployment.join(' · '),
    };
}

export function normalizeJobRecord(result, context) {
    const salary = result.salary || {};
    const min = numberOrNull(firstValue(salary.min, salary.min_amount, salary.min_annual));
    const max = numberOrNull(firstValue(salary.max, salary.max_amount, salary.max_annual));
    const interval = normalizeInterval(
        salary.interval || (salary.min_annual !== null || salary.max_annual !== null ? 'annual' : ''),
    );
    const minAnnual =
        salary.min_annual !== null && salary.min_annual !== undefined
            ? numberOrNull(salary.min_annual)
            : annualAmount(min, interval);
    const maxAnnual =
        salary.max_annual !== null && salary.max_annual !== undefined
            ? numberOrNull(salary.max_annual)
            : annualAmount(max, interval);
    const remote = booleanValue(result.is_remote);
    const { employmentTypes, locationTypes, jobType } = splitJobType(
        result.job_type,
        remote,
        asArray(result.employment_types).map(String),
        asArray(result.location_types).map(String),
    );

    return {
        title: String(result.title || ''),
        company: String(result.company || ''),
        companyId: String(result.company_id || ''),
        companyCanonicalName: String(result.company_canonical_name || ''),
        companyUrl: String(result.company_url || ''),
        location: String(result.location || ''),
        locationCity: String(result.location_city || ''),
        locationState: String(result.location_state || ''),
        locationStateCode: String(result.location_state_code || ''),
        locationCountry: String(result.location_country || ''),
        locationCountryCode: String(result.location_country_code || ''),
        locationCounty: String(result.location_county || ''),
        locationLocId: String(result.location_loc_id || ''),
        locationGranularity: String(result.location_granularity || ''),
        locationAreaSize: numberOrNull(result.location_area_size),
        locationUrl: String(result.location_url || ''),
        isRemote: remote,
        isActive:
            result.is_active === undefined || result.is_active === null ? undefined : booleanValue(result.is_active),
        isNew: result.is_new === undefined || result.is_new === null ? undefined : booleanValue(result.is_new),
        jobType,
        employmentTypes,
        locationTypes,
        locationType: locationTypes.join(', '),
        salary: formatSalary(min, max, interval, result.salary?.currency || 'USD'),
        salaryMin: min,
        salaryMax: max,
        salaryInterval: interval,
        salaryCurrency: result.salary?.currency || 'USD',
        salaryMinAnnual: minAnnual,
        salaryMaxAnnual: maxAnnual,
        salarySource: String(result.salary?.source || ''),
        companyLogoUrl: String(result.company_logo || ''),
        companyLogoSource: String(result.company_logo_source || ''),
        url: String(result.job_redirect_url || ''),
        externalApplyUrl: String(result.external_apply_url || ''),
        applyType: String(result.apply_type || ''),
        applyDestination: String(result.apply_destination || ''),
        jobRedirectPageUrl: String(result.job_redirect_page_url || ''),
        seoJobRedirectPageUrl: String(result.seo_job_redirect_page_url || ''),
        shareShortUrl: String(result.share_short_url || ''),
        openSeatId: String(result.open_seat_id || ''),
        benefits: String(result.benefits || ''),
        description: String(result.description || ''),
        shortDescription: String(result.short_description || ''),
        displayPay: String(result.display_pay || ''),
        displayLocationTypes: String(result.display_location_types || ''),
        postedDate: String(result.posted_at || ''),
        rollingPostedAt: String(result.rolling_posted_at || ''),
        postedTime: String(result.posted_time || ''),
        updatedAt: String(result.updated_at || ''),
        daysAgo: numberOrNull(result.days_ago),
        listingKey: String(result.listing_key || ''),
        matchId: String(result.match_id || ''),
        source: result.source,
        provider: result.source,
        searchQuery: context.searchQuery,
        searchLocation: context.searchLocation,
        page: context.page,
        offset: context.offset,
        scrapedAt: new Date().toISOString(),
    };
}

export function buildJobIdentity(result) {
    const listingKey = normalizeInputString(result.listing_key || result.listingKey);
    if (listingKey) return `listing:${listingKey}`;
    const url = normalizeInputString(result.job_redirect_url || result.url || result.external_apply_url);
    if (url) {
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('utm_source');
            parsed.searchParams.delete('utm_medium');
            parsed.searchParams.delete('utm_campaign');
            return `url:${parsed.origin}${parsed.pathname}${parsed.search}`.toLowerCase();
        } catch {
            return `url:${url.toLowerCase()}`;
        }
    }
    return [result.title, result.company, result.location, result.job_type]
        .map((value) => normalizeInputString(value).toLowerCase())
        .join('|');
}

export function sanitizeRecordForDataset(record) {
    const sanitized = {};
    for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            const cleaned = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
            if (cleaned.length) sanitized[key] = cleaned;
            continue;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) sanitized[key] = trimmed;
            continue;
        }
        sanitized[key] = value;
    }
    return sanitized;
}

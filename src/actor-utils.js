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
    if (!searchUrl) return { searchQuery: '', location: '', daysBack: 'any' };

    const parsed = new URL(searchUrl);
    const pathnameParts = parsed.pathname.split('/').filter(Boolean);
    let searchQuery = normalizeInputString(parsed.searchParams.get('search') || parsed.searchParams.get('q') || '');
    let location = normalizeInputString(parsed.searchParams.get('location') || '');
    const daysBack = normalizeInputString(parsed.searchParams.get('days') || 'any') || 'any';

    if (!searchQuery && pathnameParts[0]?.toLowerCase() === 'jobs' && pathnameParts[1]) {
        searchQuery = decodeUrlFragment(pathnameParts[1]);
    }
    if (!location) {
        const locationSegment = pathnameParts.find((part) => part.toLowerCase().startsWith('-in-'));
        if (locationSegment) location = decodeUrlFragment(locationSegment.slice(4));
    }
    return { searchQuery, location, daysBack };
}

export function resolveEffectiveSearch(input) {
    const searchUrl = normalizeInputString(input.searchUrl);
    if (searchUrl) {
        const parsed = parseSearchUrl(searchUrl);
        return {
            searchUrl,
            searchQuery: parsed.searchQuery,
            location: parsed.location,
            daysBack: parsed.daysBack !== 'any' ? parsed.daysBack : normalizeInputString(input.daysBack) || 'any',
        };
    }
    return {
        searchUrl: '',
        searchQuery: normalizeInputString(input.searchQuery),
        location: normalizeInputString(input.location),
        daysBack: normalizeInputString(input.daysBack) || 'any',
    };
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

function extractNextFlightText(scriptText) {
    const marker = 'self.__next_f.push(';
    const start = scriptText.indexOf(marker);
    if (start < 0) return '';

    const argumentText = scriptText
        .slice(start + marker.length)
        .replace(/\)\s*;?\s*$/, '')
        .trim();
    try {
        const payload = JSON.parse(argumentText);
        return typeof payload?.[1] === 'string' ? payload[1] : '';
    } catch {
        return '';
    }
}

function extractBalancedObject(text, start) {
    if (start < 0 || text[start] !== '{') return null;

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
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) {
            try {
                return JSON.parse(text.slice(start, index + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

function objectAfterMarker(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    return extractBalancedObject(text, text.indexOf('{', markerIndex + marker.length));
}

export function extractNextFlightData(scriptTexts) {
    for (const scriptText of asArray(scriptTexts)) {
        const flightText = extractNextFlightText(scriptText);
        if (!flightText) continue;

        const cardsPayload = objectAfterMarker(flightText, 'serializedJobCardsData');
        const jobKeysMap = cardsPayload?.jobKeysMap;
        if (!jobKeysMap || typeof jobKeysMap !== 'object') continue;

        const jobCards = asArray(cardsPayload.jobKeys)
            .map((jobKey) => jobKeysMap[jobKey?.listingKey])
            .filter(Boolean);
        const fallbackCards = Object.values(jobKeysMap);
        const cards = jobCards.length ? jobCards : fallbackCards;
        if (!cards.length) continue;

        const detailsPayload = objectAfterMarker(flightText, 'serializedJobDetailsData');
        const page = Number(flightText.match(/"pageNumber"\s*:\s*(\d+)/)?.[1]) || 1;
        const totalListings = Number(cardsPayload.totalListings) || cards.length;
        const maxPages = Math.max(page, Math.ceil(totalListings / cards.length));

        return {
            hydrateJobCardsResponse: { jobCards: cards },
            getJobDetailsResponse: { jobDetails: detailsPayload?.jobDetails || null },
            page,
            maxPages,
        };
    }
    throw new Error('ZipRecruiter page did not contain a supported Next.js job payload.');
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
            .filter(Boolean)
            .join(' · ');
    }
    return typeof value === 'string' ? value : '';
}

export function adaptWebCard(card, details = null) {
    const listingKey = firstValue(card.listingKey, card.listing_key);
    const pay = card.pay || {};
    const employmentTypes = asArray(card.employmentTypes)
        .map((item) =>
            enumDisplayName(item, 'EMPLOYMENT_TYPE_NAME_', {
                ...employmentTypeNames,
                full_time: 'Full-time',
                part_time: 'Part-time',
            }),
        )
        .filter(Boolean);
    const locationTypes = asArray(card.locationTypes)
        .map((item) => enumDisplayName(item, 'LOCATION_TYPE_NAME_', { in_person: 'On-site' }))
        .filter(Boolean);
    const canonicalPath = firstValue(card.rawCanonicalZipJobPageUrl, card.canonicalUrl);
    let jobUrl = '';
    if (canonicalPath?.startsWith('http')) jobUrl = canonicalPath;
    else if (canonicalPath) jobUrl = `https://www.ziprecruiter.com${canonicalPath}`;
    else if (listingKey) jobUrl = `https://www.ziprecruiter.com/jobs//j?lvk=${listingKey}`;

    return {
        listing_key: listingKey,
        title: firstValue(card.title, details?.title),
        company: firstValue(card.company?.name, card.companyName, details?.hiringCompany?.name),
        location: locationText(card.location) || firstValue(card.locationText, details?.location),
        is_remote:
            booleanValue(card.isRemote) ||
            booleanValue(card.location?.isRemote) ||
            locationTypes.some((value) => /remote/i.test(value)),
        job_type: firstValue(card.jobType, employmentTypes.join(' · ')),
        employment_types: employmentTypes,
        location_types: locationTypes,
        salary: {
            min: numberOrNull(pay.min),
            max: numberOrNull(pay.max),
            interval: pay.interval,
            currency: normalizeCurrency(pay.currency),
        },
        company_logo: firstValue(card.company?.logoUrl, card.companyLogo?.logoUrl, card.companyLogoUrl),
        job_redirect_url: jobUrl,
        external_apply_url: firstValue(
            card.applyButtonConfig?.externalApplyUrl,
            card.buttonConfig?.externalApplyUrl,
            details?.externalApplyUrl,
        ),
        benefits: benefitsText(card.benefits ?? card.display?.benefits),
        days_ago: numberOrNull(card.daysAgo),
        description: firstValue(details?.htmlFullDescription, card.htmlFullDescription, card.description),
        short_description: card.shortDescription,
        posted_at: firstValue(card.status?.postedAtUtc, card.postedAtUtc),
        source: 'ziprecruiter_camoufox_json',
    };
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
        location: String(result.location || ''),
        isRemote: remote,
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
        companyLogoUrl: String(result.company_logo || ''),
        url: String(result.job_redirect_url || ''),
        externalApplyUrl: String(result.external_apply_url || ''),
        benefits: String(result.benefits || ''),
        description: String(result.description || ''),
        shortDescription: String(result.short_description || ''),
        postedDate: String(result.posted_at || ''),
        daysAgo: numberOrNull(result.days_ago),
        listingKey: String(result.listing_key || ''),
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

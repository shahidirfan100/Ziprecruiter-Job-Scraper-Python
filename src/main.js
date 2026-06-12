import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';

await Actor.init();

const CONFIG = {
    MCP_ENDPOINT: 'https://api.ziprecruiter.com/mcp',
    MCP_PAGE_SIZE: 5,
    DEFAULT_MAX_PAGES: 10,
    MAX_PAGES_HARD_LIMIT: 200,
    MAX_EMPTY_BATCHES: 3,
    REQUEST_TIMEOUT_MS: 30000,
    REQUEST_DELAY_MS: 400,
    RETRY_DELAY_MS: 2000,
    MAX_MCP_RETRIES: 3,
};

const INPUT_KEYS = ['searchUrl', 'searchQuery', 'location', 'maxJobs', 'maxPages', 'daysBack', 'proxyConfiguration', 'scrapeMode'];

const stats = {
    batchesProcessed: 0,
    recordsPushed: 0,
    duplicatesSkipped: 0,
    missingSalary: 0,
    missingBenefits: 0,
    missingCompanyLogo: 0,
    emptyBatches: 0,
    warnings: [],
    startTime: Date.now(),
};

const seenJobKeys = new Set();

function safeJsonParse(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function hasValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

async function readJsonFileIfExists(path, fallback = {}) {
    try {
        const content = await readFile(path, 'utf8');
        return safeJsonParse(content, fallback);
    } catch {
        return fallback;
    }
}

function getSchemaFallback(schema, key) {
    const field = schema?.properties?.[key];
    if (!field || typeof field !== 'object') return undefined;
    if (field.prefill !== undefined) return field.prefill;
    if (field.default !== undefined) return field.default;
    return undefined;
}

async function resolveInputWithFallbacks() {
    const runtimeInput = (await Actor.getInput()) || {};
    const schema = await readJsonFileIfExists('.actor/input_schema.json', {});
    const localInput = await readJsonFileIfExists('INPUT.json', {});

    const runtimeHasSearchFilters = hasValue(runtimeInput.searchQuery) || hasValue(runtimeInput.location);
    const runtimeHasSearchUrl = hasValue(runtimeInput.searchUrl);
    const userProvidedAny = Object.values(runtimeInput).some((value) => hasValue(value));
    const resolvedInput = { ...runtimeInput };
    const fallbackSources = {};

    for (const key of INPUT_KEYS) {
        if (hasValue(resolvedInput[key])) continue;

        if (key === 'searchUrl' && runtimeHasSearchFilters && !runtimeHasSearchUrl) continue;

        const schemaFallback = getSchemaFallback(schema, key);
        if (hasValue(schemaFallback)) {
            resolvedInput[key] = schemaFallback;
            fallbackSources[key] = 'input_schema';
            continue;
        }

        if (hasValue(localInput[key])) {
            resolvedInput[key] = localInput[key];
            fallbackSources[key] = 'INPUT.json';
        }
    }

    return { resolvedInput, fallbackSources, userProvidedAny };
}

function normalizeInputString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function decodeUrlFragment(value) {
    if (!value) return '';

    return decodeURIComponent(String(value))
        .replace(/\+/g, ' ')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseSearchUrl(searchUrl) {
    if (!searchUrl) {
        return {
            searchQuery: '',
            location: '',
            daysBack: 'any',
        };
    }

    try {
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
            if (locationSegment) {
                location = decodeUrlFragment(locationSegment.slice(4));
            }
        }

        return { searchQuery, location, daysBack };
    } catch {
        return {
            searchQuery: '',
            location: '',
            daysBack: 'any',
        };
    }
}

function resolveEffectiveSearch(input) {
    const rawSearchUrl = normalizeInputString(input.searchUrl);
    const rawSearchQuery = normalizeInputString(input.searchQuery);
    const rawLocation = normalizeInputString(input.location);

    const hasSearchUrl = Boolean(rawSearchUrl);
    const hasSearchFilters = Boolean(rawSearchQuery || rawLocation);
    const useSearchUrl = hasSearchUrl && !hasSearchFilters;

    if (useSearchUrl) {
        const parsedFromUrl = parseSearchUrl(rawSearchUrl);
        return {
            searchUrl: rawSearchUrl,
            searchQuery: parsedFromUrl.searchQuery,
            location: parsedFromUrl.location,
            daysBack: parsedFromUrl.daysBack || input.daysBack || 'any',
        };
    }

    return {
        searchUrl: '',
        searchQuery: rawSearchQuery,
        location: rawLocation,
        daysBack: input.daysBack || 'any',
    };
}

function daysBackToMinutes(daysBack) {
    const numericDays = Number(daysBack);
    if (!Number.isFinite(numericDays) || numericDays <= 0) return undefined;
    return numericDays * 24 * 60;
}

function formatSalary(minAnnual, maxAnnual) {
    if (!Number.isFinite(minAnnual) && !Number.isFinite(maxAnnual)) return '';

    const formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
    });

    if (Number.isFinite(minAnnual) && Number.isFinite(maxAnnual)) {
        return `${formatter.format(minAnnual)} - ${formatter.format(maxAnnual)} / year`;
    }

    if (Number.isFinite(minAnnual)) {
        return `${formatter.format(minAnnual)}+ / year`;
    }

    return `Up to ${formatter.format(maxAnnual)} / year`;
}

function splitJobType(jobTypeText, isRemote) {
    const parts = String(jobTypeText || '')
        .split('·')
        .map((part) => part.trim())
        .filter(Boolean);

    const employmentTypes = parts[0] ? [parts[0]] : [];
    const locationTypes = [];

    if (isRemote || parts.some((part) => /remote/i.test(part))) {
        locationTypes.push('Remote');
    } else if (parts.some((part) => /hybrid/i.test(part))) {
        locationTypes.push('Hybrid');
    } else if (parts.some((part) => /on[\s-]?site/i.test(part))) {
        locationTypes.push('On-site');
    }

    return {
        employmentTypes,
        locationTypes,
        jobType: parts.join(' · '),
    };
}

function buildDedupeKey(result) {
    return [
        normalizeInputString(result.title).toLowerCase(),
        normalizeInputString(result.company).toLowerCase(),
        normalizeInputString(result.location).toLowerCase(),
        normalizeInputString(result.job_type).toLowerCase(),
        Number.isFinite(result.salary?.min_annual) ? result.salary.min_annual : '',
        Number.isFinite(result.salary?.max_annual) ? result.salary.max_annual : '',
    ].join('|');
}

function sanitizeRecordForDataset(record) {
    const sanitized = {};

    for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined) continue;

        if (Array.isArray(value)) {
            const cleaned = [...new Set(value
                .map((item) => String(item).trim())
                .filter(Boolean))];

            if (cleaned.length) sanitized[key] = cleaned.join(', ');
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

async function pushRecordsSafely(records) {
    if (!records.length) return 0;

    const sanitizedRecords = records.map(sanitizeRecordForDataset).filter((record) => Object.keys(record).length > 0);
    if (!sanitizedRecords.length) return 0;

    await Actor.pushData(sanitizedRecords);
    return sanitizedRecords.length;
}

async function mcpRequest(body) {
    for (let attempt = 1; attempt <= CONFIG.MAX_MCP_RETRIES; attempt += 1) {
        const response = await fetch(CONFIG.MCP_ENDPOINT, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
        });

        const text = await response.text();
        const payload = safeJsonParse(text, null);

        if (response.ok && !payload?.error) {
            return payload;
        }

        const message = payload?.error?.message || text || `HTTP ${response.status}`;
        const isRateLimit = response.status === 429 || /too many requests|429/i.test(message);
        const isLastAttempt = attempt === CONFIG.MAX_MCP_RETRIES;

        if (!isRateLimit || isLastAttempt) {
            throw new Error(message);
        }

        log.warning(`MCP request rate limited. Retrying attempt ${attempt + 1}/${CONFIG.MAX_MCP_RETRIES}.`);
        await sleep(CONFIG.RETRY_DELAY_MS * attempt);
    }

    return null;
}

async function initializeMcpClient() {
    await mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
                name: 'ziprecruiter-apify-actor',
                version: '1.0.0',
            },
        },
    });

    await mcpRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
    });
}

async function searchJobsViaMcp(args, requestId) {
    const payload = await mcpRequest({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
            name: 'search_jobs',
            arguments: args,
        },
    });

    return payload?.result?.structuredContent || {};
}

function buildSearchArgs(effectiveSearch, offset) {
    const args = { offset };

    if (effectiveSearch.searchQuery) args.job_role = effectiveSearch.searchQuery;
    if (effectiveSearch.location) args.location = effectiveSearch.location;

    const maxPostedMinutesAgo = daysBackToMinutes(effectiveSearch.daysBack);
    if (maxPostedMinutesAgo) args.max_posted_minutes_ago = maxPostedMinutesAgo;

    return args;
}

function normalizeJobRecord(result, context) {
    const minAnnual = Number.isFinite(result.salary?.min_annual) ? result.salary.min_annual : null;
    const maxAnnual = Number.isFinite(result.salary?.max_annual) ? result.salary.max_annual : null;
    const { employmentTypes, locationTypes, jobType } = splitJobType(result.job_type, Boolean(result.is_remote));

    return {
        title: result.title || '',
        company: result.company || '',
        location: result.location || '',
        isRemote: Boolean(result.is_remote),
        jobType,
        employmentTypes,
        locationTypes,
        locationType: locationTypes.join(', '),
        salary: formatSalary(minAnnual, maxAnnual),
        salaryMinAnnual: minAnnual,
        salaryMaxAnnual: maxAnnual,
        companyLogoUrl: result.company_logo || '',
        url: result.job_redirect_url || '',
        benefits: result.benefits || '',
        daysAgo: Number.isFinite(result.days_ago) ? result.days_ago : null,
        searchQuery: context.searchQuery,
        searchLocation: context.searchLocation,
        page: context.page,
        offset: context.offset,
        scrapedAt: new Date().toISOString(),
    };
}

try {
    const { resolvedInput: input, fallbackSources, userProvidedAny } = await resolveInputWithFallbacks();
    const effectiveSearch = resolveEffectiveSearch(input);

    if (!effectiveSearch.searchQuery && !effectiveSearch.location) {
        throw new Error('Missing search input. Provide searchQuery, location, or a parseable searchUrl.');
    }

    const maxJobsInput = Number(input.maxJobs ?? 20);
    const targetJobs = maxJobsInput > 0 ? maxJobsInput : Number.POSITIVE_INFINITY;
    const maxPages = Math.min(
        Math.max(Number(input.maxPages) || CONFIG.DEFAULT_MAX_PAGES, 1),
        CONFIG.MAX_PAGES_HARD_LIMIT,
    );
    const scrapeMode = normalizeInputString(input.scrapeMode) || 'listing_only';

    log.info('Starting ZipRecruiter actor in MCP search mode', {
        searchQuery: effectiveSearch.searchQuery || null,
        location: effectiveSearch.location || null,
        usingSearchUrl: Boolean(effectiveSearch.searchUrl),
        maxJobs: Number.isFinite(targetJobs) ? targetJobs : 0,
        maxPages,
        scrapeMode,
        userProvidedInput: userProvidedAny,
        fallbackSources,
    });

    if (scrapeMode === 'listing_with_details') {
        log.warning('listing_with_details requested, but the selected MCP endpoint currently exposes listing-level data only.');
    }

    if (hasValue(input.proxyConfiguration)) {
        log.info('Proxy configuration was provided but is not required for the selected MCP endpoint.');
    }

    await initializeMcpClient();

    let offset = 0;
    let page = 1;
    let consecutiveEmptyBatches = 0;

    while (page <= maxPages && (Number.isFinite(targetJobs) ? stats.recordsPushed < targetJobs : true)) {
        const args = buildSearchArgs(effectiveSearch, offset);
        const remainingSlots = Number.isFinite(targetJobs)
            ? Math.max(targetJobs - stats.recordsPushed, 0)
            : Number.POSITIVE_INFINITY;

        if (remainingSlots === 0) break;

        const searchPayload = await searchJobsViaMcp(args, page + 1);
        const results = asArray(searchPayload.results);
        const warnings = asArray(searchPayload.warnings);
        const meta = searchPayload.meta || {};

        stats.batchesProcessed += 1;
        stats.warnings.push(...warnings);

        if (warnings.length) {
            log.warning(`Batch ${page} returned warnings`, { warnings });
        }

        if (!results.length) {
            stats.emptyBatches += 1;
            consecutiveEmptyBatches += 1;
            log.info(`Batch ${page}: no jobs returned`, { offset, consecutiveEmptyBatches });
            if (consecutiveEmptyBatches >= CONFIG.MAX_EMPTY_BATCHES) break;
            offset += 1;
            await sleep(CONFIG.REQUEST_DELAY_MS);
            page += 1;
            continue;
        }

        const pageRecords = [];
        let pageDuplicates = 0;
        let pageMissingSalary = 0;
        let pageMissingBenefits = 0;
        let pageMissingCompanyLogo = 0;

        for (const result of results) {
            const dedupeKey = buildDedupeKey(result);
            if (!dedupeKey || seenJobKeys.has(dedupeKey)) {
                pageDuplicates += 1;
                continue;
            }

            seenJobKeys.add(dedupeKey);

            const minAnnual = Number.isFinite(result.salary?.min_annual) ? result.salary.min_annual : null;
            const maxAnnual = Number.isFinite(result.salary?.max_annual) ? result.salary.max_annual : null;

            if (minAnnual === null && maxAnnual === null) pageMissingSalary += 1;
            if (!hasValue(result.benefits)) pageMissingBenefits += 1;
            if (!hasValue(result.company_logo)) pageMissingCompanyLogo += 1;

            pageRecords.push(normalizeJobRecord(result, {
                searchQuery: effectiveSearch.searchQuery || '',
                searchLocation: effectiveSearch.location || '',
                page,
                offset,
            }));
        }

        stats.duplicatesSkipped += pageDuplicates;
        stats.missingSalary += pageMissingSalary;
        stats.missingBenefits += pageMissingBenefits;
        stats.missingCompanyLogo += pageMissingCompanyLogo;

        if (!pageRecords.length) {
            stats.emptyBatches += 1;
            consecutiveEmptyBatches += 1;
            log.info(`Batch ${page}: duplicate-only batch`, {
                offset,
                duplicatesSkipped: pageDuplicates,
                consecutiveEmptyBatches,
            });
            if (consecutiveEmptyBatches >= CONFIG.MAX_EMPTY_BATCHES) break;
            offset += 1;
            await sleep(CONFIG.REQUEST_DELAY_MS);
            page += 1;
            continue;
        }

        consecutiveEmptyBatches = 0;

        const limitedRecords = Number.isFinite(remainingSlots)
            ? pageRecords.slice(0, remainingSlots)
            : pageRecords;

        const pushedCount = await pushRecordsSafely(limitedRecords);
        stats.recordsPushed += pushedCount;

        log.info(`Batch ${page}: pushed ${pushedCount} jobs`, {
            offset,
            total: stats.recordsPushed,
            duplicatesSkipped: pageDuplicates,
            missingSalary: pageMissingSalary,
            missingBenefits: pageMissingBenefits,
            missingCompanyLogo: pageMissingCompanyLogo,
            reportedTotal: meta.total || null,
        });

        if (results.length < CONFIG.MCP_PAGE_SIZE) break;

        offset += pageDuplicates > 0 ? 1 : Math.max(results.length, CONFIG.MCP_PAGE_SIZE);
        await sleep(CONFIG.REQUEST_DELAY_MS);
        page += 1;
    }

    const durationSeconds = Math.round((Date.now() - stats.startTime) / 1000);

    await Actor.setValue('statistics', {
        endpoint: CONFIG.MCP_ENDPOINT,
        tool: 'search_jobs',
        jobs: stats.recordsPushed,
        batchesProcessed: stats.batchesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        missingSalary: stats.missingSalary,
        missingBenefits: stats.missingBenefits,
        missingCompanyLogo: stats.missingCompanyLogo,
        emptyBatches: stats.emptyBatches,
        warnings: stats.warnings,
        durationSeconds,
        finishedAt: new Date().toISOString(),
    });

    log.info('Run finished', {
        jobs: stats.recordsPushed,
        batchesProcessed: stats.batchesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        missingSalary: stats.missingSalary,
        missingBenefits: stats.missingBenefits,
        missingCompanyLogo: stats.missingCompanyLogo,
        emptyBatches: stats.emptyBatches,
        durationSeconds,
    });
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
}

await Actor.exit();

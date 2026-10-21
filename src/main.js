import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';

import {
    adaptWebCard,
    asArray,
    buildJobIdentity,
    detectBlockedPage,
    hasValue,
    normalizeJobRecord,
    parseSearchHtml,
    resolveEffectiveSearch,
    responseSnapshot,
    sanitizeRecordForDataset,
} from './actor-utils.js';
import { createHttpTransport } from './http-client.js';

await Actor.init();

const CONFIG = {
    DEFAULT_MAX_JOBS: 20,
    DEFAULT_MAX_PAGES: 10,
    MAX_PAGES_HARD_LIMIT: 200,
    PROXY_ROUNDS: 5,
    HTTP_TIMEOUT_MS: 45000,
    RETRY_BASE_DELAY_MS: 1000,
    RETRY_MAX_DELAY_MS: 8000,
    RATE_LIMIT_MAX_DELAY_MS: 30000,
    SESSION_SWITCH_DELAY_MS: 500,
    RESOURCE_TIME_BUDGET_MS: 180000,
    PAGE_DELAY_MS: 300,
    PAGE_DELAY_JITTER_MS: 500,
};

const stats = {
    pagesProcessed: 0,
    recordsPushed: 0,
    duplicatesSkipped: 0,
    itemErrors: 0,
    blockedResponses: 0,
    transportErrors: 0,
    missingSalary: 0,
    missingBenefits: 0,
    missingCompanyLogo: 0,
    transportCounts: {},
    stopReason: '',
    totalListings: null,
    warnings: [],
    startTime: Date.now(),
};

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function jitterDelay(baseMs, spreadMs) {
    return baseMs + Math.floor(Math.random() * spreadMs);
}

function retryDelay(round) {
    const base = Math.min(CONFIG.RETRY_BASE_DELAY_MS * 2 ** round, CONFIG.RETRY_MAX_DELAY_MS);
    return jitterDelay(base, 600);
}

function sessionSwitchDelay() {
    return jitterDelay(CONFIG.SESSION_SWITCH_DELAY_MS, 400);
}

function configuredProxyGroups(proxyInput) {
    return proxyInput?.groups || proxyInput?.apifyProxyGroups || [];
}

function proxyInputForSearch(proxyInput, effectiveSearch) {
    const location = effectiveSearch.location.toLowerCase();
    const isUsSearch = /united states|\busa\b|\bunited states of america\b/.test(location);
    const hasCountry = proxyInput?.apifyProxyCountry || proxyInput?.countryCode;
    const groups = configuredProxyGroups(proxyInput).map((group) => String(group).toUpperCase());
    const usesApifyProxy = proxyInput?.useApifyProxy === true || groups.length > 0;
    // Unblocker selects the country automatically; forcing one shrinks its pool.
    if (usesApifyProxy && groups.includes('UNBLOCKER')) return proxyInput;
    if (!isUsSearch || hasCountry || !usesApifyProxy) return proxyInput;
    return { ...proxyInput, apifyProxyCountry: 'US' };
}

async function buildProxyConfiguration(proxyInput) {
    const isCloudRun = Actor.isAtHome();
    const groups = configuredProxyGroups(proxyInput);
    const requestedApifyProxy = proxyInput?.useApifyProxy === true || groups.length > 0;
    const hasCustomProxyUrls = Array.isArray(proxyInput?.proxyUrls) && proxyInput.proxyUrls.length > 0;

    if (!requestedApifyProxy && !hasCustomProxyUrls) return undefined;
    if (!isCloudRun && !hasCustomProxyUrls) {
        log.warning(
            'Apify Proxy was requested outside Apify; running without it. Use an Apify run or provide custom proxy URLs.',
        );
        return undefined;
    }

    return Actor.createProxyConfiguration(proxyInput);
}

function buildPageUrl(search, page) {
    if (search.mode === 'url') {
        const url = new URL(search.searchUrl);
        if (page > 1 || url.searchParams.has('page')) url.searchParams.set('page', String(page));
        if (url.searchParams.has('days_ago') && !url.searchParams.has('days')) {
            url.searchParams.set('days', url.searchParams.get('days_ago'));
            url.searchParams.delete('days_ago');
        }
        if (/^\d+$/.test(String(search.daysBack)) && !url.searchParams.has('days')) {
            url.searchParams.set('days', String(search.daysBack));
        }
        return url.toString();
    }

    const params = new URLSearchParams();
    if (search.searchQuery) params.set('search', search.searchQuery);
    if (search.location) params.set('location', search.location);
    if (/^\d+$/.test(String(search.daysBack))) params.set('days', String(search.daysBack));
    if (page > 1) params.set('page', String(page));
    return `https://www.ziprecruiter.com/jobs-search?${params.toString()}`;
}

function sanitizeUrl(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch {
        return 'invalid-url';
    }
}

function extractTitle(html) {
    return (
        String(html || '')
            .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
            ?.trim() || ''
    );
}

let discoveryDocPromise;

function loadDiscoveryDoc() {
    discoveryDocPromise ||= readFile(new URL('../API_DISCOVERY.md', import.meta.url), 'utf8').catch(() => '');
    return discoveryDocPromise;
}

function extractDiscoveryGuidance(doc) {
    if (!doc) return '';
    const blocks = [];
    for (const heading of ['## Failure diagnostics', '## Validation requirements', '## Selected flow']) {
        const start = doc.indexOf(heading);
        if (start < 0) continue;
        const end = doc.indexOf('\n## ', start + heading.length);
        blocks.push(doc.slice(start, end < 0 ? doc.length : end).trim());
    }
    return blocks.join('\n\n');
}

async function diagnoseFailure(url, error, snapshot) {
    const doc = await loadDiscoveryDoc();
    log.warning('ZipRecruiter request failed. Reading API_DISCOVERY.md before diagnosing.');
    if (snapshot) {
        log.warning(
            `Last response: HTTP ${snapshot.status}, ${snapshot.bodyLength} bytes, profile ${snapshot.profile}, blocked=${snapshot.blocked}, markers=${JSON.stringify(snapshot.markers)}.`,
        );
    }
    log.warning(`Failure target: ${sanitizeUrl(url)}. Error: ${error?.message || 'unknown error'}.`);
    const guidance = extractDiscoveryGuidance(doc);
    if (guidance) log.warning(`API_DISCOVERY.md guidance:\n${guidance}`);
    else log.warning('API_DISCOVERY.md is missing or has no diagnostic guidance.');
}

async function loadResource(transport, url, parseFn, label, { proxyRounds = CONFIG.PROXY_ROUNDS } = {}) {
    let lastError;
    let lastSnapshot;
    let primaryProxyRetryUsed = false;
    let timeBudgetExceeded = false;
    const startedAt = Date.now();

    // The profile that last succeeded stays first. If it is challenged or gets
    // an unusable page, rotate the proxy once before demoting it so the known
    // working browser gets a fresh exit IP instead of a long profile tour.
    const canRotateForPrimary = (profile, round) => {
        if (primaryProxyRetryUsed || profile !== transport.profiles[0]) return false;
        if (!transport.hasProxy || round >= proxyRounds) return false;
        primaryProxyRetryUsed = true;
        return true;
    };

    for (let round = 0; round <= proxyRounds; round += 1) {
        for (const profile of transport.profiles) {
            if (Date.now() - startedAt >= CONFIG.RESOURCE_TIME_BUDGET_MS) {
                timeBudgetExceeded = true;
                break;
            }

            let result;
            try {
                result = await transport.fetchOnce(url, profile);
            } catch (error) {
                lastError = error;
                stats.transportErrors += 1;
                log.debug(`${label}: ${profile} network error (${error.message}).`);
                if (canRotateForPrimary(profile, round)) break;
                transport.markFailure(profile);
                await sleep(sessionSwitchDelay());
                continue;
            }

            stats.transportCounts[profile] = (stats.transportCounts[profile] || 0) + 1;
            const title = extractTitle(result.html);
            const snapshot = responseSnapshot({
                url: sanitizeUrl(url),
                status: result.status,
                title,
                body: result.html,
                transport: 'impit',
                profile,
            });
            lastSnapshot = snapshot;

            if (result.status === 429) {
                const waitMs = Math.min(result.retryAfterMs ?? retryDelay(round), CONFIG.RATE_LIMIT_MAX_DELAY_MS);
                log.debug(`${label}: HTTP 429, waiting ${Math.round(waitMs / 1000)}s.`);
                await sleep(waitMs);
                continue;
            }
            if (result.status >= 500) {
                lastError = new Error(`${label} returned HTTP ${result.status}`);
                log.debug(`${label}: ${profile} returned HTTP ${result.status}.`);
                await sleep(retryDelay(round));
                continue;
            }
            if (detectBlockedPage({ status: result.status, title, body: result.html })) {
                lastError = new Error(`${label} was blocked with HTTP ${result.status}`);
                stats.blockedResponses += 1;
                log.debug(`${label}: ${profile} was challenged (HTTP ${result.status}).`);
                if (canRotateForPrimary(profile, round)) break;
                transport.markFailure(profile);
                await sleep(sessionSwitchDelay());
                continue;
            }
            if (result.status >= 400) {
                lastError = new Error(`${label} returned HTTP ${result.status}`);
                log.warning(`${label} failed with HTTP ${result.status}.`);
                await diagnoseFailure(url, lastError, snapshot);
                throw lastError;
            }

            const data = parseFn(result.html);
            if (!data) {
                lastError = new Error(`${label} response did not contain the expected job payload`);
                log.debug(
                    `${label}: ${profile} returned HTTP ${result.status} without a payload (title="${snapshot.title}", markers=${JSON.stringify(snapshot.markers)}).`,
                );
                if (canRotateForPrimary(profile, round)) break;
                await sleep(sessionSwitchDelay());
                continue;
            }

            transport.markSuccess(profile);
            return { ...result, data, snapshot };
        }

        if (timeBudgetExceeded || round >= proxyRounds) break;
        const rotated = await transport.rotateProxy();
        if (!rotated) break;
        await sleep(sessionSwitchDelay());
    }

    await diagnoseFailure(url, lastError, lastSnapshot);
    throw lastError || new Error(`${label} failed without a recorded error`);
}

async function pushRecords(records) {
    const cleanRecords = records.map(sanitizeRecordForDataset).filter((record) => Object.keys(record).length > 0);
    if (!cleanRecords.length) return 0;
    await Actor.pushData(cleanRecords);
    return cleanRecords.length;
}

async function scrapePages(transport, search, targetJobs, maxPages) {
    const seenJobKeys = new Set();
    let currentPage = search.startPage || 1;
    let pagesRequested = 0;
    let emptyPages = 0;
    stats.stopReason = 'max_pages';

    while (pagesRequested < maxPages && (!Number.isFinite(targetJobs) || stats.recordsPushed < targetJobs)) {
        const url = buildPageUrl(search, currentPage);
        let result;
        try {
            result = await loadResource(transport, url, parseSearchHtml, `result page ${currentPage}`);
        } catch (error) {
            if (stats.recordsPushed > 0) {
                log.warning(`Stopping after partial success so saved jobs are kept: ${error.message}`);
                stats.stopReason = 'partial_failure';
                break;
            }
            throw error;
        }
        const { data } = result;
        const cards = asArray(data.hydrateJobCardsResponse?.jobCards);
        stats.pagesProcessed += 1;
        pagesRequested += 1;

        if (!cards.length) {
            log.info(`Result page ${currentPage} returned no job cards. Stopping.`);
            stats.stopReason = 'no_cards';
            break;
        }

        const pageTotal = Number(data.totalListings);
        if (Number.isFinite(pageTotal) && pageTotal > 0) stats.totalListings = pageTotal;
        const details = data.getJobDetailsResponse?.jobDetails || null;
        const records = [];

        for (const [index, card] of cards.entries()) {
            try {
                let cardDetails = null;
                if (details) {
                    const detailKey = String(details.listingKey || '');
                    if (detailKey) {
                        if (detailKey === String(card.listingKey)) cardDetails = details;
                    } else if (index === 0) {
                        cardDetails = details;
                    }
                }
                const adapted = adaptWebCard(card, cardDetails);
                if (!hasValue(adapted.title) && !hasValue(adapted.job_redirect_url) && !hasValue(adapted.listing_key))
                    continue;
                const identity = buildJobIdentity(adapted);
                if (!identity || seenJobKeys.has(identity)) {
                    stats.duplicatesSkipped += 1;
                    continue;
                }
                seenJobKeys.add(identity);

                if (!hasValue(adapted.salary?.min) && !hasValue(adapted.salary?.max)) stats.missingSalary += 1;
                if (!hasValue(adapted.benefits)) stats.missingBenefits += 1;
                if (!hasValue(adapted.company_logo)) stats.missingCompanyLogo += 1;

                records.push(
                    normalizeJobRecord(adapted, {
                        searchQuery: search.searchQuery,
                        searchLocation: search.location,
                        page: currentPage,
                        offset: currentPage === 1 ? 0 : null,
                    }),
                );
            } catch (error) {
                stats.itemErrors += 1;
                log.warning(`Skipped a malformed job card on page ${currentPage}: ${error.message}`);
            }
        }

        const remaining = Number.isFinite(targetJobs) ? targetJobs - stats.recordsPushed : Number.POSITIVE_INFINITY;
        const selectedRecords = records.slice(0, Math.max(remaining, 0));
        const pushed = await pushRecords(selectedRecords);
        stats.recordsPushed += pushed;
        log.info(
            `Page ${currentPage}: saved ${pushed} jobs; total ${stats.recordsPushed}${Number.isFinite(targetJobs) ? `/${targetJobs}` : ''}.`,
        );

        if (Number.isFinite(targetJobs) && stats.recordsPushed >= targetJobs) {
            stats.stopReason = 'target_reached';
            break;
        }

        if (pushed === 0) {
            emptyPages += 1;
            if (emptyPages >= 2) {
                stats.stopReason = 'duplicate_exhausted';
                break;
            }
        } else {
            emptyPages = 0;
        }

        const reportedPage = Number(data.page) || currentPage;
        const reportedMaxPages = Number(data.maxPages);
        if (Number.isFinite(reportedMaxPages) && reportedPage >= reportedMaxPages) {
            stats.stopReason = 'source_exhausted';
            break;
        }

        currentPage += 1;
        await sleep(jitterDelay(CONFIG.PAGE_DELAY_MS, CONFIG.PAGE_DELAY_JITTER_MS));
    }
}

let transport;

try {
    const input = (await Actor.getInput()) || {};
    const effectiveSearch = resolveEffectiveSearch(input);
    if (effectiveSearch.mode === 'none') {
        throw new Error('Missing search input. Provide searchQuery, location, or searchUrl.');
    }

    const maxJobsInput = Number(input.maxJobs ?? CONFIG.DEFAULT_MAX_JOBS);
    const targetJobs = maxJobsInput > 0 ? maxJobsInput : Number.POSITIVE_INFINITY;
    const maxPages = Math.min(
        Math.max(Number(input.maxPages) || CONFIG.DEFAULT_MAX_PAGES, 1),
        CONFIG.MAX_PAGES_HARD_LIMIT,
    );
    const configuredProxyInput = input.proxyConfiguration ?? {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'US',
    };
    const proxyInput = proxyInputForSearch(configuredProxyInput, effectiveSearch);
    const proxyConfiguration = await buildProxyConfiguration(proxyInput);

    log.info('Starting ZipRecruiter run', {
        mode: effectiveSearch.mode,
        searchQuery: effectiveSearch.searchQuery || null,
        location: effectiveSearch.location || null,
        usingSearchUrl: Boolean(effectiveSearch.searchUrl),
        maxJobs: Number.isFinite(targetJobs) ? targetJobs : 0,
        maxPages,
        usingProxy: Boolean(proxyConfiguration),
    });

    transport = createHttpTransport({
        proxyConfiguration,
        proxyInput,
        log,
        timeoutMs: CONFIG.HTTP_TIMEOUT_MS,
    });

    await scrapePages(transport, effectiveSearch, targetJobs, maxPages);

    const durationSeconds = Math.round((Date.now() - stats.startTime) / 1000);
    await Actor.setValue('statistics', {
        provider: 'ziprecruiter_json',
        jobs: stats.recordsPushed,
        pagesProcessed: stats.pagesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        itemErrors: stats.itemErrors,
        blockedResponses: stats.blockedResponses,
        transportErrors: stats.transportErrors,
        missingSalary: stats.missingSalary,
        missingBenefits: stats.missingBenefits,
        missingCompanyLogo: stats.missingCompanyLogo,
        transportCounts: stats.transportCounts,
        proxyRotations: transport?.proxyRotations ?? 0,
        totalListings: stats.totalListings,
        stopReason: stats.stopReason,
        warnings: stats.warnings,
        durationSeconds,
        finishedAt: new Date().toISOString(),
    });
    log.info('Run finished', {
        jobs: stats.recordsPushed,
        pagesProcessed: stats.pagesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        stopReason: stats.stopReason,
        durationSeconds,
    });
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
} finally {
    transport?.dispose();
}

await Actor.exit();

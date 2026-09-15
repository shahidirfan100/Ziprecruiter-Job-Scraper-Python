import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

import {
    adaptWebCard,
    asArray,
    buildJobIdentity,
    extractEmbeddedJson,
    extractNextFlightData,
    hasValue,
    normalizeInputString,
    normalizeJobRecord,
    resolveEffectiveSearch,
    sanitizeRecordForDataset,
} from './actor-utils.js';

await Actor.init();

const CONFIG = {
    DEFAULT_MAX_JOBS: 20,
    DEFAULT_MAX_PAGES: 10,
    MAX_PAGES_HARD_LIMIT: 200,
    NAVIGATION_TIMEOUT_MS: 45000,
    JSON_WAIT_MS: 15000,
    REQUEST_DELAY_MS: 250,
};

const stats = {
    pagesProcessed: 0,
    recordsPushed: 0,
    duplicatesSkipped: 0,
    missingSalary: 0,
    missingBenefits: 0,
    missingCompanyLogo: 0,
    warnings: [],
    startTime: Date.now(),
};

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function configuredProxyGroups(proxyInput) {
    return proxyInput?.groups || proxyInput?.apifyProxyGroups || [];
}

function proxyInputForAttempt(proxyInput, attempt) {
    if (attempt === 1 || !proxyInput || Array.isArray(proxyInput.proxyUrls)) return proxyInput;
    const groups = configuredProxyGroups(proxyInput).map((group) => String(group).toUpperCase());
    if (!groups.includes('UNBLOCKER')) return proxyInput;

    const residentialInput = { ...proxyInput, apifyProxyGroups: ['RESIDENTIAL'] };
    delete residentialInput.groups;
    return residentialInput;
}

function proxyInputForSearch(proxyInput, effectiveSearch) {
    const location = effectiveSearch.location.toLowerCase();
    const isUsSearch = /united states|\busa\b|\bunited states of america\b/.test(location);
    const hasCountry = proxyInput?.apifyProxyCountry || proxyInput?.countryCode;
    const usesApifyProxy = proxyInput?.useApifyProxy === true || configuredProxyGroups(proxyInput).length > 0;
    if (!isUsSearch || hasCountry || !usesApifyProxy) return proxyInput;
    return { ...proxyInput, apifyProxyCountry: 'US' };
}

async function createBrowserProxyUrl(proxyInput, attempt = 1) {
    const isCloudRun = Actor.isAtHome();
    const groups = configuredProxyGroups(proxyInput);
    const requestedApifyProxy = proxyInput?.useApifyProxy === true || groups.length > 0;
    const hasCustomProxyUrls = Array.isArray(proxyInput?.proxyUrls) && proxyInput.proxyUrls.length > 0;

    if ((!isCloudRun && requestedApifyProxy && !hasCustomProxyUrls) || (!requestedApifyProxy && !hasCustomProxyUrls)) {
        if (requestedApifyProxy && !isCloudRun) {
            log.warning(
                'Apify Proxy was requested outside Apify; running without it. Use an Apify run or provide custom proxy URLs.',
            );
        }
        return undefined;
    }

    const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
    if (!proxyConfiguration) return undefined;

    const usesUnblocker = groups.some((group) => String(group).toUpperCase() === 'UNBLOCKER');
    const sessionId = usesUnblocker ? undefined : `ziprecruiter_${Date.now()}_${attempt}`;
    const proxyUrl = await proxyConfiguration.newUrl(sessionId);
    let proxyType = 'configured proxy';
    if (usesUnblocker) proxyType = 'Unblocker';
    else if (groups.some((group) => String(group).toUpperCase() === 'RESIDENTIAL')) proxyType = 'Residential';
    log.info(`Using Apify ${proxyType} for the browser context.`);
    return proxyUrl;
}

function webPageUrl(effectiveSearch, page) {
    if (effectiveSearch.searchUrl) {
        const url = new URL(effectiveSearch.searchUrl);
        if (page > 1) url.searchParams.set('page', String(page));
        return url.toString();
    }

    const params = new URLSearchParams();
    if (effectiveSearch.searchQuery) params.set('search', effectiveSearch.searchQuery);
    if (effectiveSearch.location) params.set('location', effectiveSearch.location);
    if (/^\d+$/.test(String(effectiveSearch.daysBack))) params.set('days_ago', String(effectiveSearch.daysBack));
    if (page > 1) params.set('page', String(page));
    return `https://www.ziprecruiter.com/jobs-search?${params.toString()}`;
}

async function readPageScripts(page) {
    const deadline = Date.now() + CONFIG.JSON_WAIT_MS;
    let latestScripts = [];
    while (Date.now() < deadline) {
        try {
            latestScripts = await page.evaluate(() =>
                [...document.scripts].map((script) => script.textContent?.trim() || '').filter(Boolean),
            );
            if (
                latestScripts.some(
                    (text) => text.includes('hydrateJobCardsResponse') || text.includes('serializedJobCardsData'),
                )
            )
                return latestScripts;
        } catch (error) {
            if (!/execution context was destroyed|navigation/i.test(error.message)) throw error;
        }
        await page.waitForTimeout(500);
    }
    return latestScripts;
}

async function readDomJobCards(page) {
    return page.evaluate(() => {
        const jsonLdItems = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((script) => {
            try {
                const value = JSON.parse(script.textContent || '{}');
                return value?.['@type'] === 'ItemList' ? value.itemListElement || [] : [];
            } catch {
                return [];
            }
        });
        const urlsByTitle = new Map(jsonLdItems.map((item) => [item.name, item.url]));
        const seen = new Set();

        return [...document.querySelectorAll('article[id^="job-card-"]')]
            .map((article) => {
                const listingKey = article.id.slice('job-card-'.length);
                if (!listingKey || seen.has(listingKey)) return null;
                seen.add(listingKey);

                const title = article.querySelector('[data-testid="serp-job-card-title"]')?.textContent?.trim() || '';
                const company = article.querySelector('[data-testid="job-card-company"]')?.textContent?.trim() || '';
                const location = article.querySelector('[data-testid="job-card-location"]')?.textContent?.trim() || '';
                const locationTypes = [...article.innerText.matchAll(/(?:·|•)\s*(Remote|Hybrid|On-site)/gi)].map(
                    (match) => match[1],
                );
                const logoUrl = article.querySelector('img')?.src || '';
                const jobUrl = urlsByTitle.get(title) || `https://www.ziprecruiter.com/jobs//j?lvk=${listingKey}`;

                return {
                    listingKey,
                    title,
                    company: { name: company },
                    location: { displayName: location },
                    locationTypes,
                    isRemote: locationTypes.some((value) => /remote/i.test(value)),
                    companyLogo: { logoUrl },
                    rawCanonicalZipJobPageUrl: jobUrl,
                };
            })
            .filter(Boolean);
    });
}

function parsePagePayload(scriptTexts) {
    try {
        return extractEmbeddedJson(scriptTexts);
    } catch {
        try {
            return extractNextFlightData(scriptTexts);
        } catch {
            return null;
        }
    }
}

async function readPageData(page, url) {
    let response;
    try {
        response = await page.goto(url, {
            waitUntil: 'commit',
            timeout: CONFIG.NAVIGATION_TIMEOUT_MS,
        });
    } catch (error) {
        throw new Error(`ZipRecruiter navigation did not complete: ${error.message}`);
    }

    const status = response?.status() || 0;
    await page.waitForLoadState('domcontentloaded', { timeout: CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    const scriptTexts = await readPageScripts(page);
    const data = parsePagePayload(scriptTexts);
    if (data) {
        if (status >= 400) {
            log.warning(`ZipRecruiter returned HTTP ${status} with a usable job payload; continuing.`);
        }
        return { data, status };
    }

    const domCards = await readDomJobCards(page).catch(() => []);
    if (domCards.length) {
        log.warning('ZipRecruiter did not expose a structured payload; using rendered job cards as a fallback.');
        return {
            data: {
                hydrateJobCardsResponse: { jobCards: domCards },
                page: Number(new URL(url).searchParams.get('page')) || 1,
                maxPages: Number(new URL(url).searchParams.get('page')) || 1,
            },
            status,
        };
    }

    const title = await page.title().catch(() => '');
    const blocked = /captcha|access denied|just a moment|challenge|robot/i.test(`${title} ${scriptTexts.join(' ')}`);
    if (blocked || status >= 400) {
        throw new Error(
            `ZipRecruiter page was blocked or incomplete (HTTP ${status || 'unknown'}, title: ${title || 'unknown'}).`,
        );
    }
    throw new Error('ZipRecruiter page did not contain a supported job payload.');
}

async function runBrowserSession(proxyInput, effectiveSearch, targetJobs, maxPages) {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptProxyInput = proxyInputForAttempt(proxyInput, attempt);
        if (attempt > 1 && attemptProxyInput !== proxyInput) {
            log.warning('Retrying ZipRecruiter with a fresh Residential proxy route.');
        }
        const proxyUrl = await createBrowserProxyUrl(attemptProxyInput, attempt);
        const browser = await firefox.launch(
            await camoufoxLaunchOptions({
                headless: true,
                ...(proxyUrl ? { proxy: proxyUrl } : {}),
                humanize: true,
                block_webrtc: true,
                enable_cache: true,
            }),
        );
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.route('**/*', async (route) => {
            const resourceType = route.request().resourceType();
            const requestUrl = route.request().url();
            if (
                resourceType === 'media' ||
                /google-analytics|googletagmanager|doubleclick|facebook\.net/i.test(requestUrl)
            ) {
                await route.abort();
                return;
            }
            await route.continue();
        });

        try {
            await scrapePages(page, effectiveSearch, targetJobs, maxPages);
            return;
        } catch (error) {
            const canRetry = attempt < maxAttempts && stats.recordsPushed === 0;
            if (!canRetry) throw error;
            log.warning(`Browser/proxy attempt ${attempt} failed: ${error.message}. Retrying with a fresh route.`);
        } finally {
            await page.close().catch(() => undefined);
            await context.close().catch(() => undefined);
            await browser.close().catch(() => undefined);
        }
    }
}

async function pushRecords(records) {
    const cleanRecords = records.map(sanitizeRecordForDataset).filter((record) => Object.keys(record).length > 0);
    if (!cleanRecords.length) return 0;
    await Actor.pushData(cleanRecords);
    return cleanRecords.length;
}

async function scrapePages(page, effectiveSearch, targetJobs, maxPages) {
    const seenJobKeys = new Set();
    let currentPage = 1;

    while (currentPage <= maxPages && (!Number.isFinite(targetJobs) || stats.recordsPushed < targetJobs)) {
        const url = webPageUrl(effectiveSearch, currentPage);
        log.info(`Opening ZipRecruiter result page ${currentPage}/${maxPages}.`);
        const { data } = await readPageData(page, url);
        const cards = asArray(data.hydrateJobCardsResponse?.jobCards);
        const details = data.getJobDetailsResponse?.jobDetails || null;
        stats.pagesProcessed += 1;

        if (!cards.length) {
            log.info(`Result page ${currentPage} returned no job cards.`);
            break;
        }

        const records = [];
        for (const [index, card] of cards.entries()) {
            const adapted = adaptWebCard(card, index === 0 ? details : null);
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
                    searchQuery: effectiveSearch.searchQuery,
                    searchLocation: effectiveSearch.location,
                    page: currentPage,
                    offset: currentPage === 1 ? 0 : null,
                }),
            );
        }

        const remaining = Number.isFinite(targetJobs) ? targetJobs - stats.recordsPushed : Number.POSITIVE_INFINITY;
        const pushed = await pushRecords(records.slice(0, Math.max(remaining, 0)));
        stats.recordsPushed += pushed;
        log.info(
            `Page ${currentPage}: saved ${pushed} jobs; total ${stats.recordsPushed}${Number.isFinite(targetJobs) ? `/${targetJobs}` : ''}.`,
        );

        const reportedPage = Number(data.page) || currentPage;
        const reportedMaxPages = Number(data.maxPages) || maxPages;
        if (reportedPage >= reportedMaxPages || cards.length === 0) break;
        currentPage += 1;
        await sleep(CONFIG.REQUEST_DELAY_MS);
    }
}

try {
    const input = (await Actor.getInput()) || {};
    const effectiveSearch = resolveEffectiveSearch(input);
    if (!effectiveSearch.searchUrl && !effectiveSearch.searchQuery && !effectiveSearch.location) {
        throw new Error('Missing search input. Provide searchUrl, searchQuery, or location.');
    }

    const maxJobsInput = Number(input.maxJobs ?? CONFIG.DEFAULT_MAX_JOBS);
    const targetJobs = maxJobsInput > 0 ? maxJobsInput : Number.POSITIVE_INFINITY;
    const maxPages = Math.min(
        Math.max(Number(input.maxPages) || CONFIG.DEFAULT_MAX_PAGES, 1),
        CONFIG.MAX_PAGES_HARD_LIMIT,
    );
    const scrapeMode = normalizeInputString(input.scrapeMode) || 'listing_only';
    const configuredProxyInput = input.proxyConfiguration ?? {
        useApifyProxy: true,
        apifyProxyGroups: ['UNBLOCKER'],
    };
    const proxyInput = proxyInputForSearch(configuredProxyInput, effectiveSearch);

    log.info('Starting ZipRecruiter Camoufox browser run', {
        searchQuery: effectiveSearch.searchQuery || null,
        location: effectiveSearch.location || null,
        usingSearchUrl: Boolean(effectiveSearch.searchUrl),
        maxJobs: Number.isFinite(targetJobs) ? targetJobs : 0,
        maxPages,
        scrapeMode,
    });
    if (scrapeMode === 'listing_with_details') {
        log.warning(
            'listing_with_details is retained for compatibility; the actor captures descriptions when available in the listing payload.',
        );
    }

    await runBrowserSession(proxyInput, effectiveSearch, targetJobs, maxPages);

    const durationSeconds = Math.round((Date.now() - stats.startTime) / 1000);
    await Actor.setValue('statistics', {
        provider: 'ziprecruiter_camoufox_json',
        jobs: stats.recordsPushed,
        pagesProcessed: stats.pagesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        missingSalary: stats.missingSalary,
        missingBenefits: stats.missingBenefits,
        missingCompanyLogo: stats.missingCompanyLogo,
        warnings: stats.warnings,
        durationSeconds,
        finishedAt: new Date().toISOString(),
    });
    log.info('Run finished', {
        jobs: stats.recordsPushed,
        pagesProcessed: stats.pagesProcessed,
        duplicatesSkipped: stats.duplicatesSkipped,
        durationSeconds,
    });
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
}

await Actor.exit();

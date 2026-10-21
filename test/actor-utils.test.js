import assert from 'node:assert/strict';
import test from 'node:test';

import {
    adaptWebCard,
    buildJobIdentity,
    detectBlockedPage,
    extractEmbeddedJson,
    extractNextFlightData,
    normalizeJobRecord,
    parseSearchHtml,
    resolveEffectiveSearch,
    responseSnapshot,
    sanitizeRecordForDataset,
} from '../src/actor-utils.js';

test('keyword search wins over the default search URL and location', () => {
    const search = resolveEffectiveSearch({
        searchUrl: 'https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote',
        searchQuery: 'software engineer',
        location: 'United States',
    });

    assert.equal(search.mode, 'keyword');
    assert.equal(search.searchQuery, 'software engineer');
    assert.equal(search.location, 'United States');
    assert.equal(search.searchUrl, '');
});

test('location-only search is not contaminated by the search URL default', () => {
    const search = resolveEffectiveSearch({
        searchUrl: 'https://www.ziprecruiter.com/jobs-search?search=software+engineer&location=United+States',
        location: 'Austin, TX',
    });

    assert.equal(search.mode, 'location');
    assert.equal(search.searchQuery, '');
    assert.equal(search.searchUrl, '');
});

test('search URL mode parses query, location, and starting page', () => {
    const search = resolveEffectiveSearch({
        searchUrl: 'https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote&page=3',
    });

    assert.equal(search.mode, 'url');
    assert.equal(search.searchQuery, 'data analyst');
    assert.equal(search.location, 'Remote');
    assert.equal(search.startPage, 3);
});

test('embedded JSON is selected by the ZipRecruiter job marker', () => {
    const payload = { hydrateJobCardsResponse: { jobCards: [{ listingKey: 'abc' }] }, page: 1 };
    assert.deepEqual(extractEmbeddedJson(['{"unrelated":true}', JSON.stringify(payload)]), payload);
    assert.throws(() => extractEmbeddedJson(['{"unrelated":true}']), /expected embedded job data/);
});

test('Next.js flight payload maps current ZipRecruiter cards', () => {
    const flight = JSON.stringify([
        1,
        `4:[{"serializedJobCardsData":${JSON.stringify({
            jobKeys: [{ listingKey: 'current-1' }],
            jobKeysMap: {
                'current-1': {
                    listingKey: 'current-1',
                    title: 'Platform Engineer',
                    company: { name: 'Example Inc.' },
                    location: { city: 'Austin', stateCode: 'TX', countryCode: 'US' },
                    employmentTypes: [{ name: 'EMPLOYMENT_TYPE_NAME_FULL_TIME' }],
                    locationTypes: [{ name: 'LOCATION_TYPE_NAME_REMOTE' }],
                    pay: { min: 50, max: 60, interval: 'PAY_INTERVAL_HOUR', currency: 'PAY_CURRENCY_USD' },
                    rawCanonicalZipJobPageUrl: '/c/example/Job/platform-engineer?jid=current-1',
                },
            },
            totalListings: 21,
        })},"pageNumber":2}]`,
    ]);
    const data = extractNextFlightData([`self.__next_f.push(${flight})`]);
    const raw = adaptWebCard(data.hydrateJobCardsResponse.jobCards[0]);
    const record = normalizeJobRecord(raw, {
        searchQuery: 'engineer',
        searchLocation: 'Austin',
        page: 2,
        offset: null,
    });

    assert.equal(data.page, 2);
    assert.equal(data.maxPages, 21);
    assert.equal(record.title, 'Platform Engineer');
    assert.equal(record.isRemote, true);
    assert.equal(record.salaryMinAnnual, 104000);
    assert.equal(record.employmentTypes[0], 'Full-time');
    assert.equal(record.url, 'https://www.ziprecruiter.com/c/example/Job/platform-engineer?jid=current-1');
});

test('web cards map salary, employment types, and stable identity', () => {
    const raw = adaptWebCard({
        listingKey: 'abc123',
        title: 'Backend Engineer',
        company: { name: 'Example Inc.' },
        location: { city: 'Austin', stateCode: 'TX', countryCode: 'US' },
        employmentTypes: [{ name: 1 }],
        pay: { min: 50, max: 60, interval: 1 },
        shortDescription: 'Build services.',
    });
    const record = normalizeJobRecord(raw, { searchQuery: 'engineer', searchLocation: 'Austin', page: 1, offset: 0 });

    assert.equal(record.listingKey, 'abc123');
    assert.equal(record.salaryMinAnnual, 104000);
    assert.deepEqual(record.employmentTypes, ['Full-time']);
    assert.equal(buildJobIdentity(raw), 'listing:abc123');
});

test('dataset sanitization preserves typed arrays', () => {
    const record = sanitizeRecordForDataset({
        employmentTypes: ['Full-time', ''],
        locationTypes: ['Remote'],
        empty: '',
    });
    assert.deepEqual(record, { employmentTypes: ['Full-time'], locationTypes: ['Remote'] });
});

test('Next.js flight payload is reconstructed from multiple push fragments', () => {
    const inner = JSON.stringify({
        jobKeys: [{ listingKey: 'multi-1' }],
        jobKeysMap: {
            'multi-1': {
                listingKey: 'multi-1',
                title: 'Multi Fragment Engineer',
                company: { name: 'Fragments Inc.' },
                location: { city: 'Denver', stateCode: 'CO', countryCode: 'US' },
                rawCanonicalZipJobPageUrl: '/c/fragments/Job/multi-fragment-engineer?jid=multi-1',
            },
        },
        totalListings: 5,
    });
    const stream = `4:[{"serializedJobCardsData":${inner}},"pageNumber":1}]`;
    const scripts = [
        `self.__next_f.push(${JSON.stringify([1, stream.slice(0, 24)])})`,
        `self.__next_f.push(${JSON.stringify([1, stream.slice(24)])})`,
    ];

    const data = extractNextFlightData(scripts);
    assert.equal(data.hydrateJobCardsResponse.jobCards[0].title, 'Multi Fragment Engineer');
    assert.equal(data.page, 1);
});

test('parseSearchHtml reconstructs the payload from raw HTML', () => {
    const inner = JSON.stringify({
        jobKeys: [{ listingKey: 'html-1' }],
        jobKeysMap: {
            'html-1': {
                listingKey: 'html-1',
                title: 'HTML Engineer',
                company: { name: 'Markup Inc.' },
                rawCanonicalZipJobPageUrl: '/c/markup/Job/html-engineer?jid=html-1',
            },
        },
        totalListings: 1,
    });
    const flight = JSON.stringify([1, `4:[{"serializedJobCardsData":${inner}},"pageNumber":1}]`]);
    const html = `<!doctype html><html><head><script>self.__next_f.push(${flight})</script></head><body></body></html>`;

    const data = parseSearchHtml(html);
    assert.equal(data.hydrateJobCardsResponse.jobCards[0].title, 'HTML Engineer');
});

test('parseSearchHtml falls back to the JSON-LD ItemList', () => {
    const block = JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
            {
                '@type': 'ListItem',
                position: 1,
                name: 'Linked Data Engineer',
                url: 'https://www.ziprecruiter.com/jobs//j?lvk=ld-1',
            },
        ],
    });
    const html = `<html><head><script type="application/ld+json">${block}</script></head></html>`;

    const data = parseSearchHtml(html);
    assert.equal(data.hydrateJobCardsResponse.jobCards[0].title, 'Linked Data Engineer');
    assert.equal(data.hydrateJobCardsResponse.jobCards[0].listingKey, 'ld-1');
});

test('detectBlockedPage flags challenge and blocked statuses', () => {
    assert.equal(detectBlockedPage({ status: 403 }), true);
    assert.equal(detectBlockedPage({ status: 200, title: 'Just a moment...' }), true);
    assert.equal(detectBlockedPage({ status: 200, title: 'Jobs', body: '<html>ok</html>' }), false);
});

test('responseSnapshot reports markers and block state', () => {
    const snapshot = responseSnapshot({ status: 200, title: 'Jobs', body: 'serializedJobCardsData ItemList' });
    assert.equal(snapshot.markers.nextFlight, true);
    assert.equal(snapshot.markers.jsonLd, true);
    assert.equal(snapshot.blocked, false);
});

test('current flight jobCards container is parsed with page metadata', () => {
    const container = {
        jobKeys: [{ listingKey: 'current-1' }],
        jobCards: [
            {
                listingKey: 'current-1',
                title: 'Current Payload Engineer',
                company: { name: 'Current Inc.' },
                display: {
                    location: 'Manhattan, NY',
                    employmentTypes: { fullDisplay: 'Full-time' },
                    locationTypes: 'Remote',
                    benefits: 'Medical, Dental',
                    rollingPostedAt: '3 days ago',
                },
                status: { postedAtUtc: { seconds: '1788418800', nanos: 0 } },
                pay: { min: 60, max: 80, interval: 1, currency: 5 },
                rawCanonicalZipJobPageUrl: '/c/current/Job/current?jid=current-1',
            },
        ],
        totalListings: 41,
    };
    const flightRow = `4:[${JSON.stringify(container)},"pageNumber":2,"jobCount":41]`;
    const push = `self.__next_f.push(${JSON.stringify([1, flightRow])})`;

    const data = extractNextFlightData([push]);
    const record = normalizeJobRecord(adaptWebCard(data.hydrateJobCardsResponse.jobCards[0]), {
        searchQuery: 'engineer',
        searchLocation: 'New York, NY',
        page: 2,
        offset: null,
    });

    assert.equal(data.hydrateJobCardsResponse.jobCards.length, 1);
    assert.equal(data.page, 2);
    assert.equal(data.totalListings, 41);
    assert.equal(record.location, 'Manhattan, NY');
    assert.deepEqual(record.employmentTypes, ['Full-time']);
    assert.deepEqual(record.locationTypes, ['Remote']);
    assert.equal(record.isRemote, true);
    assert.equal(record.benefits, 'Medical, Dental');
    assert.equal(record.daysAgo, 3);
    assert.match(record.postedDate, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.postedDate.includes('[object Object]'), false);
});

test('empty jobCards container is a valid empty result, not a parse failure', () => {
    const stream = `4:[{"jobKeys":[],"jobCards":[],"totalListings":0},"pageNumber":1,"jobCount":0]`;
    const html = `<html><script>self.__next_f.push(${JSON.stringify([1, stream])})</script></html>`;

    const data = parseSearchHtml(html);
    assert.equal(data.hydrateJobCardsResponse.jobCards.length, 0);
    assert.equal(data.totalListings, 0);
    assert.equal(data.maxPages, 1);
});

test('Next.js reference tokens are never saved as descriptions', () => {
    const raw = adaptWebCard({
        listingKey: 'ref-1',
        title: 'Reference Engineer',
        company: { name: 'Reference Inc.' },
        description: '$2d',
    });
    const record = normalizeJobRecord(raw, { searchQuery: 'x', searchLocation: 'y', page: 1, offset: 0 });
    assert.equal(record.description, '');
});

test('listing enrichment maps company, location, salary source, and timestamps', () => {
    const raw = adaptWebCard({
        listingKey: 'enrich-1',
        matchId: 'match-1',
        title: 'Enriched Engineer',
        company: { id: 'co-1', name: 'Enrich Inc.', canonicalDisplayName: 'enrich' },
        companyUrl: '/co/Enrich/Jobs',
        location: {
            city: 'Austin',
            state: 'Texas',
            stateCode: 'TX',
            country: 'United States',
            countryCode: 'US',
            county: 'Travis',
            locId: 'loc-1',
            granularityType: 'CITY',
            areaSize: 42,
            displayName: 'Austin, TX US',
        },
        locationUrl: '/jobs-search?location=Austin%2CTX',
        status: { isActive: true, postedAtUtc: '2026-10-01T00:00:00Z', rollingPostedAtUtc: '2026-10-01T00:00:00Z' },
        pay: {
            min: 40,
            max: 60,
            minAnnual: 80000,
            maxAnnual: 120000,
            interval: 'PAY_INTERVAL_HOUR',
            currency: 'PAY_CURRENCY_USD',
            metadata: { sourceType: 'SOURCE_PROVIDED' },
        },
        isNew: true,
        updatedAt: '2026-10-05T00:00:00Z',
        applyButtonConfig: { applyButtonType: 'OPEN_EXTERNAL', destination: 'EXTERNAL' },
        display: { rollingPostedAt: '3 days ago' },
    });
    const record = normalizeJobRecord(raw, { searchQuery: 'x', searchLocation: 'y', page: 1, offset: 0 });

    assert.equal(record.matchId, 'match-1');
    assert.equal(record.companyId, 'co-1');
    assert.equal(record.companyCanonicalName, 'enrich');
    assert.equal(record.locationCity, 'Austin');
    assert.equal(record.locationStateCode, 'TX');
    assert.equal(record.locationAreaSize, 42);
    assert.equal(record.salaryMinAnnual, 80000);
    assert.equal(record.salaryMaxAnnual, 120000);
    assert.equal(record.salarySource, 'SOURCE_PROVIDED');
    assert.equal(record.isActive, true);
    assert.equal(record.isNew, true);
    assert.equal(record.applyType, 'OPEN_EXTERNAL');
    assert.equal(record.daysAgo, 3);
});

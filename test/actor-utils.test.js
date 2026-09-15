import assert from 'node:assert/strict';
import test from 'node:test';

import {
    adaptWebCard,
    buildJobIdentity,
    extractEmbeddedJson,
    extractNextFlightData,
    normalizeJobRecord,
    resolveEffectiveSearch,
    sanitizeRecordForDataset,
} from '../src/actor-utils.js';

test('search URL is an isolated search mode', () => {
    const search = resolveEffectiveSearch({
        searchUrl: 'https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote',
        searchQuery: 'software engineer',
        location: 'United States',
    });

    assert.equal(search.searchQuery, 'data analyst');
    assert.equal(search.location, 'Remote');
    assert.equal(search.searchUrl.includes('data+analyst'), true);
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

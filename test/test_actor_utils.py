import json
import unittest

from src.actor_utils import (
    adapt_web_card,
    build_job_identity,
    detect_blocked_page,
    extract_embedded_json,
    extract_next_flight_data,
    normalize_job_record,
    parse_search_html,
    resolve_effective_search,
    response_snapshot,
    sanitize_record_for_dataset,
)


class SearchInputTests(unittest.TestCase):
    def test_keyword_wins_over_default_url_and_location(self):
        search = resolve_effective_search({
            'searchUrl': 'https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote',
            'searchQuery': 'software engineer',
            'location': 'United States',
        })
        self.assertEqual(search['mode'], 'keyword')
        self.assertEqual(search['searchQuery'], 'software engineer')
        self.assertEqual(search['location'], 'United States')
        self.assertEqual(search['searchUrl'], '')

    def test_location_only_is_not_contaminated_by_url_default(self):
        search = resolve_effective_search({
            'searchUrl': 'https://www.ziprecruiter.com/jobs-search?search=software+engineer&location=United+States',
            'location': 'Austin, TX',
        })
        self.assertEqual(search['mode'], 'location')
        self.assertEqual(search['searchQuery'], '')
        self.assertEqual(search['searchUrl'], '')

    def test_url_mode_parses_query_location_and_page(self):
        search = resolve_effective_search({
            'searchUrl': 'https://www.ziprecruiter.com/jobs-search?search=data+analyst&location=Remote&page=3',
        })
        self.assertEqual(search['mode'], 'url')
        self.assertEqual(search['searchQuery'], 'data analyst')
        self.assertEqual(search['location'], 'Remote')
        self.assertEqual(search['startPage'], 3)


class PayloadTests(unittest.TestCase):
    def test_embedded_json_is_selected_by_job_marker(self):
        payload = {'hydrateJobCardsResponse': {'jobCards': [{'listingKey': 'abc'}]}, 'page': 1}
        data = extract_embedded_json(['{"unrelated":true}', json.dumps(payload)])
        self.assertEqual(data, payload)
        with self.assertRaisesRegex(RuntimeError, 'expected embedded job data'):
            extract_embedded_json(['{"unrelated":true}'])

    def test_legacy_serialized_cards_map_current_shape(self):
        inner = {
            'serializedJobCardsData': {
                'jobKeys': [{'listingKey': 'current-1'}],
                'jobKeysMap': {
                    'current-1': {
                        'listingKey': 'current-1',
                        'title': 'Platform Engineer',
                        'company': {'name': 'Example Inc.'},
                        'location': {'city': 'Austin', 'stateCode': 'TX', 'countryCode': 'US'},
                        'employmentTypes': [{'name': 'EMPLOYMENT_TYPE_NAME_FULL_TIME'}],
                        'locationTypes': [{'name': 'LOCATION_TYPE_NAME_REMOTE'}],
                        'pay': {'min': 50, 'max': 60, 'interval': 'PAY_INTERVAL_HOUR', 'currency': 'PAY_CURRENCY_USD'},
                        'rawCanonicalZipJobPageUrl': '/c/example/Job/platform-engineer?jid=current-1',
                    },
                },
                'totalListings': 21,
            },
            'pageNumber': 2,
        }
        flight = json.dumps([1, f'4:[{json.dumps(inner)}]'])
        data = extract_next_flight_data([f'self.__next_f.push({flight})'])
        raw = adapt_web_card(data['hydrateJobCardsResponse']['jobCards'][0])
        record = normalize_job_record(raw, {
            'searchQuery': 'engineer', 'searchLocation': 'Austin', 'page': 2, 'offset': None,
        })

        self.assertEqual(data['page'], 2)
        self.assertEqual(data['maxPages'], 21)
        self.assertEqual(record['title'], 'Platform Engineer')
        self.assertTrue(record['isRemote'])
        self.assertEqual(record['salaryMinAnnual'], 104000)
        self.assertEqual(record['employmentTypes'][0], 'Full-time')
        self.assertEqual(
            record['url'], 'https://www.ziprecruiter.com/c/example/Job/platform-engineer?jid=current-1'
        )

    def test_flight_stream_is_rebuilt_from_multiple_fragments(self):
        inner = json.dumps({
            'jobKeys': [{'listingKey': 'multi-1'}],
            'jobKeysMap': {
                'multi-1': {
                    'listingKey': 'multi-1',
                    'title': 'Multi Fragment Engineer',
                    'company': {'name': 'Fragments Inc.'},
                    'location': {'city': 'Denver', 'stateCode': 'CO', 'countryCode': 'US'},
                    'rawCanonicalZipJobPageUrl': '/c/fragments/Job/multi-fragment-engineer?jid=multi-1',
                },
            },
            'totalListings': 5,
        })
        stream = f'4:[{{"serializedJobCardsData":{inner}}},"pageNumber":1]'
        scripts = [
            f'self.__next_f.push({json.dumps([1, stream[:24]])})',
            f'self.__next_f.push({json.dumps([1, stream[24:]])})',
        ]
        data = extract_next_flight_data(scripts)
        self.assertEqual(
            data['hydrateJobCardsResponse']['jobCards'][0]['title'], 'Multi Fragment Engineer'
        )
        self.assertEqual(data['page'], 1)

    def test_current_container_keeps_page_metadata(self):
        container = {
            'jobKeys': [{'listingKey': 'current-1'}],
            'jobCards': [{
                'listingKey': 'current-1',
                'title': 'Current Payload Engineer',
                'company': {'name': 'Current Inc.'},
                'display': {
                    'location': 'Manhattan, NY',
                    'employmentTypes': {'fullDisplay': 'Full-time'},
                    'locationTypes': 'Remote',
                    'benefits': 'Medical, Dental',
                    'rollingPostedAt': '3 days ago',
                },
                'status': {'postedAtUtc': {'seconds': '1788418800', 'nanos': 0}},
                'pay': {'min': 60, 'max': 80, 'interval': 1, 'currency': 5},
                'rawCanonicalZipJobPageUrl': '/c/current/Job/current?jid=current-1',
            }],
            'totalListings': 41,
        }
        flight_row = f'4:[{json.dumps(container)},"pageNumber":2,"jobCount":41]'
        push = f'self.__next_f.push({json.dumps([1, flight_row])})'

        data = extract_next_flight_data([push])
        record = normalize_job_record(
            adapt_web_card(data['hydrateJobCardsResponse']['jobCards'][0]),
            {'searchQuery': 'engineer', 'searchLocation': 'New York, NY', 'page': 2, 'offset': None},
        )

        self.assertEqual(len(data['hydrateJobCardsResponse']['jobCards']), 1)
        self.assertEqual(data['page'], 2)
        self.assertEqual(data['totalListings'], 41)
        self.assertEqual(record['location'], 'Manhattan, NY')
        self.assertEqual(record['employmentTypes'], ['Full-time'])
        self.assertEqual(record['locationTypes'], ['Remote'])
        self.assertTrue(record['isRemote'])
        self.assertEqual(record['benefits'], 'Medical, Dental')
        self.assertEqual(record['daysAgo'], 3)
        self.assertRegex(record['postedDate'], r'^\d{4}-\d{2}-\d{2}T')
        self.assertNotIn('[object Object]', record['postedDate'])

    def test_empty_container_is_a_valid_empty_result(self):
        stream = '4:[{"jobKeys":[],"jobCards":[],"totalListings":0},"pageNumber":1,"jobCount":0]'
        html = f'<html><script>self.__next_f.push({json.dumps([1, stream])})</script></html>'
        data = parse_search_html(html)
        self.assertEqual(len(data['hydrateJobCardsResponse']['jobCards']), 0)
        self.assertEqual(data['totalListings'], 0)
        self.assertEqual(data['maxPages'], 1)

    def test_parse_html_rebuilds_payload(self):
        inner = json.dumps({
            'jobKeys': [{'listingKey': 'html-1'}],
            'jobKeysMap': {
                'html-1': {
                    'listingKey': 'html-1',
                    'title': 'HTML Engineer',
                    'company': {'name': 'Markup Inc.'},
                    'rawCanonicalZipJobPageUrl': '/c/markup/Job/html-engineer?jid=html-1',
                },
            },
            'totalListings': 1,
        })
        flight = json.dumps([1, f'4:[{{"serializedJobCardsData":{inner}}},"pageNumber":1]'])
        html = f'<!doctype html><html><head><script>self.__next_f.push({flight})</script></head></html>'
        data = parse_search_html(html)
        self.assertEqual(data['hydrateJobCardsResponse']['jobCards'][0]['title'], 'HTML Engineer')

    def test_parse_html_falls_back_to_json_ld(self):
        block = json.dumps({
            '@type': 'ItemList',
            'itemListElement': [{
                '@type': 'ListItem',
                'position': 1,
                'name': 'Linked Data Engineer',
                'url': 'https://www.ziprecruiter.com/jobs//j?lvk=ld-1',
            }],
        })
        html = f'<html><head><script type="application/ld+json">{block}</script></head></html>'
        data = parse_search_html(html)
        self.assertEqual(data['hydrateJobCardsResponse']['jobCards'][0]['title'], 'Linked Data Engineer')
        self.assertEqual(data['hydrateJobCardsResponse']['jobCards'][0]['listingKey'], 'ld-1')


class MappingTests(unittest.TestCase):
    def test_web_card_maps_salary_types_and_identity(self):
        raw = adapt_web_card({
            'listingKey': 'abc123',
            'title': 'Backend Engineer',
            'company': {'name': 'Example Inc.'},
            'location': {'city': 'Austin', 'stateCode': 'TX', 'countryCode': 'US'},
            'employmentTypes': [{'name': 1}],
            'pay': {'min': 50, 'max': 60, 'interval': 1},
            'shortDescription': 'Build services.',
        })
        record = normalize_job_record(
            raw, {'searchQuery': 'engineer', 'searchLocation': 'Austin', 'page': 1, 'offset': 0}
        )
        self.assertEqual(record['listingKey'], 'abc123')
        self.assertEqual(record['salaryMinAnnual'], 104000)
        self.assertEqual(record['employmentTypes'], ['Full-time'])
        self.assertEqual(build_job_identity(raw), 'listing:abc123')

    def test_listing_enrichment_maps_all_fields(self):
        raw = adapt_web_card({
            'listingKey': 'enrich-1',
            'matchId': 'match-1',
            'title': 'Enriched Engineer',
            'company': {'id': 'co-1', 'name': 'Enrich Inc.', 'canonicalDisplayName': 'enrich'},
            'companyUrl': '/co/Enrich/Jobs',
            'location': {
                'city': 'Austin', 'state': 'Texas', 'stateCode': 'TX', 'country': 'United States',
                'countryCode': 'US', 'county': 'Travis', 'locId': 'loc-1', 'granularityType': 'CITY',
                'areaSize': 42, 'displayName': 'Austin, TX US',
            },
            'locationUrl': '/jobs-search?location=Austin%2CTX',
            'status': {'isActive': True, 'postedAtUtc': '2026-10-01T00:00:00Z',
                       'rollingPostedAtUtc': '2026-10-01T00:00:00Z'},
            'pay': {
                'min': 40, 'max': 60, 'minAnnual': 80000, 'maxAnnual': 120000,
                'interval': 'PAY_INTERVAL_HOUR', 'currency': 'PAY_CURRENCY_USD',
                'metadata': {'sourceType': 'SOURCE_PROVIDED'},
            },
            'isNew': True,
            'updatedAt': '2026-10-05T00:00:00Z',
            'applyButtonConfig': {'applyButtonType': 'OPEN_EXTERNAL', 'destination': 'EXTERNAL'},
            'display': {'rollingPostedAt': '3 days ago'},
        })
        record = normalize_job_record(raw, {'searchQuery': 'x', 'searchLocation': 'y', 'page': 1, 'offset': 0})
        self.assertEqual(record['matchId'], 'match-1')
        self.assertEqual(record['companyId'], 'co-1')
        self.assertEqual(record['companyCanonicalName'], 'enrich')
        self.assertEqual(record['locationCity'], 'Austin')
        self.assertEqual(record['locationStateCode'], 'TX')
        self.assertEqual(record['locationAreaSize'], 42)
        self.assertEqual(record['salaryMinAnnual'], 80000)
        self.assertEqual(record['salaryMaxAnnual'], 120000)
        self.assertEqual(record['salarySource'], 'SOURCE_PROVIDED')
        self.assertTrue(record['isActive'])
        self.assertTrue(record['isNew'])
        self.assertEqual(record['applyType'], 'OPEN_EXTERNAL')
        self.assertEqual(record['daysAgo'], 3)

    def test_reference_tokens_are_never_saved_as_descriptions(self):
        raw = adapt_web_card({
            'listingKey': 'ref-1',
            'title': 'Reference Engineer',
            'company': {'name': 'Reference Inc.'},
            'description': '$2d',
        })
        record = normalize_job_record(raw, {'searchQuery': 'x', 'searchLocation': 'y', 'page': 1, 'offset': 0})
        self.assertEqual(record['description'], '')

    def test_sanitization_preserves_typed_arrays(self):
        record = sanitize_record_for_dataset({
            'employmentTypes': ['Full-time', ''],
            'locationTypes': ['Remote'],
            'empty': '',
        })
        self.assertEqual(record, {'employmentTypes': ['Full-time'], 'locationTypes': ['Remote']})


class BlockDetectionTests(unittest.TestCase):
    def test_flags_challenge_and_blocked_statuses(self):
        self.assertTrue(detect_blocked_page(status=403))
        self.assertTrue(detect_blocked_page(status=200, title='Just a moment...'))
        self.assertFalse(detect_blocked_page(status=200, title='Jobs', body='<html>ok</html>'))

    def test_snapshot_reports_markers(self):
        snapshot = response_snapshot(status=200, title='Jobs', body='serializedJobCardsData ItemList')
        self.assertTrue(snapshot['markers']['nextFlight'])
        self.assertTrue(snapshot['markers']['jsonLd'])
        self.assertFalse(snapshot['blocked'])


if __name__ == '__main__':
    unittest.main()

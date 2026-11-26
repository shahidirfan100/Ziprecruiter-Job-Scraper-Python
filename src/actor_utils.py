"""ZipRecruiter page parsing and dataset record mapping.

This is a direct port of the original Node implementation: any change here
changes the published dataset contract.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit

# Sentinel for a property that was not present in the source document. JS used
# undefined for this, and the difference between "missing" and "null" decides
# whether a number falls back to null or to 0.
_MISSING = object()

EMPLOYMENT_TYPE_NAMES = {1: 'Full-time', 2: 'Part-time', 3: 'Contract', 4: 'Internship', 5: 'Temporary'}
EMPLOYMENT_TYPE_ALIASES = {**EMPLOYMENT_TYPE_NAMES, 'full_time': 'Full-time', 'part_time': 'Part-time'}
LOCATION_TYPE_NAMES = {1: 'On-site', 2: 'Remote', 3: 'Hybrid'}
PAY_INTERVAL_NAMES = {1: 'hourly', 2: 'daily', 3: 'weekly', 4: 'monthly', 5: 'annual'}
PAY_INTERVAL_ALIASES = {
    'pay_interval_hour': 'hourly',
    'pay_interval_hourly': 'hourly',
    'pay_interval_day': 'daily',
    'pay_interval_daily': 'daily',
    'pay_interval_week': 'weekly',
    'pay_interval_weekly': 'weekly',
    'pay_interval_month': 'monthly',
    'pay_interval_monthly': 'monthly',
    'pay_interval_year': 'annual',
    'pay_interval_annual': 'annual',
    'pay_interval_yearly': 'annual',
}

_BLOCK_TITLE_PATTERN = re.compile(
    r'just a moment|attention required|access denied|are you a robot|verify you are human|unusual traffic',
    re.IGNORECASE,
)
_BLOCK_BODY_PATTERN = re.compile(
    r'just a moment\.\.\.|enable javascript and cookies to continue|__cf_chl_|cf-chl-|verifying you are human',
    re.IGNORECASE,
)
_NEXT_FLIGHT_MARKER = 'self.__next_f.push('


def as_array(value):
    return value if isinstance(value, list) else []


def has_value(value):
    if value is None or value is _MISSING:
        return False
    if isinstance(value, str):
        return len(value.strip()) > 0
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True


def normalize_input_string(value):
    return value.strip() if isinstance(value, str) else ''


def path_value(obj, *keys):
    """Safe nested lookup: returns _MISSING when any level is absent."""
    current = obj
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return _MISSING
        current = current[key]
    return current


def first_value(*values):
    for value in values:
        if value is _MISSING or value is None or value == '':
            continue
        return value
    return _MISSING


def text_value(value):
    """JS `String(value || '')` for the scalar types the payload uses."""
    if value is _MISSING or value is None or value is False:
        return ''
    if value is True:
        return 'true'
    if isinstance(value, (int, float)):
        if isinstance(value, float) and math.isnan(value):
            return ''
        return str(value) if value != 0 else ''
    return str(value)


def js_string(value):
    """JS `String(value)` for scalars."""
    if value is _MISSING or value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    return str(value)


def none_if_missing(value):
    return None if value is _MISSING else value


def _js_number(value):
    if value is _MISSING or value is None:
        return math.nan
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def number_or_null(value):
    number = _js_number(value)
    if not math.isfinite(number):
        return None
    return int(number) if float(number).is_integer() else number


def boolean_value(value):
    if isinstance(value, bool):
        return value
    return bool(re.fullmatch(r'(?i:true|1|yes)', str(value or '').strip()))


def decode_url_fragment(value):
    try:
        return re.sub(r'\s+', ' ', unquote(str(value)).replace('+', ' ').replace('-', ' ')).strip()
    except (TypeError, ValueError):
        return str(value).strip()


def parse_search_url(search_url):
    if not search_url:
        return {'searchQuery': '', 'location': '', 'daysBack': 'any', 'page': 1}

    parsed = urlsplit(search_url)
    params = parse_qsl(parsed.query, keep_blank_values=True)
    pathname_parts = [part for part in parsed.path.split('/') if part]

    def param(name):
        for key, value in params:
            if key == name:
                return value
        return None

    search_query = normalize_input_string(param('search') or param('q') or '')
    location = normalize_input_string(param('location') or '')
    days_back = normalize_input_string(param('days') or param('days_ago') or 'any') or 'any'
    page = number_or_null(param('page')) or 1
    page = max(page, 1)

    if not search_query and pathname_parts and pathname_parts[0].lower() == 'jobs' and len(pathname_parts) > 1:
        search_query = decode_url_fragment(pathname_parts[1])
    if not location:
        for part in pathname_parts:
            if part.lower().startswith('-in-'):
                location = decode_url_fragment(part[4:])
                break
    return {'searchQuery': search_query, 'location': location, 'daysBack': days_back, 'page': page}


def resolve_effective_search(input_data):
    """Search modes are isolated; a supplied keyword beats location beats URL."""
    search_query = normalize_input_string(input_data.get('searchQuery'))
    location = normalize_input_string(input_data.get('location'))
    search_url = normalize_input_string(input_data.get('searchUrl'))
    days_back = normalize_input_string(input_data.get('daysBack')) or 'any'

    if search_query:
        return {'mode': 'keyword', 'searchUrl': '', 'searchQuery': search_query, 'location': location,
                'daysBack': days_back, 'startPage': 1}
    if location:
        return {'mode': 'location', 'searchUrl': '', 'searchQuery': '', 'location': location,
                'daysBack': days_back, 'startPage': 1}
    if search_url:
        parsed = parse_search_url(search_url)
        return {
            'mode': 'url',
            'searchUrl': search_url,
            'searchQuery': parsed['searchQuery'],
            'location': parsed['location'],
            'daysBack': parsed['daysBack'] if parsed['daysBack'] != 'any' else days_back,
            'startPage': parsed['page'],
        }
    return {'mode': 'none', 'searchUrl': '', 'searchQuery': '', 'location': '', 'daysBack': days_back,
            'startPage': 1}


def location_text(location):
    if not location:
        return ''
    if isinstance(location, str):
        return location
    if not isinstance(location, dict):
        return str(location)
    if location.get('displayName'):
        return location['displayName']
    parts = [location.get('city'), location.get('stateCode') or location.get('state'), location.get('countryCode')]
    return ', '.join(str(part) for part in parts if part)


def extract_embedded_json(script_texts):
    for text in as_array(script_texts):
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            continue
        hydrate = path_value(data, 'hydrateJobCardsResponse')
        if isinstance(hydrate, dict) and hydrate.get('jobCards') is not None:
            return data
    raise RuntimeError('ZipRecruiter page did not contain the expected embedded job data.')


def _extract_balanced(text, start, open_char, close_char):
    if start < 0 or start >= len(text) or text[start] != open_char:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == open_char:
            depth += 1
        elif character == close_char:
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:index + 1])
                except ValueError:
                    return None
    return None


def _extract_balanced_object(text, start):
    return _extract_balanced(text, start, '{', '}')


def _object_after_marker(text, marker):
    marker_index = text.find(marker)
    if marker_index < 0:
        return None
    return _extract_balanced_object(text, text.find('{', marker_index + len(marker)))


def _collect_next_flight_fragments(script_texts):
    fragments = []
    for script_text in as_array(script_texts):
        search_from = 0
        while search_from < len(script_text):
            marker_index = script_text.find(_NEXT_FLIGHT_MARKER, search_from)
            if marker_index < 0:
                break
            argument_start = script_text.find('[', marker_index + len(_NEXT_FLIGHT_MARKER))
            payload = _extract_balanced(script_text, argument_start, '[', ']')
            if isinstance(payload, list) and len(payload) > 1 and isinstance(payload[1], str):
                fragments.append(payload[1])
            search_from = marker_index + len(_NEXT_FLIGHT_MARKER)
    return fragments


def extract_next_flight_stream(script_texts):
    return ''.join(_collect_next_flight_fragments(script_texts))


def _number_from_flight(flight_text, key):
    match = re.search(r'"%s"\s*:\s*(\d+)' % re.escape(key), flight_text)
    return int(match.group(1)) if match else None


def _find_job_cards_container(flight_text):
    cards_index = flight_text.find('"jobCards"')
    if cards_index < 0:
        return None

    def is_container(payload):
        if not isinstance(payload, dict) or not isinstance(payload.get('jobCards'), list):
            return False
        return (
            len(payload['jobCards']) > 0
            or len(as_array(payload.get('jobKeys'))) > 0
            or 'totalListings' in payload
            or 'placementId' in payload
        )

    def build(payload):
        total = number_or_null(payload.get('totalListings'))
        return {'cards': payload['jobCards'], 'totalListings': total or None}

    for anchor in ('{"jobKeys"', '{"jobCards"', '{"totalListings"'):
        position = flight_text.rfind(anchor, 0, cards_index)
        while position >= 0:
            payload = _extract_balanced_object(flight_text, position)
            if is_container(payload):
                return build(payload)
            position = flight_text.rfind(anchor, 0, position)

    position = cards_index
    for _ in range(4000):
        position = flight_text.rfind('{', 0, position)
        if position < 0:
            break
        payload = _extract_balanced_object(flight_text, position)
        if is_container(payload):
            return build(payload)
    return None


def _find_job_details(flight_text):
    details_index = flight_text.find('"jobDetails"')
    if details_index < 0:
        return None

    position = details_index
    for _ in range(600):
        position = flight_text.rfind('{', 0, position)
        if position < 0:
            break
        payload = _extract_balanced_object(flight_text, position)
        details = path_value(payload, 'rsp', 'jobDetails')
        if details is _MISSING:
            details = path_value(payload, 'jobDetails')
        if isinstance(details, dict):
            return details
    return None


def extract_next_flight_data(script_texts):
    flight_text = extract_next_flight_stream(script_texts)
    if not flight_text:
        raise RuntimeError('ZipRecruiter page did not contain a supported Next.js job payload.')

    current = _find_job_cards_container(flight_text)
    if current:
        cards = current['cards']
        page = _number_from_flight(flight_text, 'pageNumber') or 1
        total_listings = current['totalListings'] or _number_from_flight(flight_text, 'jobCount') or len(cards)
        max_pages = max(page, math.ceil(total_listings / len(cards))) if cards else page
        return {
            'hydrateJobCardsResponse': {'jobCards': cards},
            'getJobDetailsResponse': {'jobDetails': _find_job_details(flight_text)},
            'page': page,
            'maxPages': max_pages,
            'totalListings': total_listings,
            'layout': 'flight-jobcards',
        }

    cards_payload = _object_after_marker(flight_text, 'serializedJobCardsData')
    job_keys_map = path_value(cards_payload, 'jobKeysMap')
    if isinstance(job_keys_map, dict):
        job_cards = []
        for job_key in as_array(path_value(cards_payload, 'jobKeys')):
            key = path_value(job_key, 'listingKey')
            card = job_keys_map.get(key) if isinstance(key, str) else None
            if card:
                job_cards.append(card)
        cards = job_cards or list(job_keys_map.values())
        details_payload = _object_after_marker(flight_text, 'serializedJobDetailsData')
        page = _number_from_flight(flight_text, 'pageNumber') or 1
        total_listings = number_or_null(path_value(cards_payload, 'totalListings')) or len(cards)
        max_pages = max(page, math.ceil(total_listings / len(cards))) if cards else page
        details = path_value(details_payload, 'jobDetails')
        return {
            'hydrateJobCardsResponse': {'jobCards': cards},
            'getJobDetailsResponse': {'jobDetails': details if isinstance(details, dict) else None},
            'page': page,
            'maxPages': max_pages,
            'totalListings': total_listings,
            'layout': 'serialized-jobcards',
        }
    raise RuntimeError('ZipRecruiter page did not contain a supported Next.js job payload.')


def extract_script_texts_from_html(html):
    if not isinstance(html, str) or not html:
        return []
    scripts = []
    for match in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script>', html, re.IGNORECASE):
        text = match.group(1).strip()
        if text:
            scripts.append(text)
    return scripts


def extract_embedded_json_from_html(html):
    try:
        return extract_embedded_json(extract_script_texts_from_html(html))
    except RuntimeError:
        payload = _object_after_marker(str(html or ''), 'hydrateJobCardsResponse')
        if isinstance(payload, dict) and payload.get('jobCards') is not None:
            return {'hydrateJobCardsResponse': payload}
        raise RuntimeError('ZipRecruiter page did not contain the expected embedded job data.') from None


def extract_listing_key_from_url(value):
    if not value:
        return ''
    try:
        parsed = urlsplit(urljoin('https://www.ziprecruiter.com', str(value)))
    except ValueError:
        return ''
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    return params.get('jid') or params.get('lvk') or ''


def extract_json_ld_item_list(html):
    if not isinstance(html, str) or not html:
        return []
    items = []
    pattern = re.compile(
        r'<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', re.IGNORECASE
    )
    for match in pattern.finditer(html):
        try:
            parsed = json.loads(match.group(1).strip())
        except ValueError:
            continue
        for block in parsed if isinstance(parsed, list) else [parsed]:
            if not isinstance(block, dict) or block.get('@type') != 'ItemList':
                continue
            for item in as_array(block.get('itemListElement')):
                url = item.get('url') if isinstance(item, dict) and isinstance(item.get('url'), str) else ''
                title = item.get('name') if isinstance(item, dict) and isinstance(item.get('name'), str) else ''
                if not url and not title:
                    continue
                items.append({
                    'listingKey': extract_listing_key_from_url(url),
                    'title': title,
                    'rawCanonicalZipJobPageUrl': url,
                })
    return items


def parse_search_html(html):
    scripts = extract_script_texts_from_html(html)
    for extractor in (
        lambda: extract_embedded_json(scripts),
        lambda: extract_next_flight_data(scripts),
        lambda: extract_embedded_json_from_html(html),
    ):
        try:
            return extractor()
        except RuntimeError:
            continue

    json_ld_cards = extract_json_ld_item_list(html)
    return {'hydrateJobCardsResponse': {'jobCards': json_ld_cards}} if json_ld_cards else None


def detect_blocked_page(status=None, title='', body=''):
    code = number_or_null(status) or 0
    if code in (403, 429, 503):
        return True
    if _BLOCK_TITLE_PATTERN.search(title or ''):
        return True
    return bool(_BLOCK_BODY_PATTERN.search(str(body or '')))


def response_snapshot(url=None, status=None, title='', body=None, content_type='', transport='', profile=''):
    text = body if isinstance(body, str) else ''
    return {
        'url': url,
        'status': number_or_null(status) or 0,
        'contentType': content_type or '',
        'title': str(title or '')[:120],
        'bodyLength': len(text),
        'transport': transport or '',
        'profile': profile or '',
        'blocked': detect_blocked_page(status=status, title=title, body=text),
        'markers': {
            'embedded': 'hydrateJobCardsResponse' in text,
            'nextFlight': 'self.__next_f.push' in text or 'serializedJobCardsData' in text,
            'jobCards': '"jobCards"' in text,
            'jsonLd': 'ItemList' in text or 'JobPosting' in text,
        },
    }


def enum_display_name(value, prefix, names=None):
    names = names or {}
    raw_value = path_value(value, 'name')
    if raw_value is _MISSING or raw_value is None:
        raw_value = value
    if raw_value is None or raw_value is _MISSING or raw_value == '':
        return ''
    if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
        return names.get(raw_value) or str(int(raw_value) if float(raw_value).is_integer() else raw_value)

    normalized = re.sub('^' + prefix, '', str(raw_value)).lower()
    if normalized in names:
        return names[normalized]
    return '-'.join(part[:1].upper() + part[1:] for part in normalized.split('_') if part)


def normalize_currency(value):
    normalized = re.sub(r'(?i)^PAY_CURRENCY_', '', str(value or 'USD')).upper()
    return normalized if re.fullmatch(r'[A-Z]{3}', normalized) else 'USD'


def benefits_text(value):
    if isinstance(value, list):
        labels = [enum_display_name(item, 'BENEFIT_TYPE_NAME_', {}) for item in value]
        return ' · '.join(label for label in labels if label and not re.fullmatch(r'\d+', label))
    return value if isinstance(value, str) else ''


def display_list(value):
    if not value:
        return []
    if isinstance(value, str):
        return [part.strip() for part in re.split(r'[,·|]', value) if part.strip()]
    if not isinstance(value, dict):
        return []
    return display_list(value.get('fullDisplay') or value.get('compactDisplay') or '')


def _js_isoformat(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moment.microsecond // 1000:03d}Z'


def iso_now():
    return _js_isoformat(datetime.now(timezone.utc))


def timestamp_to_iso(value):
    if value is _MISSING or value is None or value == '':
        return ''
    if isinstance(value, dict) and 'seconds' in value:
        milliseconds = _js_number(value.get('seconds')) * 1000 + math.floor(_js_number(value.get('nanos')) / 1_000_000)
        if not math.isfinite(milliseconds):
            return ''
        return _js_isoformat(datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value):
            return ''
        return _js_isoformat(datetime.fromtimestamp(value / 1000, tz=timezone.utc))
    raw = str(value)
    try:
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        return raw
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return _js_isoformat(parsed.astimezone(timezone.utc))


def adapt_web_card(card, details=None):
    card = card if isinstance(card, dict) else {}
    details = details if isinstance(details, dict) else None
    listing_key = first_value(card.get('listingKey'), card.get('listing_key'))
    pay = card.get('pay') or path_value(details, 'pay') or {}
    display = card.get('display') or path_value(details, 'display') or {}
    if not isinstance(pay, dict):
        pay = {}
    if not isinstance(display, dict):
        display = {}

    mapped_employment_types = [
        enum_display_name(item, 'EMPLOYMENT_TYPE_NAME_', EMPLOYMENT_TYPE_ALIASES)
        for item in as_array(card.get('employmentTypes') or path_value(details, 'employmentTypes'))
    ]
    mapped_employment_types = [label for label in mapped_employment_types if label]
    mapped_location_types = [
        enum_display_name(item, 'LOCATION_TYPE_NAME_', LOCATION_TYPE_NAMES)
        for item in as_array(card.get('locationTypes') or path_value(details, 'locationTypes'))
    ]
    mapped_location_types = [label for label in mapped_location_types if label]

    employment_types = display_list(display.get('employmentTypes'))
    normalized_employment_types = employment_types or mapped_employment_types
    location_types = display_list(display.get('locationTypesV2') or display.get('locationTypes'))
    normalized_location_types = location_types or mapped_location_types

    canonical_path = first_value(card.get('rawCanonicalZipJobPageUrl'), card.get('canonicalUrl'))
    job_url = ''
    if isinstance(canonical_path, str) and canonical_path.startswith('http'):
        job_url = canonical_path
    elif isinstance(canonical_path, str) and canonical_path:
        job_url = f'https://www.ziprecruiter.com{canonical_path}'
    elif isinstance(listing_key, str) and listing_key:
        job_url = f'https://www.ziprecruiter.com/jobs//j?lvk={listing_key}'

    location = card.get('location') or path_value(details, 'location') or {}
    if not isinstance(location, dict):
        location = {}

    remote_flag = (
        boolean_value(card.get('isRemote'))
        or boolean_value(path_value(location, 'isRemote'))
        or any(
            re.search('remote', str(value), re.IGNORECASE)
            for value in [*normalized_location_types, js_string(text_value(display.get('locationTypes')))]
        )
    )

    adapted = {
        'listing_key': listing_key,
        'match_id': card.get('matchId'),
        'title': first_value(card.get('title'), path_value(details, 'title')),
        'company': first_value(
            path_value(card, 'company', 'name'),
            card.get('companyName'),
            path_value(details, 'company', 'name'),
            path_value(details, 'hiringCompany', 'name'),
        ),
        'company_id': first_value(path_value(card, 'company', 'id'), path_value(details, 'company', 'id')),
        'company_canonical_name': first_value(
            path_value(card, 'company', 'canonicalDisplayName'),
            path_value(details, 'company', 'canonicalDisplayName'),
        ),
        'company_url': first_value(card.get('companyUrl'), path_value(details, 'companyUrl')),
        'location': first_value(
            display.get('location'),
            location_text(card.get('location')),
            card.get('locationText'),
            path_value(details, 'location'),
        ),
        'location_city': location.get('city'),
        'location_state': location.get('state'),
        'location_state_code': location.get('stateCode'),
        'location_country': location.get('country'),
        'location_country_code': location.get('countryCode'),
        'location_county': location.get('county'),
        'location_loc_id': location.get('locId'),
        'location_granularity': location.get('granularityType'),
        'location_area_size': number_or_null(location.get('areaSize')),
        'location_url': card.get('locationUrl'),
        'is_remote': remote_flag,
        'job_type': first_value(
            card.get('jobType'),
            path_value(display, 'employmentTypes', 'fullDisplay'),
            ' · '.join(normalized_employment_types),
        ),
        'employment_types': normalized_employment_types,
        'location_types': normalized_location_types,
        'salary': {
            'min': number_or_null(pay.get('min')),
            'max': number_or_null(pay.get('max')),
            'min_annual': number_or_null(pay.get('minAnnual')),
            'max_annual': number_or_null(pay.get('maxAnnual')),
            'interval': pay.get('interval'),
            'currency': normalize_currency(pay.get('currency')),
            'source': path_value(pay, 'metadata', 'sourceType'),
        },
        'company_logo': first_value(
            path_value(card, 'company', 'logoUrl'),
            path_value(card, 'companyLogo', 'logoUrl'),
            card.get('companyLogoUrl'),
            path_value(details, 'companyLogoUrl'),
        ),
        'company_logo_source': path_value(card, 'companyLogo', 'source'),
        'job_redirect_url': job_url,
        'external_apply_url': first_value(
            path_value(card, 'applyButtonConfig', 'externalApplyUrl'),
            path_value(card, 'buttonConfig', 'externalApplyUrl'),
            path_value(details, 'externalApplyUrl'),
        ),
        'apply_type': first_value(
            path_value(card, 'applyButtonConfig', 'applyButtonType'),
            path_value(card, 'buttonConfig', 'buttonType'),
        ),
        'apply_destination': first_value(
            path_value(card, 'applyButtonConfig', 'destination'),
            path_value(card, 'buttonConfig', 'destination'),
        ),
        'job_redirect_page_url': card.get('jobRedirectPageUrl'),
        'seo_job_redirect_page_url': card.get('seoJobRedirectPageUrl'),
        'share_short_url': card.get('shareShortUrl'),
        'open_seat_id': card.get('openSeatId'),
        'benefits': first_value(
            display.get('benefits'),
            path_value(details, 'display', 'benefits'),
            benefits_text(first_value(card.get('benefits'), path_value(details, 'benefits'))),
        ),
        'days_ago': first_value(number_or_null(card.get('daysAgo')), _parse_days_ago(display.get('rollingPostedAt'))),
        'description': first_value(
            _clean_description(path_value(details, 'htmlFullDescription')),
            _clean_description(card.get('htmlFullDescription')),
            _clean_description(card.get('description')),
        ),
        'short_description': first_value(card.get('shortDescription'), path_value(details, 'shortDescription')),
        'posted_at': timestamp_to_iso(
            first_value(path_value(card, 'status', 'postedAtUtc'), card.get('postedAtUtc'),
                        path_value(details, 'status', 'postedAtUtc'))
        ),
        'rolling_posted_at': timestamp_to_iso(
            first_value(path_value(card, 'status', 'rollingPostedAtUtc'), path_value(card, 'status', 'postedAtUtc'),
                        path_value(details, 'status', 'rollingPostedAtUtc'))
        ),
        'updated_at': timestamp_to_iso(card.get('updatedAt')),
        'is_active': first_value(path_value(card, 'status', 'isActive'), path_value(details, 'status', 'isActive')),
        'is_new': first_value(card.get('isNew'), path_value(details, 'isNew')),
        'display_pay': first_value(path_value(display, 'pay', 'text'), path_value(details, 'display', 'pay', 'text')),
        'display_location_types': first_value(
            path_value(display, 'locationTypesV2', 'fullDisplay'), display.get('locationTypes')
        ),
        'posted_time': first_value(display.get('rollingPostedAt'), path_value(details, 'display', 'rollingPostedAt')),
        'source': 'ziprecruiter_json',
    }
    if isinstance(adapted['benefits'], list):
        adapted['benefits'] = benefits_text(adapted['benefits'])
    return {key: none_if_missing(value) for key, value in adapted.items()}


def _clean_description(value):
    """Next.js flight references look like `$2d` and are not descriptions."""
    text = value.strip() if isinstance(value, str) else ''
    if not text:
        return ''
    if re.fullmatch(r'(?i)\$[0-9a-f]+', text):
        return ''
    if len(text) < 30:
        return ''
    return text


def _parse_days_ago(text):
    value = str(text or '').lower().strip()
    if not value:
        return None
    if re.search(r'today|just posted|new label', value):
        return 0
    if 'yesterday' in value:
        return 1
    match = re.search(r'(\d+)\s*(minute|hour|day|week|month)', value)
    if not match:
        return None
    multipliers = {'minute': 1 / 1440, 'hour': 1 / 24, 'day': 1, 'week': 7, 'month': 30}
    days = int(match.group(1)) * multipliers.get(match.group(2), 1)
    return round(days * 100) / 100


def normalize_interval(interval):
    if isinstance(interval, (int, float)) and not isinstance(interval, bool):
        return PAY_INTERVAL_NAMES.get(interval) or ''
    if re.fullmatch(r'\d+', str(interval or '')):
        return PAY_INTERVAL_NAMES.get(int(interval)) or ''
    normalized = str(interval or '').lower()
    return PAY_INTERVAL_ALIASES.get(normalized, 'annual' if normalized == 'yearly' else normalized)


def annual_amount(amount, interval):
    if not isinstance(amount, (int, float)) or isinstance(amount, bool) or not math.isfinite(amount):
        return None
    multipliers = {'hourly': 2080, 'daily': 260, 'weekly': 52, 'monthly': 12, 'annual': 1, 'yearly': 1}
    multiplier = multipliers.get(normalize_interval(interval))
    return amount * multiplier if multiplier else None


# shortcut: only common currency symbols are formatted like Intl.NumberFormat;
# anything else falls back to "CODE amount".
_CURRENCY_SYMBOLS = {'USD': '$', 'EUR': '€', 'GBP': '£', 'CAD': 'CA$', 'AUD': 'A$', 'INR': '₹'}


def format_salary(minimum, maximum, interval, currency='USD'):
    has_min = isinstance(minimum, (int, float)) and not isinstance(minimum, bool)
    has_max = isinstance(maximum, (int, float)) and not isinstance(maximum, bool)
    if not has_min and not has_max:
        return ''
    symbol = _CURRENCY_SYMBOLS.get(currency, f'{currency} ')
    unit = normalize_interval(interval) or 'annual'

    def amount(value):
        return f'{symbol}{value:,.0f}'

    if has_min and has_max:
        return f'{amount(minimum)} - {amount(maximum)} / {unit}'
    if has_min:
        return f'{amount(minimum)}+ / {unit}'
    return f'Up to {amount(maximum)} / {unit}'


def split_job_type(job_type_text, is_remote, employment_types=None, location_types=None):
    parts = [part.strip() for part in str(job_type_text or '').split('·') if part.strip()]
    normalized_employment = list(employment_types or [])
    if not normalized_employment and parts:
        normalized_employment.append(parts[0])
    normalized_location = list(location_types or [])
    if not normalized_location:
        if is_remote or any(re.search('remote', part, re.IGNORECASE) for part in parts):
            normalized_location.append('Remote')
        elif any(re.search('hybrid', part, re.IGNORECASE) for part in parts):
            normalized_location.append('Hybrid')
        elif any(re.search(r'on[\s-]?site', part, re.IGNORECASE) for part in parts):
            normalized_location.append('On-site')
    return {
        'employmentTypes': normalized_employment,
        'locationTypes': normalized_location,
        'jobType': ' · '.join(parts) or ' · '.join(normalized_employment),
    }


def normalize_job_record(result, context):
    salary = result.get('salary') or {}
    minimum = number_or_null(first_value(salary.get('min'), salary.get('min_amount'), salary.get('min_annual')))
    maximum = number_or_null(first_value(salary.get('max'), salary.get('max_amount'), salary.get('max_annual')))
    interval = normalize_interval(
        salary.get('interval') or (
            'annual' if salary.get('min_annual') is not None or salary.get('max_annual') is not None else ''
        )
    )
    min_annual = (
        number_or_null(salary.get('min_annual'))
        if salary.get('min_annual') is not None
        else annual_amount(minimum, interval)
    )
    max_annual = (
        number_or_null(salary.get('max_annual'))
        if salary.get('max_annual') is not None
        else annual_amount(maximum, interval)
    )
    remote = boolean_value(result.get('is_remote'))
    split = split_job_type(
        text_value(result.get('job_type')),
        remote,
        [js_string(item) for item in as_array(result.get('employment_types'))],
        [js_string(item) for item in as_array(result.get('location_types'))],
    )
    location_types = split['locationTypes']
    is_active = result.get('is_active')
    is_new = result.get('is_new')
    currency = salary.get('currency') or 'USD'

    return {
        'title': text_value(result.get('title')),
        'company': text_value(result.get('company')),
        'companyId': text_value(result.get('company_id')),
        'companyCanonicalName': text_value(result.get('company_canonical_name')),
        'companyUrl': text_value(result.get('company_url')),
        'location': text_value(result.get('location')),
        'locationCity': text_value(result.get('location_city')),
        'locationState': text_value(result.get('location_state')),
        'locationStateCode': text_value(result.get('location_state_code')),
        'locationCountry': text_value(result.get('location_country')),
        'locationCountryCode': text_value(result.get('location_country_code')),
        'locationCounty': text_value(result.get('location_county')),
        'locationLocId': text_value(result.get('location_loc_id')),
        'locationGranularity': text_value(result.get('location_granularity')),
        'locationAreaSize': number_or_null(result.get('location_area_size')),
        'locationUrl': text_value(result.get('location_url')),
        'isRemote': remote,
        'isActive': None if is_active is None else boolean_value(is_active),
        'isNew': None if is_new is None else boolean_value(is_new),
        'jobType': split['jobType'],
        'employmentTypes': split['employmentTypes'],
        'locationTypes': location_types,
        'locationType': ', '.join(location_types),
        'salary': format_salary(minimum, maximum, interval, currency),
        'salaryMin': minimum,
        'salaryMax': maximum,
        'salaryInterval': interval,
        'salaryCurrency': currency,
        'salaryMinAnnual': min_annual,
        'salaryMaxAnnual': max_annual,
        'salarySource': text_value(salary.get('source')),
        'companyLogoUrl': text_value(result.get('company_logo')),
        'companyLogoSource': text_value(result.get('company_logo_source')),
        'url': text_value(result.get('job_redirect_url')),
        'externalApplyUrl': text_value(result.get('external_apply_url')),
        'applyType': text_value(result.get('apply_type')),
        'applyDestination': text_value(result.get('apply_destination')),
        'jobRedirectPageUrl': text_value(result.get('job_redirect_page_url')),
        'seoJobRedirectPageUrl': text_value(result.get('seo_job_redirect_page_url')),
        'shareShortUrl': text_value(result.get('share_short_url')),
        'openSeatId': text_value(result.get('open_seat_id')),
        'benefits': text_value(result.get('benefits')),
        'description': text_value(result.get('description')),
        'shortDescription': text_value(result.get('short_description')),
        'displayPay': text_value(result.get('display_pay')),
        'displayLocationTypes': text_value(result.get('display_location_types')),
        'postedDate': text_value(result.get('posted_at')),
        'rollingPostedAt': text_value(result.get('rolling_posted_at')),
        'postedTime': text_value(result.get('posted_time')),
        'updatedAt': text_value(result.get('updated_at')),
        'daysAgo': number_or_null(result.get('days_ago')),
        'listingKey': text_value(result.get('listing_key')),
        'matchId': text_value(result.get('match_id')),
        'source': result.get('source'),
        'provider': result.get('source'),
        'searchQuery': context.get('searchQuery'),
        'searchLocation': context.get('searchLocation'),
        'page': context.get('page'),
        'offset': context.get('offset'),
        'scrapedAt': iso_now(),
    }


def build_job_identity(result):
    listing_key = normalize_input_string(result.get('listing_key') or result.get('listingKey'))
    if listing_key:
        return f'listing:{listing_key}'
    url = normalize_input_string(
        result.get('job_redirect_url') or result.get('url') or result.get('external_apply_url')
    )
    if url:
        try:
            parsed = urlsplit(url)
            params = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
                      if key not in ('utm_source', 'utm_medium', 'utm_campaign')]
            query = urlencode(params)
            return f'url:{parsed.scheme}://{parsed.netloc}{parsed.path}?{query}'.lower() if query else (
                f'url:{parsed.scheme}://{parsed.netloc}{parsed.path}'.lower()
            )
        except ValueError:
            return f'url:{url.lower()}'
    return '|'.join(
        normalize_input_string(result.get(key)).lower()
        for key in ('title', 'company', 'location', 'job_type')
    )


def sanitize_record_for_dataset(record):
    sanitized = {}
    for key, value in record.items():
        if value is None:
            continue
        if isinstance(value, list):
            cleaned = []
            for item in value:
                text = js_string(item).strip()
                if text and text not in cleaned:
                    cleaned.append(text)
            if cleaned:
                sanitized[key] = cleaned
            continue
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed:
                sanitized[key] = trimmed
            continue
        sanitized[key] = value
    return sanitized

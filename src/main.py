from __future__ import annotations

import asyncio
import json
import math
import random
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from apify import Actor

from .actor_utils import (
    adapt_web_card,
    as_array,
    build_job_identity,
    detect_blocked_page,
    has_value,
    iso_now,
    normalize_job_record,
    parse_search_html,
    resolve_effective_search,
    response_snapshot,
    sanitize_record_for_dataset,
)
from .http_client import HttpTransport

CONFIG = {
    'DEFAULT_MAX_JOBS': 20,
    'DEFAULT_MAX_PAGES': 10,
    'MAX_PAGES_HARD_LIMIT': 200,
    'PROXY_ROUNDS': 5,
    'HTTP_TIMEOUT_MS': 45000,
    'RETRY_BASE_DELAY_MS': 1000,
    'RETRY_MAX_DELAY_MS': 8000,
    'RATE_LIMIT_MAX_DELAY_MS': 30000,
    'SESSION_SWITCH_DELAY_MS': 500,
    'RESOURCE_TIME_BUDGET_MS': 180000,
    'PAGE_DELAY_MS': 300,
    'PAGE_DELAY_JITTER_MS': 500,
}

stats = {
    'pagesProcessed': 0,
    'recordsPushed': 0,
    'duplicatesSkipped': 0,
    'itemErrors': 0,
    'blockedResponses': 0,
    'transportErrors': 0,
    'missingSalary': 0,
    'missingBenefits': 0,
    'missingCompanyLogo': 0,
    'transportCounts': {},
    'stopReason': '',
    'totalListings': None,
    'warnings': [],
    'startTime': time.time(),
}

DISCOVERY_DOC_PATH = Path(__file__).resolve().parent.parent / 'API_DISCOVERY.md'
_discovery_doc = None


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return math.nan
    return number


def _now_iso():
    return iso_now()


def _jitter_delay(base_ms, spread_ms):
    return base_ms + random.random() * spread_ms


def _retry_delay(round_number):
    base = min(CONFIG['RETRY_BASE_DELAY_MS'] * 2 ** round_number, CONFIG['RETRY_MAX_DELAY_MS'])
    return _jitter_delay(base, 600)


def _session_switch_delay():
    return _jitter_delay(CONFIG['SESSION_SWITCH_DELAY_MS'], 400)


def _configured_proxy_groups(proxy_input):
    if not isinstance(proxy_input, dict):
        return []
    return proxy_input.get('groups') or proxy_input.get('apifyProxyGroups') or []


def _proxy_input_for_search(proxy_input, effective_search):
    location = effective_search['location'].lower()
    is_us_search = bool(re.search(r'united states|\busa\b|\bunited states of america\b', location))
    has_country = isinstance(proxy_input, dict) and (proxy_input.get('apifyProxyCountry') or proxy_input.get('countryCode'))
    groups = [str(group).upper() for group in _configured_proxy_groups(proxy_input)]
    uses_apify_proxy = isinstance(proxy_input, dict) and (
        proxy_input.get('useApifyProxy') is True or len(groups) > 0
    )
    # Unblocker selects the country automatically; forcing one shrinks its pool.
    if uses_apify_proxy and 'UNBLOCKER' in groups:
        return proxy_input
    if not is_us_search or has_country or not uses_apify_proxy:
        return proxy_input
    return {**proxy_input, 'apifyProxyCountry': 'US'}


async def _build_proxy_configuration(proxy_input):
    is_cloud_run = Actor.is_at_home()
    groups = _configured_proxy_groups(proxy_input)
    requested_apify_proxy = isinstance(proxy_input, dict) and (
        proxy_input.get('useApifyProxy') is True or len(groups) > 0
    )
    proxy_urls = proxy_input.get('proxyUrls') if isinstance(proxy_input, dict) else None
    has_custom_proxy_urls = isinstance(proxy_urls, list) and len(proxy_urls) > 0

    if not requested_apify_proxy and not has_custom_proxy_urls:
        return None
    if not is_cloud_run and not has_custom_proxy_urls:
        Actor.log.warning(
            'Apify Proxy was requested outside Apify; running without it. '
            'Use an Apify run or provide custom proxy URLs.'
        )
        return None

    return await Actor.create_proxy_configuration(actor_proxy_input=proxy_input)


def _set_param(params, key, value):
    """URLSearchParams.set: replace in place, or append when absent."""
    updated = []
    placed = False
    for existing_key, existing_value in params:
        if existing_key == key:
            if not placed:
                updated.append((key, value))
                placed = True
            continue
        updated.append((existing_key, existing_value))
    if not placed:
        updated.append((key, value))
    return updated


def _delete_param(params, key):
    return [(existing_key, value) for existing_key, value in params if existing_key != key]


def _has_param(params, key):
    return any(existing_key == key for existing_key, _ in params)


def _get_param(params, key):
    for existing_key, value in params:
        if existing_key == key:
            return value
    return None


def _build_page_url(search, page):
    if search['mode'] == 'url':
        parts = urlsplit(search['searchUrl'])
        params = parse_qsl(parts.query, keep_blank_values=True)
        if page > 1 or _has_param(params, 'page'):
            params = _set_param(params, 'page', str(page))
        if _has_param(params, 'days_ago') and not _has_param(params, 'days'):
            params = _set_param(params, 'days', _get_param(params, 'days_ago'))
            params = _delete_param(params, 'days_ago')
        if re.fullmatch(r'\d+', str(search['daysBack'])) and not _has_param(params, 'days'):
            params = _set_param(params, 'days', str(search['daysBack']))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), parts.fragment))

    params = []
    if search['searchQuery']:
        params.append(('search', search['searchQuery']))
    if search['location']:
        params.append(('location', search['location']))
    if re.fullmatch(r'\d+', str(search['daysBack'])):
        params.append(('days', str(search['daysBack'])))
    if page > 1:
        params.append(('page', str(page)))
    return f'https://www.ziprecruiter.com/jobs-search?{urlencode(params)}'


def _sanitize_url(value):
    try:
        parts = urlsplit(value)
    except ValueError:
        return 'invalid-url'
    if not parts.scheme:
        return 'invalid-url'
    return f'{parts.scheme}://{parts.netloc}{parts.path}'


def _extract_title(html):
    match = re.search(r'<title[^>]*>([\s\S]*?)</title>', str(html or ''), re.IGNORECASE)
    return match.group(1).strip() if match else ''


def _load_discovery_doc():
    global _discovery_doc
    if _discovery_doc is None:
        try:
            _discovery_doc = DISCOVERY_DOC_PATH.read_text(encoding='utf-8')
        except OSError:
            _discovery_doc = ''
    return _discovery_doc


def _extract_discovery_guidance(doc):
    if not doc:
        return ''
    blocks = []
    for heading in ('## Failure diagnostics', '## Validation requirements', '## Selected flow'):
        start = doc.find(heading)
        if start < 0:
            continue
        end = doc.find('\n## ', start + len(heading))
        blocks.append(doc[start:end if end >= 0 else len(doc)].strip())
    return '\n\n'.join(blocks)


async def _diagnose_failure(url, error, snapshot):
    doc = _load_discovery_doc()
    Actor.log.warning('ZipRecruiter request failed. Reading API_DISCOVERY.md before diagnosing.')
    if snapshot:
        Actor.log.warning(
            f"Last response: HTTP {snapshot['status']}, {snapshot['bodyLength']} bytes, "
            f"profile {snapshot['profile']}, blocked={snapshot['blocked']}, "
            f"markers={json.dumps(snapshot['markers'])}."
        )
    Actor.log.warning(f"Failure target: {_sanitize_url(url)}. Error: {error or 'unknown error'}.")
    guidance = _extract_discovery_guidance(doc)
    if guidance:
        Actor.log.warning(f'API_DISCOVERY.md guidance:\n{guidance}')
    else:
        Actor.log.warning('API_DISCOVERY.md is missing or has no diagnostic guidance.')


async def _load_resource(transport, url, parse_fn, label, proxy_rounds=CONFIG['PROXY_ROUNDS']):
    last_error = None
    last_snapshot = None
    primary_proxy_retry_used = False
    time_budget_exceeded = False
    started_at = time.time()

    # The profile that last succeeded stays first. If it is challenged, rotate
    # the proxy once before demoting it so the known working browser gets a
    # fresh exit IP instead of a long profile tour.
    def can_rotate_for_primary(profile, round_number):
        nonlocal primary_proxy_retry_used
        if primary_proxy_retry_used or profile != transport.profiles[0]:
            return False
        if not transport.has_proxy or round_number >= proxy_rounds:
            return False
        primary_proxy_retry_used = True
        return True

    for round_number in range(proxy_rounds + 1):
        for profile in transport.profiles:
            if time.time() - started_at >= CONFIG['RESOURCE_TIME_BUDGET_MS'] / 1000:
                time_budget_exceeded = True
                break

            try:
                result = await transport.fetch_once(url, profile)
            except Exception as error:  # noqa: BLE001 - every transport failure is retryable here
                last_error = error
                stats['transportErrors'] += 1
                Actor.log.debug(f'{label}: {profile} network error ({error}).')
                if can_rotate_for_primary(profile, round_number):
                    break
                transport.mark_failure(profile)
                await asyncio.sleep(_session_switch_delay() / 1000)
                continue

            stats['transportCounts'][profile] = stats['transportCounts'].get(profile, 0) + 1
            title = _extract_title(result['html'])
            snapshot = response_snapshot(
                url=_sanitize_url(url),
                status=result['status'],
                title=title,
                body=result['html'],
                transport='scrapling',
                profile=profile,
            )
            last_snapshot = snapshot

            if result['status'] == 429:
                wait_ms = min(
                    result['retry_after_ms'] if result['retry_after_ms'] is not None else _retry_delay(round_number),
                    CONFIG['RATE_LIMIT_MAX_DELAY_MS'],
                )
                Actor.log.debug(f'{label}: HTTP 429, waiting {round(wait_ms / 1000)}s.')
                await asyncio.sleep(wait_ms / 1000)
                continue
            if result['status'] >= 500:
                last_error = RuntimeError(f"{label} returned HTTP {result['status']}")
                Actor.log.debug(f"{label}: {profile} returned HTTP {result['status']}.")
                await asyncio.sleep(_retry_delay(round_number) / 1000)
                continue
            if detect_blocked_page(status=result['status'], title=title, body=result['html']):
                last_error = RuntimeError(f"{label} was blocked with HTTP {result['status']}")
                stats['blockedResponses'] += 1
                Actor.log.debug(f"{label}: {profile} was challenged (HTTP {result['status']}).")
                if can_rotate_for_primary(profile, round_number):
                    break
                transport.mark_failure(profile)
                await asyncio.sleep(_session_switch_delay() / 1000)
                continue
            if result['status'] >= 400:
                last_error = RuntimeError(f"{label} returned HTTP {result['status']}")
                Actor.log.warning(f"{label} failed with HTTP {result['status']}.")
                await _diagnose_failure(url, last_error, snapshot)
                raise last_error

            data = parse_fn(result['html'])
            if not data:
                last_error = RuntimeError(f'{label} response did not contain the expected job payload')
                Actor.log.debug(
                    f'{label}: {profile} returned HTTP {result["status"]} without a payload '
                    f'(title="{snapshot["title"]}", markers={json.dumps(snapshot["markers"])}).'
                )
                if can_rotate_for_primary(profile, round_number):
                    break
                await asyncio.sleep(_session_switch_delay() / 1000)
                continue

            transport.mark_success(profile)
            return {**result, 'data': data, 'snapshot': snapshot}

        if time_budget_exceeded or round_number >= proxy_rounds:
            break
        rotated = await transport.rotate_proxy()
        if not rotated:
            break
        await asyncio.sleep(_session_switch_delay() / 1000)

    await _diagnose_failure(url, last_error, last_snapshot)
    raise last_error or RuntimeError(f'{label} failed without a recorded error')


async def _push_records(records):
    clean_records = [sanitize_record_for_dataset(record) for record in records]
    clean_records = [record for record in clean_records if len(record) > 0]
    if not clean_records:
        return 0
    await Actor.push_data(clean_records)
    return len(clean_records)


async def _scrape_pages(transport, search, target_jobs, max_pages):
    seen_job_keys = set()
    current_page = search['startPage'] or 1
    pages_requested = 0
    empty_pages = 0
    stats['stopReason'] = 'max_pages'

    while pages_requested < max_pages and (not math.isfinite(target_jobs) or stats['recordsPushed'] < target_jobs):
        url = _build_page_url(search, current_page)
        try:
            result = await _load_resource(transport, url, parse_search_html, f'result page {current_page}')
        except Exception as error:
            if stats['recordsPushed'] > 0:
                Actor.log.warning(f'Stopping after partial success so saved jobs are kept: {error}')
                stats['stopReason'] = 'partial_failure'
                break
            raise
        data = result['data']
        cards = as_array((data.get('hydrateJobCardsResponse') or {}).get('jobCards'))
        stats['pagesProcessed'] += 1
        pages_requested += 1

        if not cards:
            Actor.log.info(f'Result page {current_page} returned no job cards. Stopping.')
            stats['stopReason'] = 'no_cards'
            break

        page_total = data.get('totalListings')
        if isinstance(page_total, (int, float)) and math.isfinite(page_total) and page_total > 0:
            stats['totalListings'] = page_total
        details = (data.get('getJobDetailsResponse') or {}).get('jobDetails') or None
        records = []

        for index, card in enumerate(cards):
            try:
                card_details = None
                if details:
                    detail_key = str(details.get('listingKey') or '')
                    if detail_key:
                        if detail_key == str(card.get('listingKey')):
                            card_details = details
                    elif index == 0:
                        card_details = details
                adapted = adapt_web_card(card, card_details)
                if (not has_value(adapted.get('title')) and not has_value(adapted.get('job_redirect_url'))
                        and not has_value(adapted.get('listing_key'))):
                    continue
                identity = build_job_identity(adapted)
                if not identity or identity in seen_job_keys:
                    stats['duplicatesSkipped'] += 1
                    continue
                seen_job_keys.add(identity)

                salary = adapted.get('salary') or {}
                if not has_value(salary.get('min')) and not has_value(salary.get('max')):
                    stats['missingSalary'] += 1
                if not has_value(adapted.get('benefits')):
                    stats['missingBenefits'] += 1
                if not has_value(adapted.get('company_logo')):
                    stats['missingCompanyLogo'] += 1

                records.append(
                    normalize_job_record(adapted, {
                        'searchQuery': search['searchQuery'],
                        'searchLocation': search['location'],
                        'page': current_page,
                        'offset': 0 if current_page == 1 else None,
                    })
                )
            except Exception as error:  # noqa: BLE001 - one malformed card must not stop the page
                stats['itemErrors'] += 1
                Actor.log.warning(f'Skipped a malformed job card on page {current_page}: {error}')

        remaining = max(int(target_jobs) - stats['recordsPushed'], 0) if math.isfinite(target_jobs) else None
        selected_records = records[:remaining] if remaining is not None else records
        pushed = await _push_records(selected_records)
        stats['recordsPushed'] += pushed
        target_label = f'/{int(target_jobs)}' if math.isfinite(target_jobs) else ''
        Actor.log.info(f'Page {current_page}: saved {pushed} jobs; total {stats["recordsPushed"]}{target_label}.')

        if math.isfinite(target_jobs) and stats['recordsPushed'] >= target_jobs:
            stats['stopReason'] = 'target_reached'
            break

        if pushed == 0:
            empty_pages += 1
            if empty_pages >= 2:
                stats['stopReason'] = 'duplicate_exhausted'
                break
        else:
            empty_pages = 0

        reported_page = data.get('page') or current_page
        reported_max_pages = data.get('maxPages')
        if isinstance(reported_max_pages, (int, float)) and math.isfinite(reported_max_pages) and reported_page >= reported_max_pages:
            stats['stopReason'] = 'source_exhausted'
            break

        current_page += 1
        await asyncio.sleep(_jitter_delay(CONFIG['PAGE_DELAY_MS'], CONFIG['PAGE_DELAY_JITTER_MS']) / 1000)


async def main():
    await Actor.init()
    transport = None
    try:
        input_data = await Actor.get_input() or {}
        effective_search = resolve_effective_search(input_data)
        if effective_search['mode'] == 'none':
            raise RuntimeError('Missing search input. Provide searchQuery, location, or searchUrl.')

        max_jobs_value = input_data.get('maxJobs')
        max_jobs_input = _number(max_jobs_value) if max_jobs_value is not None else CONFIG['DEFAULT_MAX_JOBS']
        target_jobs = max_jobs_input if max_jobs_input > 0 else math.inf
        max_pages_value = _number(input_data.get('maxPages'))
        if not math.isfinite(max_pages_value):
            max_pages_value = CONFIG['DEFAULT_MAX_PAGES']
        max_pages = int(min(max(max_pages_value, 1), CONFIG['MAX_PAGES_HARD_LIMIT']))
        configured_proxy_input = input_data.get('proxyConfiguration') or {
            'useApifyProxy': True,
            'apifyProxyGroups': ['RESIDENTIAL'],
            'apifyProxyCountry': 'US',
        }
        proxy_input = _proxy_input_for_search(configured_proxy_input, effective_search)
        proxy_configuration = await _build_proxy_configuration(proxy_input)

        Actor.log.info(
            'Starting ZipRecruiter run: '
            f"mode={effective_search['mode']}, "
            f"searchQuery={effective_search['searchQuery'] or None}, "
            f"location={effective_search['location'] or None}, "
            f"usingSearchUrl={bool(effective_search['searchUrl'])}, "
            f"maxJobs={int(target_jobs) if math.isfinite(target_jobs) else 0}, "
            f'maxPages={int(max_pages)}, '
            f'usingProxy={bool(proxy_configuration)}'
        )

        transport = HttpTransport(
            proxy_configuration=proxy_configuration,
            proxy_input=proxy_input,
            log=Actor.log,
            timeout_ms=CONFIG['HTTP_TIMEOUT_MS'],
        )

        await _scrape_pages(transport, effective_search, target_jobs, max_pages)

        duration_seconds = round(time.time() - stats['startTime'])
        await Actor.set_value('statistics', {
            'provider': 'ziprecruiter_json',
            'jobs': stats['recordsPushed'],
            'pagesProcessed': stats['pagesProcessed'],
            'duplicatesSkipped': stats['duplicatesSkipped'],
            'itemErrors': stats['itemErrors'],
            'blockedResponses': stats['blockedResponses'],
            'transportErrors': stats['transportErrors'],
            'missingSalary': stats['missingSalary'],
            'missingBenefits': stats['missingBenefits'],
            'missingCompanyLogo': stats['missingCompanyLogo'],
            'transportCounts': stats['transportCounts'],
            'proxyRotations': transport.proxy_rotations if transport else 0,
            'totalListings': stats['totalListings'],
            'stopReason': stats['stopReason'],
            'warnings': stats['warnings'],
            'durationSeconds': duration_seconds,
            'finishedAt': _now_iso(),
        })
        Actor.log.info(
            'Run finished: '
            f'jobs={stats["recordsPushed"]}, '
            f'pagesProcessed={stats["pagesProcessed"]}, '
            f'duplicatesSkipped={stats["duplicatesSkipped"]}, '
            f'stopReason={stats["stopReason"]}, '
            f'durationSeconds={duration_seconds}.'
        )
        await Actor.exit()
    except Exception as error:  # noqa: BLE001 - surface the failure and let the platform mark the run failed
        Actor.log.exception('Actor failed')
        raise error
    finally:
        if transport is not None:
            transport.dispose()

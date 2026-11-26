"""HTTP transport for ZipRecruiter, using Scrapling's curl_cffi fetcher."""

from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timezone

from scrapling.fetchers import AsyncFetcher

# Verified against ZipRecruiter on 2026-11-26 from a residential PK connection:
# chrome, chrome150 and safari returned the job payload; every firefox profile
# and the other chrome/edge profiles were served the Cloudflare challenge.
# Firefox is kept last because it won this matrix on 2026-10-21 and may win
# again from a different exit IP.
VERIFIED_PROFILES = ['chrome', 'chrome150', 'safari', 'firefox']

# The target requires the navigation accept value. Without it Cloudflare answers
# 403 even when the TLS fingerprint is accepted. The rest of the fingerprint
# (user-agent, sec-ch-ua, sec-fetch-*) comes from the impersonated profile and
# must not be overridden.
NAVIGATION_HEADERS = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
}

DEFAULT_TIMEOUT_MS = 45000


def _header(headers, name):
    if not headers:
        return None
    getter = getattr(headers, 'get', None)
    if getter:
        value = getter(name)
        if value:
            return value
    items = headers.items() if hasattr(headers, 'items') else []
    for key, value in items:
        if str(key).lower() == name:
            return value
    return None


def parse_retry_after(headers):
    raw = _header(headers, 'retry-after')
    if not raw:
        return None
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        seconds = None
    if seconds is not None and math.isfinite(seconds):
        return max(seconds, 0) * 1000
    try:
        timestamp = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return max(timestamp.timestamp() * 1000 - time.time() * 1000, 0)


class HttpTransport:
    def __init__(self, proxy_configuration=None, proxy_input=None, log=None, timeout_ms=DEFAULT_TIMEOUT_MS):
        proxy_input = proxy_input or {}
        groups = proxy_input.get('groups') or proxy_input.get('apifyProxyGroups') or []
        self._uses_unblocker = 'UNBLOCKER' in [str(group).upper() for group in groups]
        self._proxy_configuration = proxy_configuration
        self._log = log
        self._timeout = timeout_ms / 1000
        self._order = list(VERIFIED_PROFILES)
        self._proxy_url = None
        self._proxy_rotations = 0
        self._initialized = False

    async def _create_proxy_url(self):
        if not self._proxy_configuration:
            return None
        session_id = None if self._uses_unblocker else (
            f'ziprecruiter_{int(time.time() * 1000)}_{self._proxy_rotations}'
        )
        return await self._proxy_configuration.new_url(session_id)

    async def init(self):
        if self._initialized:
            return
        self._proxy_url = await self._create_proxy_url()
        self._initialized = True

    @property
    def profiles(self):
        return list(self._order)

    @property
    def has_proxy(self):
        return bool(self._proxy_url)

    @property
    def proxy_rotations(self):
        return self._proxy_rotations

    async def fetch_once(self, url, profile):
        await self.init()
        options = {'proxy': self._proxy_url} if self._proxy_url else {}
        response = await AsyncFetcher.get(
            url,
            headers=NAVIGATION_HEADERS,
            impersonate=profile,
            stealthy_headers=False,
            retries=0,
            timeout=self._timeout,
            **options,
        )
        body = response.body
        html = body.decode('utf-8', 'ignore') if isinstance(body, bytes) else str(body)
        return {
            'html': html,
            'status': int(response.status),
            'profile': profile,
            'using_proxy': bool(self._proxy_url),
            'retry_after_ms': parse_retry_after(response.headers),
        }

    def mark_success(self, profile):
        self._order = [profile, *[candidate for candidate in self._order if candidate != profile]]

    def mark_failure(self, profile):
        self._order = [*[candidate for candidate in self._order if candidate != profile], profile]

    async def rotate_proxy(self):
        if not self._proxy_configuration:
            return False
        self._proxy_rotations += 1
        self._proxy_url = await self._create_proxy_url()
        if self._log:
            self._log.debug(f'Rotated proxy session (rotation {self._proxy_rotations}).')
        return True

    def dispose(self):
        self._proxy_url = None


logging.getLogger('scrapling').setLevel(logging.CRITICAL)

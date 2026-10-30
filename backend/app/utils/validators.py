"""Destination URL validation and SSRF protection (plan §3.3).

Users control destination URLs, so every delivery resolves the host, rejects
non-public addresses, and connects to the vetted IP directly. Checking at
creation time alone would leave a DNS-rebinding hole.
"""

import asyncio
import contextlib
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

BLOCKED_HOSTNAMES = {"localhost", "metadata.google.internal", "metadata", "instance-data"}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain")
# Not covered by `is_global` in every Python version
EXTRA_BLOCKED_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),  # carrier-grade NAT
    ipaddress.ip_network("198.18.0.0/15"),  # benchmarking
)


class DestinationError(ValueError):
    """The destination is invalid or not allowed. The message is safe to show users."""


class UnresolvableHost(DestinationError):
    """DNS lookup failed or returned nothing."""


def is_public_ip(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if not ip.is_global or ip.is_multicast:
        return False
    return not any(ip in net for net in EXTRA_BLOCKED_NETWORKS if net.version == ip.version)


def parse_destination(url: str, *, require_https: bool, allow_private: bool) -> str:
    """Syntactic checks. Returns the normalised URL."""
    url = url.strip()
    if len(url) > 2048:
        raise DestinationError("URL is too long.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise DestinationError("Enter a valid URL.") from exc
    if parts.scheme not in ("https", "http"):
        raise DestinationError("URL must start with https://")
    if require_https and parts.scheme != "https":
        raise DestinationError("Destination URLs must use HTTPS.")
    if parts.username or parts.password:
        raise DestinationError("URLs with embedded credentials aren't allowed.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise DestinationError("Enter a valid URL.")
    if port == 0:
        raise DestinationError("Enter a valid port.")
    if not allow_private:
        if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES):
            raise DestinationError("Private and local network addresses can’t receive webhooks.")
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = None
        if ip is not None and not is_public_ip(ip):
            raise DestinationError("Private and local network addresses can’t receive webhooks.")
    return url


Resolver = Callable[[str, int], Awaitable[list[IPAddress]]]


async def system_resolver(host: str, port: int) -> list[IPAddress]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: dict[str, IPAddress] = {}
    for _family, _type, _proto, _canon, sockaddr in infos:
        addr = str(sockaddr[0]).split("%", 1)[0]  # strip IPv6 zone id
        seen.setdefault(addr, ipaddress.ip_address(addr))
    return list(seen.values())


# Swappable for tests.
_resolver: Resolver = system_resolver


def set_resolver(resolver: Resolver | None) -> None:
    global _resolver
    _resolver = resolver or system_resolver


async def resolve_destination(host: str, port: int, *, allow_private: bool) -> list[IPAddress]:
    """Resolve and vet every address. Raises DestinationError if any is non-public."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addrs: list[IPAddress] = [literal]
    else:
        try:
            addrs = await _resolver(host, port)
        except (OSError, UnicodeError) as exc:
            raise UnresolvableHost(f"Couldn't resolve {host}.") from exc
    if not addrs:
        raise UnresolvableHost(f"Couldn't resolve {host}.")
    if not allow_private:
        bad = [a for a in addrs if not is_public_ip(a)]
        if bad:
            raise DestinationError("Destination resolves to a private or reserved address.")
    return addrs


async def validate_destination(url: str, *, require_https: bool, allow_private: bool) -> str:
    """Full check used when an endpoint is created or edited.

    Hosts that don't resolve yet are accepted (DNS may not be live); delivery
    re-validates on every attempt anyway.
    """
    url = parse_destination(url, require_https=require_https, allow_private=allow_private)
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    with contextlib.suppress(UnresolvableHost):
        await resolve_destination(parts.hostname or "", port, allow_private=allow_private)
    return url

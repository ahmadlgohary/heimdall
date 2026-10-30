import ipaddress

import pytest

from app.utils.validators import (
    DestinationError,
    is_public_ip,
    parse_destination,
    resolve_destination,
    validate_destination,
)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # CGNAT
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fd00:ec2::254",  # AWS IPv6 metadata
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "224.0.0.1",
    ],
)
def test_non_public_addresses_are_blocked(ip):
    assert not is_public_ip(ipaddress.ip_address(ip))


def test_public_addresses_are_allowed():
    assert is_public_ip(ipaddress.ip_address("93.184.216.34"))
    assert is_public_ip(ipaddress.ip_address("2606:4700:4700::1111"))


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/hook",
        "https://127.0.0.1/hook",
        "https://[::1]/hook",
        "https://169.254.169.254/latest/meta-data",
        "https://metadata.google.internal/computeMetadata",
        "https://printer.local/hook",
        "https://10.0.0.8:8443/hook",
    ],
)
def test_private_destinations_rejected(url):
    with pytest.raises(DestinationError):
        parse_destination(url, require_https=False, allow_private=False)


@pytest.mark.parametrize(
    "url", ["ftp://example.com/x", "not a url", "https://", "https://user:pass@example.com/x"]
)
def test_malformed_destinations_rejected(url):
    with pytest.raises(DestinationError):
        parse_destination(url, require_https=False, allow_private=False)


def test_http_rejected_only_when_https_required():
    assert parse_destination("http://example.com/x", require_https=False, allow_private=False)
    with pytest.raises(DestinationError, match="HTTPS"):
        parse_destination("http://example.com/x", require_https=True, allow_private=False)


def test_private_allowed_in_dev_mode():
    assert parse_destination("http://localhost:4000/hook", require_https=False, allow_private=True)


async def test_hostname_resolving_to_private_ip_is_blocked():
    with pytest.raises(DestinationError, match="private"):
        await resolve_destination("svc.internal-dns.test", 443, allow_private=False)


async def test_unresolvable_host_accepted_at_creation():
    url = "https://not-yet-live.nxdomain.test/hook"
    assert await validate_destination(url, require_https=True, allow_private=False) == url


async def test_creation_rejects_host_resolving_privately():
    with pytest.raises(DestinationError):
        await validate_destination(
            "https://svc.internal-dns.test/hook", require_https=True, allow_private=False
        )

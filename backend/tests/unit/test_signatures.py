import hashlib
import hmac

from app.utils.signatures import compute_signature, signature_header, verify_signature

SECRET = "whsec_test_secret"
TS = 1794312000
BODY = b'{"id":"evt_1","type":"order.created","data":{"order_id":"ORD-1001"}}'


def test_matches_independent_hmac_sha256():
    expected = hmac.new(SECRET.encode(), f"{TS}.".encode() + BODY, hashlib.sha256).hexdigest()
    assert compute_signature(SECRET, TS, BODY) == expected
    assert signature_header(SECRET, TS, BODY) == f"v1={expected}"


def test_changing_payload_changes_signature():
    assert compute_signature(SECRET, TS, BODY) != compute_signature(
        SECRET, TS, BODY.replace(b"1001", b"1002")
    )


def test_changing_timestamp_changes_signature():
    assert compute_signature(SECRET, TS, BODY) != compute_signature(SECRET, TS + 1, BODY)


def test_signs_exact_bytes_not_reserialised_json():
    spaced = b'{"id": "evt_1", "type": "order.created", "data": {"order_id": "ORD-1001"}}'
    assert compute_signature(SECRET, TS, BODY) != compute_signature(SECRET, TS, spaced)


def test_verify_accepts_valid_and_rejects_tampering():
    header = signature_header(SECRET, TS, BODY)
    assert verify_signature(SECRET, TS, BODY, header, now=TS + 10)
    assert not verify_signature(SECRET, TS, BODY + b" ", header, now=TS + 10)
    assert not verify_signature("whsec_other", TS, BODY, header, now=TS + 10)
    assert not verify_signature(SECRET, TS + 1, BODY, header, now=TS + 10)


def test_verify_rejects_stale_timestamps():
    header = signature_header(SECRET, TS, BODY)
    assert not verify_signature(SECRET, TS, BODY, header, now=TS + 301)
    assert not verify_signature(SECRET, "not-a-number", BODY, header, now=TS)


def test_verify_accepts_any_listed_signature_during_rotation():
    header = f"v1=deadbeef {signature_header(SECRET, TS, BODY)}"
    assert verify_signature(SECRET, TS, BODY, header, now=TS)

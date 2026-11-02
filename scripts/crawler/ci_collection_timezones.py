"""Pinned IANA rules for collection only, independent of the host's old tzdata."""
import hashlib
import io
import json
import zipfile
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo as SystemZoneInfo

_root = Path('data/source-samples/crawler/ci-tpe-20261021/timezone')
_receipt = json.loads((_root / 'tzdata-receipt.json').read_text(encoding='utf-8'))
_wheel = Path(_receipt['file'])
RULES_SHA256 = hashlib.sha256(_wheel.read_bytes()).hexdigest()
assert RULES_SHA256 == _receipt['sha256']


@lru_cache(maxsize=None)
def ZoneInfo(key):
    with zipfile.ZipFile(_wheel) as archive:
        return SystemZoneInfo.from_file(io.BytesIO(archive.read('tzdata/zoneinfo/' + key)), key=key)

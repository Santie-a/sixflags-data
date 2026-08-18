"""Sample the queue-times.com wait times for Six Flags Great Adventure.

Appends one row per attraction per 5-minute slot into a per-day CSV under
docs/data/raw/<year>/<YYYY-MM-DD>.csv, keyed on park-local time.

Typical uses:
    python scripts/collect.py --once              # single poll, for testing
    python scripts/collect.py                     # loop until the hour is nearly up
    python scripts/collect.py --duration-minutes 11
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parktime import to_park, utc_now  # noqa: E402

PARK_ID = 37
API_URL = f"https://queue-times.com/parks/{PARK_ID}/queue_times.json"
USER_AGENT = "sixflags-data-collector/1.0 (+https://github.com/)"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "docs", "data", "raw")

SLOT_SECONDS = 300
HEADER = [
    "ts_utc",
    "ts_local",
    "date_local",
    "time_local",
    "ride_id",
    "ride_name",
    "land",
    "is_open",
    "wait_time",
]

# Stop this many minutes before the top of the next hour so a run that GitHub
# starts late truncates itself instead of colliding with the following run.
TAIL_GAP_MINUTES = 3


def log(msg):
    print(f"[{utc_now().strftime('%H:%M:%S')}] {msg}", flush=True)


def floor_slot(dt):
    """Floor an aware datetime to its 5-minute slot, dropping sub-second noise."""
    return dt.replace(
        minute=dt.minute - dt.minute % (SLOT_SECONDS // 60),
        second=0,
        microsecond=0,
    )


def fetch(timeout=30):
    """Return the parsed API payload, or raise."""
    req = urllib.request.Request(API_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def flatten(payload):
    """Yield (ride_id, ride_name, land, is_open, wait_time) for every attraction.

    The API groups most rides under `lands` but can also return ungrouped ones
    at the top level, so both are read.
    """
    for land in payload.get("lands") or []:
        land_name = land.get("name") or ""
        for ride in land.get("rides") or []:
            yield _ride_tuple(ride, land_name)
    for ride in payload.get("rides") or []:
        yield _ride_tuple(ride, "")


def _ride_tuple(ride, land_name):
    return (
        ride.get("id"),
        (ride.get("name") or "").strip(),
        land_name,
        bool(ride.get("is_open")),
        int(ride.get("wait_time") or 0),
    )


def day_file(local_dt):
    """Path of the CSV holding a given park-local moment."""
    return os.path.join(
        RAW_DIR, local_dt.strftime("%Y"), local_dt.strftime("%Y-%m-%d") + ".csv"
    )


def existing_slots(path):
    """The set of ts_utc values already recorded in a day file."""
    if not os.path.exists(path):
        return set()
    slots = set()
    with open(path, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            slots.add(row["ts_utc"])
    return slots


def write_slot(slot_utc, rides):
    """Append one slot's rows. Returns the number of rows written."""
    local = to_park(slot_utc)
    path = day_file(local)
    ts_utc = slot_utc.strftime("%Y-%m-%dT%H:%M:%SZ")

    if ts_utc in existing_slots(path):
        log(f"slot {ts_utc} already recorded in {os.path.basename(path)}, skipping")
        return 0

    os.makedirs(os.path.dirname(path), exist_ok=True)
    is_new = not os.path.exists(path) or os.path.getsize(path) == 0

    with open(path, "a", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        if is_new:
            writer.writerow(HEADER)
        for ride_id, name, land, is_open, wait in rides:
            writer.writerow(
                [
                    ts_utc,
                    local.isoformat(timespec="seconds"),
                    local.strftime("%Y-%m-%d"),
                    local.strftime("%H:%M"),
                    ride_id,
                    name,
                    land,
                    "true" if is_open else "false",
                    wait,
                ]
            )
        fh.flush()
        os.fsync(fh.fileno())

    return len(rides)


def poll(slot_utc):
    """Fetch and persist one slot. Never raises on network trouble."""
    try:
        payload = fetch()
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        log(f"WARN fetch failed for slot {slot_utc:%H:%M}: {exc}")
        return 0

    rides = [r for r in flatten(payload) if r[0] is not None]
    if not rides:
        log("WARN payload contained no rides, skipping slot")
        return 0

    written = write_slot(slot_utc, rides)
    if written:
        open_count = sum(1 for r in rides if r[3])
        log(f"slot {slot_utc:%H:%M} -> {written} rows ({open_count} rides open)")
    return written


def window_end(start, duration_minutes):
    """When the poll loop should stop accepting new slots."""
    next_hour = start.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    end = next_hour - timedelta(minutes=TAIL_GAP_MINUTES)
    if duration_minutes:
        end = min(end, start + timedelta(minutes=duration_minutes))
    return end


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--once", action="store_true", help="poll a single slot and exit")
    ap.add_argument(
        "--duration-minutes",
        type=int,
        default=None,
        help="cap the loop length (still never runs past the hour boundary)",
    )
    args = ap.parse_args()

    start = utc_now()
    slot = floor_slot(start)

    if args.once:
        poll(slot)
        return 0

    end = window_end(start, args.duration_minutes)
    log(f"collecting slots from {slot:%H:%M} until {end:%H:%M} UTC")

    total = poll(slot)
    while True:
        slot += timedelta(seconds=SLOT_SECONDS)
        if slot > end:
            break
        wait = (slot - utc_now()).total_seconds()
        if wait > 0:
            time.sleep(wait)
        total += poll(slot)

    log(f"done, {total} rows written this run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

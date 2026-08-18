"""Write docs/data/index.json -- the manifest the front-end loads on boot.

Kept incremental: the attraction roster is refreshed from the newest few day
files and merged over the previous manifest (so rides that have been retired
stay selectable for the dates they existed), and row counts are recomputed only
for day files whose size changed.
"""

import json
import os
import sys
from datetime import timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parktime import PARK_TZ_NAME, utc_now  # noqa: E402
from rawdata import DATA_DIR, raw_files, read_day  # noqa: E402

PARK = {"id": 37, "name": "Six Flags Great Adventure", "timezone": PARK_TZ_NAME}
ROSTER_REFRESH_DAYS = 3
INDEX_PATH = os.path.join(DATA_DIR, "index.json")


def load_previous():
    if not os.path.exists(INDEX_PATH):
        return {}
    try:
        with open(INDEX_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def count_rows(path):
    with open(path, "r", encoding="utf-8") as fh:
        return max(0, sum(1 for _ in fh) - 1)


def main():
    previous = load_previous()
    files = raw_files()

    rides = {str(r["id"]): r for r in previous.get("rides", [])}
    for _, path in files[-ROSTER_REFRESH_DAYS:]:
        for row in read_day(path):
            rides[row["ride_id"]] = {
                "id": int(row["ride_id"]),
                "name": row["ride_name"],
                "land": row["land"],
            }

    prior_dates = {d["date"]: d for d in previous.get("dates", [])}
    dates = []
    for date_str, path in files:
        size = os.path.getsize(path)
        cached = prior_dates.get(date_str)
        rows = cached["rows"] if cached and cached.get("bytes") == size else count_rows(path)
        dates.append(
            {
                "date": date_str,
                "path": f"raw/{date_str[:4]}/{date_str}.csv",
                "rows": rows,
                "bytes": size,
            }
        )

    manifest = {
        "park": PARK,
        "generated_at": utc_now().replace(microsecond=0).astimezone(timezone.utc).isoformat(),
        "rides": sorted(rides.values(), key=lambda r: r["name"].lower()),
        "dates": dates,
    }

    # newline="" keeps this byte-identical whether it is written on the Linux
    # runner or on Windows, so the manifest does not churn between platforms.
    with open(INDEX_PATH, "w", encoding="utf-8", newline="") as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    print(f"index: {len(manifest['rides'])} rides, {len(dates)} day(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

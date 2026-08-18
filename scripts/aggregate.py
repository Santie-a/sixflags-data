"""Build daily / weekly / hourly-profile aggregates from the raw samples.

All wait-time statistics are computed over OPEN samples only: a closed ride
reports wait_time 0, and folding those into the mean would make a popular ride
that broke down look short. Downtime stays visible through pct_open.

Incremental by design -- only days missing from daily.csv, plus the two most
recent days (which may have been partial last time), are re-read.
"""

import os
import sys
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rawdata import (  # noqa: E402
    AGG_DIR,
    percentile,
    r1,
    raw_files,
    raw_path,
    read_csv,
    read_day,
    write_csv,
)

HOURLY_PROFILE_DAYS = 90

DAILY_HEADER = [
    "date_local",
    "ride_id",
    "ride_name",
    "land",
    "samples",
    "open_samples",
    "pct_open",
    "avg_wait_open",
    "median_wait_open",
    "p90_wait_open",
    "max_wait",
    "first_open_local",
    "last_open_local",
]

WEEKLY_HEADER = [
    "iso_year_week",
    "week_start",
    "ride_id",
    "ride_name",
    "days_operating",
    "avg_wait_open",
    "max_wait",
    "total_open_samples",
    "avg_pct_open",
]

HOURLY_HEADER = [
    "ride_id",
    "ride_name",
    "day_of_week",
    "dow_name",
    "hour_local",
    "avg_wait_open",
    "p90_wait_open",
    "max_wait",
    "pct_open",
    "open_samples",
    "samples",
    "days_counted",
]

DOW_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def summarise_day(date_str):
    """One row per ride for a single day, or [] if the file is unreadable."""
    path = raw_path(date_str)
    if not os.path.exists(path):
        return []

    per_ride = defaultdict(
        lambda: {"name": "", "land": "", "samples": 0, "waits": [], "times": []}
    )
    for row in read_day(path):
        ride = per_ride[row["ride_id"]]
        ride["name"] = row["ride_name"]
        ride["land"] = row["land"]
        ride["samples"] += 1
        if row["is_open"]:
            ride["waits"].append(row["wait_time"])
            ride["times"].append(row["time_local"])

    rows = []
    for ride_id, ride in per_ride.items():
        waits = sorted(ride["waits"])
        n_open = len(waits)
        pct_open = 100.0 * n_open / ride["samples"] if ride["samples"] else 0.0
        rows.append(
            [
                date_str,
                ride_id,
                ride["name"],
                ride["land"],
                ride["samples"],
                n_open,
                r1(pct_open),
                r1(sum(waits) / n_open) if n_open else "",
                r1(percentile(waits, 50)),
                r1(percentile(waits, 90)),
                max(waits) if n_open else "",
                min(ride["times"]) if ride["times"] else "",
                max(ride["times"]) if ride["times"] else "",
            ]
        )
    rows.sort(key=lambda r: (r[2].lower(), r[1]))
    return rows


def build_daily():
    """Refresh daily.csv incrementally. Returns every daily row."""
    path = os.path.join(AGG_DIR, "daily.csv")
    existing = read_csv(path)
    by_date = defaultdict(list)
    for row in existing:
        by_date[row["date_local"]].append([row.get(c, "") for c in DAILY_HEADER])

    available = [d for d, _ in raw_files()]
    stale = set(available) - set(by_date)
    stale.update(available[-2:])  # yesterday and today may have grown since

    for date_str in sorted(stale):
        rows = summarise_day(date_str)
        if rows:
            by_date[date_str] = rows
        else:
            by_date.pop(date_str, None)
    if stale:
        print(f"daily: recomputed {len(stale)} day(s): {', '.join(sorted(stale))}")

    all_rows = [r for d in sorted(by_date) for r in by_date[d]]
    write_csv(path, DAILY_HEADER, all_rows)
    print(f"daily: {len(all_rows)} rows across {len(by_date)} day(s)")
    return all_rows


def build_weekly(daily_rows):
    """Weekly rollup derived exactly from the daily rows.

    The mean is re-weighted by open_samples rather than averaging the daily
    averages, so a short operating day cannot outweigh a full one.
    """
    idx = {name: i for i, name in enumerate(DAILY_HEADER)}
    groups = defaultdict(
        lambda: {
            "name": "",
            "sum_wait": 0.0,
            "open": 0,
            "max": 0,
            "days": 0,
            "pct_sum": 0.0,
        }
    )

    for row in daily_rows:
        n_open = int(row[idx["open_samples"]] or 0)
        if not n_open:
            continue
        d = date.fromisoformat(row[idx["date_local"]])
        iso_year, iso_week, _ = d.isocalendar()
        key = (f"{iso_year}-W{iso_week:02d}", row[idx["ride_id"]])
        g = groups[key]
        g["name"] = row[idx["ride_name"]]
        g["sum_wait"] += float(row[idx["avg_wait_open"]]) * n_open
        g["open"] += n_open
        g["max"] = max(g["max"], int(row[idx["max_wait"]] or 0))
        g["days"] += 1
        g["pct_sum"] += float(row[idx["pct_open"]] or 0)

    rows = []
    for (week, ride_id), g in groups.items():
        iso_year, iso_week = int(week[:4]), int(week[6:])
        week_start = date.fromisocalendar(iso_year, iso_week, 1).isoformat()
        rows.append(
            [
                week,
                week_start,
                ride_id,
                g["name"],
                g["days"],
                r1(g["sum_wait"] / g["open"]),
                g["max"],
                g["open"],
                r1(g["pct_sum"] / g["days"]),
            ]
        )
    rows.sort(key=lambda r: (r[0], r[3].lower()))
    write_csv(os.path.join(AGG_DIR, "weekly.csv"), WEEKLY_HEADER, rows)
    print(f"weekly: {len(rows)} rows")


def build_hourly_profile():
    """Typical wait by ride, weekday and hour over a trailing window.

    Recomputed in full each run: the window is capped at HOURLY_PROFILE_DAYS,
    so the cost stays flat no matter how much history accumulates.
    """
    available = [d for d, _ in raw_files()]
    if not available:
        write_csv(os.path.join(AGG_DIR, "hourly_profile.csv"), HOURLY_HEADER, [])
        return

    cutoff = (date.fromisoformat(available[-1]) - timedelta(days=HOURLY_PROFILE_DAYS)).isoformat()
    window = [d for d in available if d >= cutoff]

    buckets = defaultdict(
        lambda: {"name": "", "waits": [], "days": set(), "samples": 0}
    )
    for date_str in window:
        for row in read_day(raw_path(date_str)):
            d = date.fromisoformat(row["date_local"])
            key = (row["ride_id"], d.weekday(), int(row["time_local"][:2]))
            b = buckets[key]
            b["name"] = row["ride_name"]
            b["samples"] += 1
            if row["is_open"]:
                b["waits"].append(row["wait_time"])
                b["days"].add(row["date_local"])

    rows = []
    for (ride_id, dow, hour), b in buckets.items():
        waits = sorted(b["waits"])
        n_open = len(waits)
        rows.append(
            [
                ride_id,
                b["name"],
                dow,
                DOW_NAMES[dow],
                hour,
                r1(sum(waits) / n_open) if n_open else "",
                r1(percentile(waits, 90)),
                max(waits) if n_open else "",
                r1(100.0 * n_open / b["samples"]) if b["samples"] else "",
                n_open,
                b["samples"],
                len(b["days"]),
            ]
        )
    rows.sort(key=lambda r: (r[1].lower(), r[2], r[4]))
    write_csv(os.path.join(AGG_DIR, "hourly_profile.csv"), HOURLY_HEADER, rows)
    print(f"hourly_profile: {len(rows)} rows over {len(window)} day(s)")


def main():
    daily_rows = build_daily()
    build_weekly(daily_rows)
    build_hourly_profile()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

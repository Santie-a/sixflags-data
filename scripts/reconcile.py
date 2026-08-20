"""Re-apply this run's samples on top of whatever the remote already has.

Collect runs overlap at every handover: the outgoing run is still pushing when
the incoming one has already checked out. Both then append to the tail of the
same day file, which is precisely the shape git cannot rebase -- it sees two
different blocks of new lines at the same spot and stops on a conflict. The
whole 55-minute window was thrown away each time that happened.

So the commit step no longer rebases. It resets hard to the remote and calls
this script to merge the rows back in. Samples are keyed on (ts_utc, ride_id),
the same key collect.py dedupes on, so the union is well defined regardless of
which side observed a slot first and applying it twice changes nothing.

Usage: reconcile.py <saved-raw-dir>
"""

import csv
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rawdata import RAW_DIR  # noqa: E402


def key(row):
    return (row.get("ts_utc"), row.get("ride_id"))


def read_rows(path):
    if not os.path.exists(path):
        return [], []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, [])
        return header, [r for r in reader if r]


def merge(saved_path, target_path):
    """Fold saved_path's rows into target_path. Returns rows added."""
    saved_header, saved_rows = read_rows(saved_path)
    if not saved_rows:
        return 0

    target_header, target_rows = read_rows(target_path)
    if not target_header:
        # The remote has never seen this day -- ours is the whole file.
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        shutil.copyfile(saved_path, target_path)
        return len(saved_rows)

    if target_header != saved_header:
        raise SystemExit(
            f"{target_path}: header mismatch, refusing to merge\n"
            f"  remote: {target_header}\n  ours:   {saved_header}"
        )

    index = {c: i for i, c in enumerate(target_header)}
    ts, rid = index["ts_utc"], index["ride_id"]
    have = {(r[ts], r[rid]) for r in target_rows}

    added = [r for r in saved_rows if (r[ts], r[rid]) not in have]
    if not added:
        return 0

    rows = target_rows + added
    # Stable, so rides keep their API order inside a slot; this only matters if
    # the two sides interleave in time, which a late handover can produce.
    rows.sort(key=lambda r: r[ts])

    with open(target_path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(target_header)
        writer.writerows(rows)
    return len(added)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: reconcile.py <saved-raw-dir>")
    saved_dir = sys.argv[1]

    total = 0
    for root, _, names in os.walk(saved_dir):
        for name in sorted(names):
            if not name.endswith(".csv"):
                continue
            saved_path = os.path.join(root, name)
            rel = os.path.relpath(saved_path, saved_dir)
            added = merge(saved_path, os.path.join(RAW_DIR, rel))
            if added:
                print(f"{rel}: +{added} rows")
            total += added

    print(f"reconciled {total} row(s) onto the remote state")


if __name__ == "__main__":
    main()

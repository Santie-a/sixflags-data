"""Shared helpers for reading the raw sample files."""

import csv
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "docs", "data", "raw")
AGG_DIR = os.path.join(ROOT, "docs", "data", "agg")
DATA_DIR = os.path.join(ROOT, "docs", "data")


def raw_files():
    """All raw day files, oldest first, as (date_str, path)."""
    paths = glob.glob(os.path.join(RAW_DIR, "*", "*.csv"))
    out = [(os.path.basename(p)[:-4], p) for p in paths]
    return sorted(out)


def raw_path(date_str):
    return os.path.join(RAW_DIR, date_str[:4], date_str + ".csv")


def read_day(path):
    """Yield sample dicts with wait_time/is_open already coerced."""
    with open(path, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                row["wait_time"] = int(row["wait_time"])
            except (TypeError, ValueError):
                continue
            row["is_open"] = row["is_open"] == "true"
            yield row


def percentile(sorted_vals, p):
    """Nearest-rank percentile over a pre-sorted list."""
    if not sorted_vals:
        return None
    k = -(-p * len(sorted_vals) // 100) - 1  # ceil division, then 0-indexed
    return sorted_vals[max(0, min(k, len(sorted_vals) - 1))]


def r1(value):
    """Round for CSV output, keeping integers tidy."""
    if value is None:
        return ""
    return f"{value:.1f}"


def write_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))

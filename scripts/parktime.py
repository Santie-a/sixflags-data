"""Park-local timezone helper.

Uses the system IANA database when available (always the case on the GitHub
Actions ubuntu runners). Falls back to a hand-rolled US Eastern rule so a bare
Windows/CPython install without the ``tzdata`` package still works.
"""

from datetime import datetime, timedelta, timezone, tzinfo

PARK_TZ_NAME = "America/New_York"


def _nth_weekday(year, month, weekday, n):
    """Date of the nth (1-based) given weekday in a month. weekday: Mon=0."""
    d = datetime(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + 7 * (n - 1))


class _USEastern(tzinfo):
    """DST rules in force since 2007: second Sunday of March 02:00 local
    standard through first Sunday of November 02:00 local daylight."""

    def _is_dst(self, dt):
        start = _nth_weekday(dt.year, 3, 6, 2) + timedelta(hours=2)
        end = _nth_weekday(dt.year, 11, 6, 1) + timedelta(hours=2)
        return start <= dt.replace(tzinfo=None) < end

    def utcoffset(self, dt):
        return timedelta(hours=-4 if self._is_dst(dt) else -5)

    def dst(self, dt):
        return timedelta(hours=1) if self._is_dst(dt) else timedelta(0)

    def tzname(self, dt):
        return "EDT" if self._is_dst(dt) else "EST"

    def fromutc(self, dt):
        # dt is naive, expressed in UTC. Guess with standard time, then refine.
        guess = dt + timedelta(hours=-5)
        if self._is_dst(guess + timedelta(hours=1)):
            guess += timedelta(hours=1)
        return guess.replace(tzinfo=self)


def park_tz():
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(PARK_TZ_NAME)
    except Exception:
        return _USEastern()


PARK_TZ = park_tz()


def to_park(dt):
    """Convert an aware datetime to park-local time."""
    return dt.astimezone(PARK_TZ)


def utc_now():
    return datetime.now(timezone.utc)

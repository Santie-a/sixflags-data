# Six Flags Great Adventure — Queue Times Collector

Samples the [queue-times.com](https://queue-times.com/parks/37/) API for **Six Flags
Great Adventure** every 5 minutes, stores the history as plain CSV, and serves a small
static site where you can pick an attraction and a day, average it into 15/30/60-minute
windows, and download the result for Excel.

**Live site: <https://santie-a.github.io/sixflags-data/>**

Everything runs on free GitHub infrastructure: **Actions** collects, **Pages** serves.
No server, no database, no API key, no cost.

---

## How it works

```
queue-times.com API
        │  every 5 min
        ▼
  collect.yml ──── ~55-min runs, chained back to back, ONE commit each
        │
        ▼
docs/data/raw/2026/2026-08-17.csv        one file per park-local day
        │
        ▼
 aggregate.yml ── nightly ── docs/data/agg/{daily,weekly,hourly_profile}.csv
        │                    docs/data/index.json  (manifest the page boots from)
        ▼
   GitHub Pages ── docs/  ── filter, chart, download
```

The data lives **inside `docs/`**, so the page reads it with relative paths — same
origin, no CORS, nothing to configure.

### Why long runs instead of a 5-minute cron

GitHub deprioritises short-interval scheduled workflows and frequently skips them, and
a 5-minute cron would also produce ~288 commits a day. Instead each workflow run polls
internally every 5 minutes for **55 minutes** and commits once.

The window is measured from the run's **own start**, never from the clock. GitHub fires
scheduled runs late — on a normal day 20 to 40 minutes late — so a window that ended at
a fixed clock time would lose exactly the delay, every hour, always at the top of the
hour. Runs are chained instead: the cron fires twice an hour, the `collect` concurrency
group holds the extra trigger in the queue, and it starts the moment the running one
stops. Overlap costs nothing because `collect.py` skips any 5-minute slot the day file
already contains.

Chaining means two runs briefly overlap: the outgoing one is still committing when the
incoming one has already checked out. Both then append to the tail of the same day
file, and git cannot rebase that — it reads two different blocks of new lines in the
same place as a conflict and stops, taking the whole 55-minute window with it. So the
commit step does not rebase. It sets the tree to the remote verbatim and re-applies its
own rows with `scripts/reconcile.py`, keyed on `(ts_utc, ride_id)` exactly as
`collect.py` dedupes, then retries the whole thing if the push loses another race.

---

## Setup

1. **Create a public repo** and push this folder to it.

   Public matters: Actions minutes and Pages are free without limit on public repos.
   On a private repo the free tier's 2,000 minutes/month would run out in about three days.

   ```bash
   git init && git add . && git commit -m "Initial commit" && git branch -M main
   ```

   Then add your remote and push.

2. **Enable GitHub Pages** — Settings → Pages → Source: *Deploy from a branch*,
   Branch: `main`, folder: **`/docs`**. The site appears at
   `https://<user>.github.io/<repo>/`.

3. **Allow Actions to push** — Settings → Actions → General → Workflow permissions →
   **Read and write permissions**.

4. **Kick off the first run** — Actions → *Collect queue times* → *Run workflow*.
   After it finishes, the day appears on the site. From then on it is automatic.

---

## Running it locally

No dependencies — the Python standard library only.

```bash
python scripts/collect.py --once
```

```bash
python scripts/aggregate.py && python scripts/build_index.py
```

```bash
python -m http.server 8000 --directory docs
```

Then open <http://localhost:8000>. (Opening `docs/index.html` as a `file://` URL will
not work — the browser blocks the `fetch` calls. Serve the folder.)

`collect.py` also accepts `--duration-minutes N` to cap a poll loop, which is handy
for testing: `python scripts/collect.py --duration-minutes 11` records 3 slots.

---

## The data

### `docs/data/raw/<year>/<YYYY-MM-DD>.csv`

One row per attraction per 5-minute slot, filed by **park-local** date
(America/New_York), so a day file always matches a real operating day.

| column | meaning |
|---|---|
| `ts_utc` | sample slot in UTC, aligned to 5 minutes |
| `ts_local`, `date_local`, `time_local` | the same moment in park time |
| `ride_id`, `ride_name`, `land` | attraction identity |
| `is_open` | whether the ride was running |
| `wait_time` | posted wait in minutes (meaningless when closed) |

About 8,500 rows (~700 KB) per operating day.

### `docs/data/agg/`

| file | grain |
|---|---|
| `daily.csv` | attraction × day — average, median, p90, max, % of day open |
| `weekly.csv` | attraction × ISO week — sample-weighted average, max, days operating |
| `hourly_profile.csv` | attraction × weekday × hour, trailing 90 days — the "typical Saturday at 3pm" table |

**Every average covers open samples only.** A closed ride reports `wait_time: 0`, and
letting those into the mean would make a popular ride that broke down look like it had
a short queue. `pct_open` keeps the downtime visible instead of hiding it in the average.

The weekly average is re-weighted by sample count rather than averaging the daily
averages, so a half-day cannot outweigh a full one.

---

## Reading and downloading

Both the on-screen tables and the CSV export are **pivot tables**, and the shape
follows your filter — so what you download is exactly what you were looking at.

**One day selected** — rows are time windows, columns are the attractions you picked:

| Window | Nitro | El Toro | Medusa |
|---|---|---|---|
| 14:30 | 35.8 | 31.7 | 40.0 |
| 15:00 | 37.5 | 33.3 | 41.7 |

**Several days selected** — one table per attraction, columns become weekdays, each
averaged across every matching day in the range:

| Window | Friday | Saturday | Sunday |
|---|---|---|---|
| 14:30 | 22.5 | 35.8 | 38.3 |
| 15:00 | 24.2 | 37.5 | 39.6 |

The **Aggregates** tab is the same idea as heatmaps — *Daily* and *Weekly* put dates or
ISO weeks down the side and attractions across the top, and *Typical hour* gives each
attraction an hour-by-weekday grid. Colour intensity is shared across every table in
the view, so a headliner and a kiddie ride stay comparable instead of both looking hot.

The **Value** dropdown switches every table and every export between *average wait*,
*max wait*, and *% of time open*.

### Excel separator

The **CSV separator** dropdown defaults to **semicolon**, which is what Spanish and
other European/Latin-American Excel installs expect. In that mode the file also gets a
`sep=;` hint line and **comma decimals** (`17,5`), which is the pairing those locales
need. Switch to comma for US/English Excel and you get dot decimals and no hint line.
Either way the file is written UTF-8 with a BOM, so names like *Barrels O’ Fun* and
*Houdini’s Great Escape* survive the trip.

Blank cells mean no data — the park was shut, or the ride was down for that whole window.

---

## Things worth knowing

- **There is no backfill.** The API only ever returns *right now*, so history starts
  with your first workflow run. It is worth starting collection before you need the data.

- **GitHub disables scheduled workflows after 60 days without repository activity**,
  and commits pushed by `GITHUB_TOKEN` do *not* reset that timer. GitHub emails you
  first, and re-enabling is one click in the Actions tab. To avoid it entirely, push
  any commit of your own every couple of months:

  ```bash
  git commit --allow-empty -m "keepalive" && git push
  ```

- **Scheduled runs get delayed** when GitHub is busy — routinely by 20-40 minutes, and
  occasionally a run is dropped outright. Chaining absorbs this, but a short gap in the
  samples now and then is normal, not a bug.

- **Repo growth** is roughly 250 MB per year of raw CSV. Comfortably within GitHub's
  limits, and the site only ever downloads the days you actually select.

---

Wait time data comes from **[Queue-Times.com](https://queue-times.com/)**.
This project is not affiliated with Six Flags.

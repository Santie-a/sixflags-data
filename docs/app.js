/* Six Flags Great Adventure queue-time explorer.
   No build step, no dependencies: the page reads the CSVs that the collector
   workflow commits alongside it. */
(function () {
  'use strict';

  var MAX_SERIES = 8;
  var SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4',
                     '--series-5', '--series-6', '--series-7', '--series-8'];
  var AGG_META = {
    daily: {
      file: 'daily.csv',
      title: 'Daily',
      note: 'Rows are operating days, columns are attractions. Averages cover open samples only, so a ride that broke down does not read as a short queue.'
    },
    weekly: {
      file: 'weekly.csv',
      title: 'Weekly',
      note: 'Rows are ISO weeks, columns are attractions. The average is re-weighted by sample count, so a short operating day cannot outweigh a full one.'
    },
    hourly_profile: {
      file: 'hourly_profile.csv',
      title: 'Typical hour',
      note: 'One table per attraction: rows are hours, columns are weekdays. Shows what a given weekday and hour usually looks like over the last 90 days.'
    }
  };

  var state = {
    tab: 'explore',
    agg: 'daily',
    rides: [],
    dates: [],
    pathByDate: {},
    selected: [],
    slots: {},
    search: '',
    from: '',
    to: '',
    bucket: 30,
    metric: 'avg',
    delimiter: ';',
    explore: { domain: [], series: [], rows: [] },
    aggRows: []
  };

  var el = function (id) { return document.getElementById(id); };
  var cache = new Map();

  /* ── CSV ─────────────────────────────────────────────────── */

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], field = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
        } else { field += c; }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = ''; rows.push(row); row = [];
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toObjects(cells) {
    if (!cells.length) return { header: [], rows: [] };
    var header = cells[0];
    var rows = [];
    for (var i = 1; i < cells.length; i++) {
      if (cells[i].length === 1 && cells[i][0] === '') continue;
      var o = {};
      for (var j = 0; j < header.length; j++) o[header[j]] = cells[i][j] === undefined ? '' : cells[i][j];
      rows.push(o);
    }
    return { header: header, rows: rows };
  }

  function loadCSV(path) {
    if (!cache.has(path)) {
      cache.set(path, fetch(path).then(function (r) {
        if (!r.ok) throw new Error(path + ' -> ' + r.status);
        return r.text();
      }).then(function (t) { return toObjects(parseCSV(t)); }).catch(function () {
        return { header: [], rows: [] };
      }));
    }
    return cache.get(path);
  }

  /* ── formatting ──────────────────────────────────────────── */

  function fmt1(v) {
    if (v === null || v === undefined || v === '') return '';
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  function minutesToClock(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function colorFor(rideId) {
    var slot = state.slots[rideId];
    return slot === undefined ? 'var(--muted)' : 'var(' + SERIES_VARS[slot] + ')';
  }

  /* ── selection ───────────────────────────────────────────── */

  function toggleRide(id, on) {
    var i = state.selected.indexOf(id);
    if (on && i === -1) {
      if (state.selected.length >= MAX_SERIES) return false;
      // Claim the lowest free slot so removing one ride never repaints the rest.
      var used = {}, k;
      for (k in state.slots) used[state.slots[k]] = true;
      var slot = 0;
      while (used[slot]) slot++;
      state.slots[id] = slot;
      state.selected.push(id);
    } else if (!on && i !== -1) {
      state.selected.splice(i, 1);
      delete state.slots[id];
    }
    return true;
  }

  /* ── ride picker ─────────────────────────────────────────── */

  function renderRideList() {
    var host = el('ride-list');
    host.textContent = '';
    var q = state.search.trim().toLowerCase();
    var matches = state.rides.filter(function (r) {
      return !q || r.name.toLowerCase().indexOf(q) !== -1;
    });

    if (!matches.length) {
      var none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'No attraction matches that name.';
      host.appendChild(none);
    }

    var atCap = state.selected.length >= MAX_SERIES;
    var lastLand = null;
    matches.forEach(function (ride) {
      var land = ride.land || 'Other';
      if (land !== lastLand) {
        var h = document.createElement('div');
        h.className = 'land';
        h.textContent = land;
        host.appendChild(h);
        lastLand = land;
      }
      var id = String(ride.id);
      var checked = state.selected.indexOf(id) !== -1;

      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.disabled = !checked && atCap;
      box.addEventListener('change', function () {
        if (!toggleRide(id, box.checked)) { box.checked = false; return; }
        renderRideList();
        refresh();
      });
      label.appendChild(box);

      if (checked) {
        var sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = colorFor(id);
        label.appendChild(sw);
      }
      var name = document.createElement('span');
      name.textContent = ride.name;
      label.appendChild(name);
      host.appendChild(label);
    });

    el('ride-count').textContent = state.selected.length
      ? '(' + state.selected.length + ' of ' + MAX_SERIES + ' selected)'
      : '(none selected)';
  }

  /* ── explore computation ─────────────────────────────────── */

  function datesInRange() {
    return state.dates.filter(function (d) { return d >= state.from && d <= state.to; });
  }

  function computeExplore() {
    var dates = datesInRange();
    var selected = state.selected.slice();
    if (!dates.length || !selected.length) {
      state.explore = { domain: [], series: [], rows: [] };
      return Promise.resolve();
    }

    var wanted = {};
    selected.forEach(function (id) { wanted[id] = true; });
    var bucket = state.bucket;

    return Promise.all(dates.map(function (d) {
      return loadCSV('data/' + state.pathByDate[d]);
    })).then(function (files) {
      var cells = {};       // "date|minute|rideId" -> accumulator
      var domainKeys = {};  // "date|minute" -> true

      files.forEach(function (file) {
        file.rows.forEach(function (row) {
          if (!wanted[row.ride_id]) return;
          var t = row.time_local.split(':');
          var minute = Math.floor((+t[0] * 60 + +t[1]) / bucket) * bucket;
          var dkey = row.date_local + '|' + minute;
          domainKeys[dkey] = true;

          var key = dkey + '|' + row.ride_id;
          var acc = cells[key];
          if (!acc) {
            acc = cells[key] = {
              date: row.date_local, minute: minute,
              rideId: row.ride_id, rideName: row.ride_name,
              samples: 0, open: 0, sum: 0, max: null
            };
          }
          acc.samples++;
          if (row.is_open === 'true') {
            var w = +row.wait_time;
            acc.open++;
            acc.sum += w;
            if (acc.max === null || w > acc.max) acc.max = w;
          }
        });
      });

      var domain = Object.keys(domainKeys).map(function (k) {
        var p = k.split('|');
        return { date: p[0], minute: +p[1], key: k };
      }).sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : a.minute - b.minute;
      });

      var pos = {};
      domain.forEach(function (d, i) { pos[d.key] = i; });

      var nameOf = {};
      state.rides.forEach(function (r) { nameOf[String(r.id)] = r.name; });

      var series = selected.map(function (id) {
        return {
          rideId: id,
          name: nameOf[id] || id,
          color: colorFor(id),
          values: new Array(domain.length).fill(null)
        };
      });
      var seriesByRide = {};
      series.forEach(function (s) { seriesByRide[s.rideId] = s; });

      var rows = [];
      Object.keys(cells).forEach(function (key) {
        var acc = cells[key];
        var avg = acc.open ? acc.sum / acc.open : null;
        rows.push({
          date: acc.date,
          window: minutesToClock(acc.minute),
          rideId: acc.rideId,
          rideName: acc.rideName,
          avg: avg,
          max: acc.max,
          sum: acc.sum,
          open: acc.open,
          samples: acc.samples,
          pctOpen: acc.samples ? 100 * acc.open / acc.samples : 0
        });
        var s = seriesByRide[acc.rideId];
        if (s && avg !== null) s.values[pos[acc.date + '|' + acc.minute]] = avg;
      });

      rows.sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (a.window !== b.window) return a.window < b.window ? -1 : 1;
        return a.rideName.toLowerCase() < b.rideName.toLowerCase() ? -1 : 1;
      });

      state.explore = { domain: domain, series: series, rows: rows };
    });
  }

  /* ── stat tiles ──────────────────────────────────────────── */

  function renderTiles() {
    var host = el('tiles');
    host.textContent = '';
    var rows = state.explore.rows.filter(function (r) { return r.avg !== null; });
    if (!rows.length) return;

    var sumW = 0, n = 0, peak = rows[0], samples = 0, open = 0;
    state.explore.rows.forEach(function (r) {
      samples += r.samples;
      open += Math.round(r.samples * r.pctOpen / 100);
    });
    rows.forEach(function (r) {
      sumW += r.avg; n++;
      if (r.avg > peak.avg) peak = r;
    });

    var tiles = [
      { label: 'Average wait', value: fmt1(sumW / n), unit: 'min' },
      { label: 'Busiest window', value: peak.window, unit: fmt1(peak.avg) + ' min' },
      { label: 'Peak in a window', value: Math.max.apply(null, rows.map(function (r) { return r.max; })), unit: 'min' },
      { label: 'Time open', value: fmt1(100 * open / samples), unit: '%' }
    ];

    tiles.forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'tile';
      var l = document.createElement('div');
      l.className = 'label';
      l.textContent = t.label;
      var v = document.createElement('div');
      v.className = 'value';
      v.textContent = t.value;
      var u = document.createElement('span');
      u.className = 'unit';
      u.textContent = t.unit;
      v.appendChild(u);
      d.appendChild(l); d.appendChild(v);
      host.appendChild(d);
    });
  }

  /* ── chart ───────────────────────────────────────────────── */

  function niceScale(max) {
    if (!(max > 0)) return { step: 5, max: 10 };
    var raw = max / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { step: step, max: Math.ceil(max / step) * step };
  }

  function svgEl(name, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function renderLegend() {
    var host = el('legend');
    host.textContent = '';
    var series = state.explore.series;
    if (series.length < 2) return;  // one series is already named by the title
    series.forEach(function (s) {
      var item = document.createElement('span');
      item.className = 'item';
      var key = document.createElement('span');
      key.className = 'key';
      key.style.background = s.color;
      item.appendChild(key);
      item.appendChild(document.createTextNode(s.name));
      host.appendChild(item);
    });
  }

  function renderChart() {
    var host = el('chart-host');
    var tip = el('tooltip');
    tip.hidden = true;
    Array.prototype.slice.call(host.querySelectorAll('svg, .empty')).forEach(function (n) { n.remove(); });

    var domain = state.explore.domain;
    var series = state.explore.series;
    var hasData = series.some(function (s) {
      return s.values.some(function (v) { return v !== null; });
    });

    if (!domain.length || !hasData) {
      var msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent = state.selected.length
        ? 'No open-ride samples for this attraction in the selected range.'
        : 'Pick an attraction to see its wait times.';
      host.appendChild(msg);
      return;
    }

    var W = Math.max(320, host.clientWidth || 900);
    var H = 300;
    var labelEnds = series.length <= 4;
    var pad = { l: 46, r: labelEnds ? 108 : 18, t: 14, b: 30 };
    var innerW = W - pad.l - pad.r;
    var innerH = H - pad.t - pad.b;

    var maxVal = 0;
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v > maxVal) maxVal = v; });
    });
    var scale = niceScale(maxVal);
    var stepX = domain.length > 1 ? innerW / (domain.length - 1) : 0;
    var X = function (i) { return pad.l + i * stepX; };
    var Y = function (v) { return pad.t + innerH * (1 - v / scale.max); };

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      width: W, height: H,
      role: 'img',
      'aria-label': 'Average wait time by time of day'
    });

    // y gridlines + ticks
    for (var v = 0; v <= scale.max + 0.001; v += scale.step) {
      var y = Y(v);
      svg.appendChild(svgEl('line', {
        x1: pad.l, x2: W - pad.r, y1: y, y2: y,
        stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1
      }));
      var tick = svgEl('text', {
        x: pad.l - 8, y: y + 4, 'text-anchor': 'end',
        fill: 'var(--muted)', 'font-size': 11
      });
      tick.textContent = String(Math.round(v));
      svg.appendChild(tick);
    }
    // The unit lives in the card title rather than as a floating axis label,
    // which would collide with the topmost tick on short scales.

    // day separators + x ticks
    var multiDay = domain[0].date !== domain[domain.length - 1].date;
    for (var i = 1; i < domain.length; i++) {
      if (domain[i].date !== domain[i - 1].date) {
        var sx = X(i) - stepX / 2;
        svg.appendChild(svgEl('line', {
          x1: sx, x2: sx, y1: pad.t, y2: pad.t + innerH,
          stroke: 'var(--axis)', 'stroke-width': 1
        }));
      }
    }
    var every = Math.max(1, Math.ceil(domain.length / 8));
    for (var t = 0; t < domain.length; t += every) {
      var lbl = svgEl('text', {
        x: X(t), y: H - 10, 'text-anchor': 'middle',
        fill: 'var(--muted)', 'font-size': 11
      });
      lbl.textContent = multiDay
        ? domain[t].date.slice(5) + ' ' + minutesToClock(domain[t].minute)
        : minutesToClock(domain[t].minute);
      svg.appendChild(lbl);
    }

    // series paths
    series.forEach(function (s) {
      var d = '', pen = false, isolated = [];
      for (var i = 0; i < s.values.length; i++) {
        var val = s.values[i];
        if (val === null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(val).toFixed(1) + ' ';
        var alone = (i === 0 || s.values[i - 1] === null) &&
                    (i === s.values.length - 1 || s.values[i + 1] === null);
        if (alone) isolated.push(i);
        pen = true;
      }
      if (d) {
        svg.appendChild(svgEl('path', {
          d: d.trim(), fill: 'none', stroke: s.color,
          'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
        }));
      }
      isolated.forEach(function (i) {
        svg.appendChild(svgEl('circle', {
          cx: X(i), cy: Y(s.values[i]), r: 3.5, fill: s.color,
          stroke: 'var(--surface)', 'stroke-width': 2
        }));
      });
    });

    // direct end-labels, skipped where they would collide
    if (labelEnds) {
      var ends = [];
      series.forEach(function (s) {
        for (var i = s.values.length - 1; i >= 0; i--) {
          if (s.values[i] !== null) { ends.push({ s: s, i: i, y: Y(s.values[i]) }); break; }
        }
      });
      ends.sort(function (a, b) { return a.y - b.y; });
      var lastY = -Infinity;
      ends.forEach(function (e) {
        if (e.y - lastY < 14) return;   // leave it to the legend rather than stack labels
        lastY = e.y;
        svg.appendChild(svgEl('circle', {
          cx: X(e.i), cy: e.y, r: 4, fill: e.s.color,
          stroke: 'var(--surface)', 'stroke-width': 2
        }));
        var text = svgEl('text', {
          x: Math.min(X(e.i) + 10, W - pad.r + 8), y: e.y + 4,
          fill: 'var(--ink-2)', 'font-size': 11
        });
        text.textContent = e.s.name.length > 16 ? e.s.name.slice(0, 15) + '…' : e.s.name;
        svg.appendChild(text);
      });
    }

    // hover layer
    var crosshair = svgEl('line', {
      y1: pad.t, y2: pad.t + innerH, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0
    });
    svg.appendChild(crosshair);
    var dots = svgEl('g', { opacity: 0 });
    svg.appendChild(dots);

    var overlay = svgEl('rect', {
      x: pad.l, y: pad.t, width: Math.max(1, innerW), height: innerH,
      fill: 'transparent', style: 'cursor:crosshair'
    });
    svg.appendChild(overlay);

    function hideHover() {
      crosshair.setAttribute('opacity', 0);
      dots.setAttribute('opacity', 0);
      tip.hidden = true;
    }

    function showHover(ev) {
      var box = svg.getBoundingClientRect();
      var mx = (ev.clientX - box.left) * (W / box.width);
      var idx = stepX ? Math.round((mx - pad.l) / stepX) : 0;
      idx = Math.max(0, Math.min(domain.length - 1, idx));

      var hits = series.filter(function (s) { return s.values[idx] !== null; });
      if (!hits.length) { hideHover(); return; }

      crosshair.setAttribute('x1', X(idx));
      crosshair.setAttribute('x2', X(idx));
      crosshair.setAttribute('opacity', 1);

      dots.textContent = '';
      hits.forEach(function (s) {
        dots.appendChild(svgEl('circle', {
          cx: X(idx), cy: Y(s.values[idx]), r: 4.5, fill: s.color,
          stroke: 'var(--surface)', 'stroke-width': 2
        }));
      });
      dots.setAttribute('opacity', 1);

      tip.textContent = '';
      var head = document.createElement('div');
      head.className = 't-head';
      head.textContent = (multiDay ? domain[idx].date + ' ' : '') +
        minutesToClock(domain[idx].minute) + '–' +
        minutesToClock(domain[idx].minute + state.bucket);
      tip.appendChild(head);
      hits.forEach(function (s) {
        var row = document.createElement('div');
        row.className = 't-row';
        var key = document.createElement('span');
        key.className = 'key';
        key.style.background = s.color;
        var name = document.createElement('span');
        name.textContent = s.name;
        var val = document.createElement('span');
        val.className = 'val';
        val.textContent = fmt1(s.values[idx]) + ' min';
        row.appendChild(key); row.appendChild(name); row.appendChild(val);
        tip.appendChild(row);
      });

      tip.hidden = false;
      var px = X(idx) * (box.width / W);
      tip.style.left = Math.max(70, Math.min(box.width - 70, px)) + 'px';
      tip.style.top = (Y(Math.max.apply(null, hits.map(function (s) { return s.values[idx]; })) ) * (box.height / H)) + 'px';
    }

    overlay.addEventListener('mousemove', showHover);
    overlay.addEventListener('mouseleave', hideHover);
    host.insertBefore(svg, tip);
  }

  /* ── matrix model ────────────────────────────────────────

     Everything below the chart is a "block": a pivot table with labelled rows
     and columns and one number per intersection. The shape follows the filter:

       one day selected   -> rows = time window, columns = attraction
       several days       -> one block per attraction,
                             rows = time window, columns = weekday

     The same blocks feed the on-screen heatmap and the CSV export, so what you
     download is exactly what you are looking at.                            */

  var DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  var METRICS = {
    avg: { label: 'Average wait', unit: 'minutes', decimals: 1 },
    max: { label: 'Max wait', unit: 'minutes', decimals: 0 },
    open: { label: '% of time open', unit: '%', decimals: 1 }
  };

  function metricInfo() { return METRICS[state.metric] || METRICS.avg; }

  function fmtMetric(v) {
    if (v === null || v === undefined || v === '') return '';
    var d = metricInfo().decimals;
    return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
  }

  function weekdayIndex(dateStr) {
    // Parsed without a Z suffix, so this is a local-time midnight and the
    // weekday is the calendar one, not a UTC-shifted neighbour.
    return (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7;
  }

  function sortedUnique(values) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      if (!seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort();
  }

  function nameOfRide(id) {
    for (var i = 0; i < state.rides.length; i++) {
      if (String(state.rides[i].id) === String(id)) return state.rides[i].name;
    }
    return String(id);
  }

  /* Accumulators keep the raw parts so a cell can merge several samples
     exactly, rather than averaging pre-averaged numbers. */
  function addTo(bag, rowKey, colKey, row) {
    var r = bag[rowKey] || (bag[rowKey] = {});
    var a = r[colKey] || (r[colKey] = { sum: 0, open: 0, samples: 0, max: null });
    a.sum += row.sum;
    a.open += row.open;
    a.samples += row.samples;
    if (row.max !== null && (a.max === null || row.max > a.max)) a.max = row.max;
  }

  function accValue(a) {
    if (!a) return null;
    if (state.metric === 'max') return a.max;
    if (state.metric === 'open') return a.samples ? 100 * a.open / a.samples : null;
    return a.open ? a.sum / a.open : null;
  }

  function resolveAcc(bag) {
    var out = {};
    Object.keys(bag).forEach(function (rk) {
      out[rk] = {};
      Object.keys(bag[rk]).forEach(function (ck) {
        out[rk][ck] = accValue(bag[rk][ck]);
      });
    });
    return out;
  }

  function buildExploreBlocks() {
    var rows = state.explore.rows;
    if (!rows.length || !state.selected.length) return [];

    var dates = sortedUnique(rows.map(function (r) { return r.date; }));
    var windows = sortedUnique(rows.map(function (r) { return r.window; }))
      .map(function (w) { return { key: w, label: w }; });
    var unit = metricInfo().unit;

    if (dates.length === 1) {
      var cols = state.selected.map(function (id) {
        return { key: id, label: nameOfRide(id), color: colorFor(id) };
      });
      var bag = {};
      rows.forEach(function (r) { addTo(bag, r.window, r.rideId, r); });
      return [{
        title: '',
        subtitle: dates[0] + ' · ' + state.bucket + '-minute windows · ' +
                  metricInfo().label.toLowerCase() + ' in ' + unit,
        rowHeader: 'Window',
        rows: windows,
        cols: cols,
        values: resolveAcc(bag)
      }];
    }

    // Several days: one block per attraction, columns become weekdays.
    var present = {};
    rows.forEach(function (r) { present[weekdayIndex(r.date)] = true; });
    var dowCols = Object.keys(present).map(Number).sort(function (a, b) { return a - b; })
      .map(function (d) { return { key: String(d), label: DOW_NAMES[d] }; });

    var perRide = {};
    rows.forEach(function (r) {
      var bag = perRide[r.rideId] || (perRide[r.rideId] = {});
      addTo(bag, r.window, String(weekdayIndex(r.date)), r);
    });

    return state.selected.filter(function (id) { return perRide[id]; }).map(function (id) {
      return {
        title: nameOfRide(id),
        color: colorFor(id),
        subtitle: dates[0] + ' to ' + dates[dates.length - 1] + ' · ' + state.bucket +
                  '-minute windows · ' + metricInfo().label.toLowerCase() + ' in ' + unit +
                  ', averaged across each weekday',
        rowHeader: 'Window',
        rows: windows,
        cols: dowCols,
        values: resolveAcc(perRide[id])
      };
    });
  }

  /* Aggregate CSVs are already reduced, so their cells are read straight off
     the row rather than re-merged. */
  var AGG_FIELDS = {
    daily: { avg: 'avg_wait_open', max: 'max_wait', open: 'pct_open' },
    weekly: { avg: 'avg_wait_open', max: 'max_wait', open: 'avg_pct_open' },
    hourly_profile: { avg: 'avg_wait_open', max: 'max_wait', open: 'pct_open' }
  };

  function aggNumber(row) {
    var v = row[AGG_FIELDS[state.agg][state.metric]];
    return v === '' || v === undefined ? null : +v;
  }

  function rideColsFromRows(rows) {
    var seen = {}, out = [];
    rows.forEach(function (r) {
      if (!seen[r.ride_id]) {
        seen[r.ride_id] = true;
        out.push({ key: r.ride_id, label: r.ride_name, color: colorFor(r.ride_id) });
      }
    });
    if (state.selected.length) {
      out.sort(function (a, b) {
        return state.selected.indexOf(a.key) - state.selected.indexOf(b.key);
      });
    } else {
      out.sort(function (a, b) { return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1; });
    }
    return out;
  }

  function buildAggBlocks() {
    var rows = state.aggRows;
    if (!rows.length) return [];
    var unit = metricInfo().unit;
    var descr = metricInfo().label.toLowerCase() + ' in ' + unit;

    if (state.agg === 'hourly_profile') {
      var present = {};
      rows.forEach(function (r) { present[r.day_of_week] = true; });
      var dowCols = Object.keys(present).map(Number).sort(function (a, b) { return a - b; })
        .map(function (d) { return { key: String(d), label: DOW_NAMES[d] }; });

      var hours = sortedUnique(rows.map(function (r) { return +r.hour_local; }))
        .sort(function (a, b) { return a - b; })
        .map(function (h) { return { key: String(h), label: (h < 10 ? '0' : '') + h + ':00' }; });

      var perRide = {}, order = [];
      rows.forEach(function (r) {
        if (!perRide[r.ride_id]) { perRide[r.ride_id] = { name: r.ride_name, v: {} }; order.push(r.ride_id); }
        var v = perRide[r.ride_id].v;
        (v[r.hour_local] || (v[r.hour_local] = {}))[r.day_of_week] = aggNumber(r);
      });
      if (state.selected.length) {
        order.sort(function (a, b) { return state.selected.indexOf(a) - state.selected.indexOf(b); });
      }

      return order.map(function (id) {
        return {
          title: perRide[id].name,
          color: colorFor(id),
          subtitle: 'Typical hour over the trailing 90 days · ' + descr,
          rowHeader: 'Hour',
          rows: hours,
          cols: dowCols,
          values: perRide[id].v
        };
      });
    }

    var rowKey = state.agg === 'daily' ? 'date_local' : 'iso_year_week';
    var rowHeader = state.agg === 'daily' ? 'Date' : 'ISO week';
    var rowKeys = sortedUnique(rows.map(function (r) { return r[rowKey]; }))
      .map(function (k) { return { key: k, label: k }; });

    var values = {};
    rows.forEach(function (r) {
      (values[r[rowKey]] || (values[r[rowKey]] = {}))[r.ride_id] = aggNumber(r);
    });

    return [{
      title: '',
      subtitle: (state.agg === 'daily' ? 'One row per operating day' : 'One row per ISO week') +
                ' · ' + descr,
      rowHeader: rowHeader,
      rows: rowKeys,
      cols: rideColsFromRows(rows),
      values: values
    }];
  }

  /* ── heatmap rendering ───────────────────────────────────── */

  var HEAT_STEPS = 9;

  function heatIndex(value, max) {
    if (!(max > 0)) return 0;
    return Math.max(0, Math.min(HEAT_STEPS - 1, Math.floor(value / max * HEAT_STEPS)));
  }

  function blocksMax(blocks) {
    // One scale shared across every block, so a headliner and a kiddie ride
    // are actually comparable instead of both looking "hot".
    var max = 0;
    blocks.forEach(function (b) {
      b.rows.forEach(function (r) {
        var line = b.values[r.key] || {};
        b.cols.forEach(function (c) {
          var v = line[c.key];
          if (v !== null && v !== undefined && v > max) max = v;
        });
      });
    });
    return max;
  }

  function renderHeatLegend(host, max) {
    var wrap = document.createElement('div');
    wrap.className = 'heat-legend';
    var lo = document.createElement('span');
    lo.textContent = '0';
    var ramp = document.createElement('span');
    ramp.className = 'ramp';
    for (var i = 0; i < HEAT_STEPS; i++) {
      var step = document.createElement('span');
      step.style.background = 'var(--heat-' + i + ')';
      ramp.appendChild(step);
    }
    var hi = document.createElement('span');
    hi.textContent = fmtMetric(max) + ' ' + metricInfo().unit;
    wrap.appendChild(lo);
    wrap.appendChild(ramp);
    wrap.appendChild(hi);
    host.appendChild(wrap);
  }

  function renderBlocks(host, blocks, emptyMessage) {
    host.textContent = '';
    if (!blocks.length) {
      var msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent = emptyMessage;
      host.appendChild(msg);
      return;
    }

    var max = blocksMax(blocks);

    blocks.forEach(function (block) {
      var wrap = document.createElement('div');
      wrap.className = 'matrix-block';

      if (block.title) {
        var h = document.createElement('p');
        h.className = 'matrix-title';
        if (block.color) {
          var sw = document.createElement('span');
          sw.className = 'swatch';
          sw.style.background = block.color;
          h.appendChild(sw);
        }
        h.appendChild(document.createTextNode(block.title));
        wrap.appendChild(h);
      }
      if (block.subtitle) {
        var sub = document.createElement('p');
        sub.className = 'matrix-sub';
        sub.textContent = block.subtitle;
        wrap.appendChild(sub);
      }

      var scroller = document.createElement('div');
      scroller.className = 'matrix-host';
      var table = document.createElement('table');
      table.className = 'matrix';

      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      var corner = document.createElement('th');
      corner.textContent = block.rowHeader;
      htr.appendChild(corner);
      block.cols.forEach(function (c) {
        var th = document.createElement('th');
        th.textContent = c.label;
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      block.rows.forEach(function (r) {
        var tr = document.createElement('tr');
        var rh = document.createElement('th');
        rh.setAttribute('scope', 'row');
        rh.textContent = r.label;
        tr.appendChild(rh);

        var line = block.values[r.key] || {};
        block.cols.forEach(function (c) {
          var td = document.createElement('td');
          var v = line[c.key];
          if (v === null || v === undefined) {
            td.className = 'empty-cell';
            td.textContent = '–';
            td.title = 'no data';
          } else {
            var i = heatIndex(v, max);
            td.className = 'cell';
            td.style.background = 'var(--heat-' + i + ')';
            td.style.color = 'var(--heat-ink-' + i + ')';
            td.textContent = fmtMetric(v);
            td.title = c.label + ' · ' + r.label + ' · ' + fmtMetric(v) + ' ' + metricInfo().unit;
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroller.appendChild(table);
      wrap.appendChild(scroller);
      host.appendChild(wrap);
    });

    if (max > 0) renderHeatLegend(host, max);
  }

  /* ── download ────────────────────────────────────────────── */

  function csvEscape(value, delim) {
    var s = value === null || value === undefined ? '' : String(value);
    if (s.indexOf(delim) !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function download(filename, rows) {
    var delim = state.delimiter;
    var decimalComma = delim === ';';
    var lines = [];
    if (decimalComma) lines.push('sep=' + delim);

    rows.forEach(function (cells) {
      lines.push(cells.map(function (c) {
        var s = c === null || c === undefined ? '' : String(c);
        if (decimalComma && /^-?\d+\.\d+$/.test(s)) s = s.replace('.', ',');
        return csvEscape(s, delim);
      }).join(delim));
    });

    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* Blocks become stacked tables separated by a blank line -- the layout you
     would build by hand in a spreadsheet. */
  function blocksToRows(blocks, heading) {
    var out = [[heading]];
    blocks.forEach(function (block) {
      out.push([]);
      if (block.title) out.push([block.title]);
      if (block.subtitle) out.push([block.subtitle]);
      out.push([block.rowHeader].concat(block.cols.map(function (c) { return c.label; })));
      block.rows.forEach(function (r) {
        var line = block.values[r.key] || {};
        out.push([r.label].concat(block.cols.map(function (c) {
          var v = line[c.key];
          return v === null || v === undefined ? '' : fmtMetric(v);
        })));
      });
    });
    return out;
  }

  function downloadExplore() {
    var blocks = buildExploreBlocks();
    if (!blocks.length) return;
    var dates = sortedUnique(state.explore.rows.map(function (r) { return r.date; }));
    var when = dates.length === 1 ? dates[0] : dates[0] + '_to_' + dates[dates.length - 1];
    var who = state.selected.length === 1 ? slug(nameOfRide(state.selected[0]))
                                          : state.selected.length + '-attractions';
    var heading = 'Six Flags Great Adventure · ' + metricInfo().label + ' (' + metricInfo().unit + ')';
    download('great-adventure_' + who + '_' + when + '_' + state.bucket + 'min.csv',
             blocksToRows(blocks, heading));
  }

  function downloadAgg() {
    var blocks = buildAggBlocks();
    if (!blocks.length) return;
    var heading = 'Six Flags Great Adventure · ' + AGG_META[state.agg].title + ' · ' +
                  metricInfo().label + ' (' + metricInfo().unit + ')';
    download('great-adventure_' + state.agg.replace(/_/g, '-') + '.csv',
             blocksToRows(blocks, heading));
  }

  /* ── panel refresh ───────────────────────────────────────── */

  function renderExploreMatrix() {
    var blocks = buildExploreBlocks();
    var cells = blocks.reduce(function (n, b) { return n + b.rows.length * b.cols.length; }, 0);
    el('download-explore').disabled = !blocks.length;
    el('table-count').textContent = blocks.length
      ? '(' + blocks.length + (blocks.length === 1 ? ' table, ' : ' tables, ') + cells + ' cells)'
      : '';
    el('explore-shape').textContent = blocks.length
      ? (blocks.length === 1
          ? 'One day selected: rows are time windows, columns are the attractions you picked.'
          : 'Several days selected: one table per attraction, columns are weekdays averaged across the range.')
      : '';
    renderBlocks(el('matrix-explore'), blocks,
      'Nothing to show yet. Pick an attraction and a date that has data.');
  }

  function renderAggMatrix() {
    var meta = AGG_META[state.agg];
    el('agg-title').childNodes[0].nodeValue = meta.title + ' ';
    el('agg-note').textContent = meta.note;

    var blocks = buildAggBlocks();
    var cells = blocks.reduce(function (n, b) { return n + b.rows.length * b.cols.length; }, 0);
    el('download-agg').disabled = !blocks.length;
    el('agg-count').textContent = blocks.length ? '(' + cells + ' cells)' : '';
    renderBlocks(el('matrix-agg'), blocks,
      'No aggregate rows yet — they appear once a full day has been collected.');
  }

  /* ── aggregates ──────────────────────────────────────────── */

  function refreshAgg() {
    var meta = AGG_META[state.agg];
    return loadCSV('data/agg/' + meta.file).then(function (data) {
      var rows = data.rows;
      if (state.selected.length) {
        var wanted = {};
        state.selected.forEach(function (id) { wanted[id] = true; });
        rows = rows.filter(function (r) { return wanted[r.ride_id]; });
      }
      if (state.agg === 'daily') {
        rows = rows.filter(function (r) {
          return r.date_local >= state.from && r.date_local <= state.to;
        });
      }
      state.aggRows = rows;
      renderAggMatrix();
    });
  }

  /* ── orchestration ───────────────────────────────────────── */

  function refresh() {
    if (state.tab === 'aggregates') return refreshAgg();
    return computeExplore().then(function () {
      renderTiles();
      renderLegend();
      renderChart();
      renderExploreMatrix();
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    el('panel-explore').hidden = tab !== 'explore';
    el('panel-aggregates').hidden = tab !== 'aggregates';
    refresh();
  }

  function wireControls() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.subtab'), function (b) {
      b.addEventListener('click', function () {
        state.agg = b.dataset.agg;
        Array.prototype.forEach.call(document.querySelectorAll('.subtab'), function (o) {
          o.classList.toggle('is-active', o === b);
        });
        refreshAgg();
      });
    });

    el('ride-search').addEventListener('input', function (e) {
      state.search = e.target.value;
      renderRideList();
    });
    el('ride-clear').addEventListener('click', function () {
      state.selected = [];
      state.slots = {};
      renderRideList();
      refresh();
    });
    el('date-from').addEventListener('change', function (e) {
      state.from = e.target.value;
      if (state.to < state.from) { state.to = state.from; el('date-to').value = state.to; }
      refresh();
    });
    el('date-to').addEventListener('change', function (e) {
      state.to = e.target.value;
      if (state.to < state.from) { state.from = state.to; el('date-from').value = state.from; }
      refresh();
    });
    el('bucket').addEventListener('change', function (e) {
      state.bucket = +e.target.value;
      refresh();
    });
    el('metric').addEventListener('change', function (e) {
      state.metric = e.target.value;
      refresh();
    });
    el('delimiter').addEventListener('change', function (e) {
      state.delimiter = e.target.value;
    });
    el('download-explore').addEventListener('click', downloadExplore);
    el('download-agg').addEventListener('click', downloadAgg);

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.tab === 'explore') renderChart();
      }, 150);
    });
  }

  /* Preselect whichever attraction had the longest queue on the latest day,
     so the page lands on something worth looking at. */
  function pickDefaultRide(latestDate) {
    return loadCSV('data/' + state.pathByDate[latestDate]).then(function (file) {
      var best = null, totals = {};
      file.rows.forEach(function (row) {
        if (row.is_open !== 'true') return;
        var acc = totals[row.ride_id] || (totals[row.ride_id] = { sum: 0, n: 0 });
        acc.sum += +row.wait_time;
        acc.n++;
      });
      Object.keys(totals).forEach(function (id) {
        var avg = totals[id].sum / totals[id].n;
        if (!best || avg > best.avg) best = { id: id, avg: avg };
      });
      if (best) toggleRide(best.id, true);
      else if (state.rides.length) toggleRide(String(state.rides[0].id), true);
    });
  }

  function boot() {
    fetch('data/index.json').then(function (r) {
      if (!r.ok) throw new Error('index.json ' + r.status);
      return r.json();
    }).then(function (manifest) {
      state.rides = manifest.rides || [];
      state.rides.sort(function (a, b) {
        var la = a.land || 'Other', lb = b.land || 'Other';
        if (la !== lb) return la < lb ? -1 : 1;
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });

      (manifest.dates || []).forEach(function (d) {
        state.dates.push(d.date);
        state.pathByDate[d.date] = d.path;
      });
      state.dates.sort();

      var meta = el('head-meta');
      if (state.dates.length) {
        meta.textContent = state.dates.length + ' day(s) collected · ' +
          state.dates[0] + ' to ' + state.dates[state.dates.length - 1];
      } else {
        meta.textContent = 'No data collected yet';
      }

      if (!state.dates.length) {
        el('boot').textContent = 'No data has been collected yet. Once the collector workflow has run, days will appear here.';
        return;
      }

      var latest = state.dates[state.dates.length - 1];
      state.from = latest;
      state.to = latest;
      var fromInput = el('date-from'), toInput = el('date-to');
      fromInput.min = toInput.min = state.dates[0];
      fromInput.max = toInput.max = latest;
      fromInput.value = state.from;
      toInput.value = state.to;

      wireControls();

      return pickDefaultRide(latest).then(function () {
        renderRideList();
        el('boot').hidden = true;
        el('app').hidden = false;
        return refresh();
      });
    }).catch(function (err) {
      el('boot').textContent = 'Could not load data/index.json (' + err.message + '). ' +
        'If you are opening this file directly, serve the folder over HTTP instead.';
    });
  }

  boot();
})();

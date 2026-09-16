#!/usr/bin/env node
// Build schedule.json from the St Albans council PDFs.
// - Scrapes rubbish-collections page for current PDF URLs (both weeks)
// - Extracts per-week collection type by matching each date text with the coloured cell containing it
// - Emits schedule.json

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RUBBISH_URL = 'https://www.stalbans.gov.uk/rubbish-collections';
const UA = 'Mozilla/5.0 (compatible; st-allbins-bot; +https://github.com)';

const COLORS = {
  '115,62,5': 'refuse',      // brown  – general waste + food
  '49,173,120': 'recycling', // green  – recycling + garden + food
  '255,154,58': 'bank-holiday', // orange – shifted one day, type unchanged
  '192,75,165': 'festive',   // purple – delayed collections around Christmas
};

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

async function fetchPdfUrls() {
  const html = await (await fetch(RUBBISH_URL, { headers: { 'User-Agent': UA } })).text();
  const matches = [...html.matchAll(/href="([^"]+Collection[^"]*Week[^"]*\.pdf)"/gi)].map(m => m[1]);
  const abs = matches.map(u => u.startsWith('http') ? u : new URL(u, RUBBISH_URL).toString());
  const week1 = abs.find(u => /Week\s*1\b/i.test(decodeURIComponent(u)));
  const week2 = abs.find(u => /Week\s*2\b/i.test(decodeURIComponent(u)));
  if (!week1 || !week2) throw new Error(`Could not find both PDFs on ${RUBBISH_URL}. Found: ${abs.join(', ')}`);
  return { week1, week2 };
}

async function extractPage(pdfBuf) {
  const doc = await getDocument({ data: new Uint8Array(pdfBuf), disableFontFace: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  const ops = await page.getOperatorList();

  // Rects (with colours) from ops
  const rects = [];
  let color = null;
  let pending = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.setFillRGBColor) {
      color = args.slice(0, 3).map(v => Math.round(v)).join(',');
    } else if (fn === OPS.constructPath) {
      const subOps = args[0];
      const subArgs = args[1];
      let k = 0;
      for (const sop of subOps) {
        if (sop === OPS.rectangle) {
          const [x, y, w, h] = subArgs.slice(k, k + 4);
          // Normalise (h can be negative)
          const nx = w < 0 ? x + w : x;
          const ny = h < 0 ? y + h : y;
          const nw = Math.abs(w);
          const nh = Math.abs(h);
          k += 4;
          pending.push({ x: nx, y: ny, w: nw, h: nh });
        } else {
          k += 2;
        }
      }
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
      for (const r of pending) rects.push({ ...r, color });
      pending = [];
    } else if (fn === OPS.stroke || fn === OPS.closeStroke) {
      pending = [];
    }
  }

  // Filter to day-cell sized (~24 wide, 13-20 tall)
  const cells = rects.filter(r => r.w >= 20 && r.w <= 30 && r.h >= 10 && r.h <= 22 && COLORS[r.color]);

  // Text items with position; PDF y is up. Baseline y is transform[5].
  const items = text.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0, h: i.height || 0 }));

  // Identify month headings. In this calendar the month text is a single string like "April 2026" or "May" etc.
  // Extract year context from "April 2026" and "January 2027".
  const monthItems = [];
  for (const it of items) {
    const m = /^(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?$/.exec(it.s);
    if (m) monthItems.push({ month: MONTHS[m[1].toLowerCase()], year: m[2] ? Number(m[2]) : null, x: it.x, y: it.y });
  }
  // Council schedule year: April Y → March Y+1. Extract Y from any "<Month> <YYYY>" heading; assign year per month accordingly.
  const anchored = monthItems.find(m => m.year != null);
  if (!anchored) throw new Error('No anchored year found in month headings');
  const baseYear = anchored.month >= 3 ? anchored.year : anchored.year - 1; // April(3) uses baseYear
  for (const m of monthItems) {
    if (m.year == null) m.year = m.month >= 3 ? baseYear : baseYear + 1;
  }

  // Day-number text items (1..31)
  const dayItems = items.filter(i => /^\d{1,2}$/.test(i.s) && Number(i.s) >= 1 && Number(i.s) <= 31);

  // Assign each day to its month grid: find the closest month heading that is ABOVE (larger y) and horizontally overlapping the day's column region.
  // Instead: build clusters of dates that share x-range and y-range with a month heading.
  // For each day, pick month heading with smallest (headingY - dayY) where headingY > dayY and |headingX - dayX| < 100.
  function findMonth(day) {
    let best = null, bestDy = Infinity;
    for (const m of monthItems) {
      const dy = m.y - day.y;
      if (dy <= 0 || dy > 200) continue;
      if (Math.abs(m.x - day.x) > 120) continue;
      if (dy < bestDy) { best = m; bestDy = dy; }
    }
    return best;
  }

  // For each day, find the cell rect that contains it (day text sits inside coloured cell).
  function findCell(day) {
    for (const r of cells) {
      if (day.x >= r.x && day.x <= r.x + r.w && day.y >= r.y && day.y <= r.y + r.h) return r;
    }
    // Sometimes the text is placed just above the cell centre; try widening on y a bit
    for (const r of cells) {
      if (day.x >= r.x && day.x <= r.x + r.w && day.y >= r.y - 2 && day.y <= r.y + r.h + 6) return r;
    }
    return null;
  }

  const collections = {}; // ISO date -> category
  for (const d of dayItems) {
    const m = findMonth(d);
    if (!m || m.year == null) continue;
    const cell = findCell(d);
    if (!cell) continue;
    const category = COLORS[cell.color];
    if (!category) continue;
    const iso = `${m.year}-${String(m.month + 1).padStart(2, '0')}-${String(Number(d.s)).padStart(2, '0')}`;
    // If duplicate day numbers accidentally match multiple grids (shouldn't happen with our x-filter), prefer the closer month.
    if (!collections[iso]) collections[iso] = category;
  }
  return collections;
}

// Collapse per-date map into per-week records (Mon..Sun blocks) with dominant type.
function collapseToWeeks(week1Map, week2Map) {
  const allDates = new Set([...Object.keys(week1Map), ...Object.keys(week2Map)]);
  const dates = [...allDates].sort();
  if (!dates.length) return [];
  // Find Monday of the earliest date
  const first = new Date(dates[0] + 'T00:00:00Z');
  const dow = (first.getUTCDay() + 6) % 7; // 0=Mon
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - dow);
  const last = new Date(dates[dates.length - 1] + 'T00:00:00Z');

  const iso = d => d.toISOString().slice(0, 10);
  const dominant = (map, weekStart) => {
    const counts = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(weekStart.getUTCDate() + i);
      const cat = map[iso(d)];
      if (!cat) continue;
      // Bank-holiday / festive keep the underlying type from adjacent days; treat as neutral
      if (cat === 'bank-holiday' || cat === 'festive') continue;
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0] || null;
  };

  const weeks = [];
  for (let d = new Date(start); d <= last; d.setUTCDate(d.getUTCDate() + 7)) {
    weeks.push({
      start: iso(d),
      week1: dominant(week1Map, d),
      week2: dominant(week2Map, d),
    });
  }
  return weeks;
}

async function main() {
  const args = process.argv.slice(2);
  let week1Buf, week2Buf, sourceUrls;
  if (args[0] === '--local') {
    week1Buf = await readFile(args[1]);
    week2Buf = await readFile(args[2]);
    sourceUrls = [args[1], args[2]];
  } else {
    const urls = await fetchPdfUrls();
    console.error('PDFs:', urls);
    sourceUrls = [urls.week1, urls.week2];
    [week1Buf, week2Buf] = await Promise.all([
      fetch(urls.week1, { headers: { 'User-Agent': UA } }).then(r => r.arrayBuffer()),
      fetch(urls.week2, { headers: { 'User-Agent': UA } }).then(r => r.arrayBuffer()),
    ]);
  }
  const week1Map = await extractPage(week1Buf);
  const week2Map = await extractPage(week2Buf);
  const weeks = collapseToWeeks(week1Map, week2Map);
  // Sanity checks
  const missing = weeks.filter(w => !w.week1 || !w.week2);
  if (missing.length > 4) throw new Error(`Too many weeks missing data (${missing.length}): schedule parse likely broken`);
  // Determine schedule year from the first week (April Y … March Y+1)
  const startYear = Number(weeks[0].start.slice(0, 4));
  // Council rule: no garden waste collections for two weeks from 25 December; service restarts around 11 January.
  const gardenBreak = { start: `${startYear}-12-25`, end: `${startYear + 1}-01-10` };
  const out = {
    generated: new Date().toISOString(),
    sourceUrls,
    scheduleYear: `${startYear}-${startYear + 1}`,
    gardenBreak,
    weeks,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'schedule.json');
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n');
  console.error(`Wrote ${outPath}: ${weeks.length} weeks`);
}

main().catch(e => { console.error(e); process.exit(1); });

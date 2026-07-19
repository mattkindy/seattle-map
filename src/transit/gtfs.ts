// GTFS timetable loader. Parses the fetched feeds (data/gtfs/*.zip)
// into the compact structures RAPTOR wants: stops with coordinates,
// trip patterns (a route's distinct stop sequences), and per-pattern
// trips sorted by departure. Feeds merge under id prefixes so King
// County Metro and Sound Transit coexist.
//
// GTFS quirks handled here: quoted CSV fields, times past midnight
// ("25:30:00" is 1:30 am on the service day), and service calendars
// with per-date exceptions.

import fs from "node:fs";
import path from "node:path";

import { ZipReader } from "../lib/zip.ts";

export interface Pattern {
  /** Stop indexes along the pattern. */
  stops: Int32Array;
  /** trips x stops, flattened: arrival seconds at each stop. */
  arr: Int32Array;
  /** trips x stops, flattened: departure seconds at each stop. */
  dep: Int32Array;
  tripCount: number;
}

export interface Timetable {
  stopIds: string[];
  stopName: string[];
  stopLat: Float64Array;
  stopLng: Float64Array;
  patterns: Pattern[];
  /** stop index -> indexes of patterns serving it. */
  patternsAtStop: number[][];
  /** stop index -> [toStop, walkSeconds] foot transfers. */
  transfers: Array<Array<[number, number]>>;
}

function parseCsv(buf: Buffer): { header: string[]; lines: string[] } {
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const header = splitLine(lines[0] ?? "");
  return { header, lines: lines.slice(1) };
}

function splitLine(line: string): string[] {
  if (!line.includes('"')) {
    return line.split(",");
  }
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function timeToSec(t: string): number {
  const [h, m, s] = t.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s || 0);
}

/** Service ids active on a YYYYMMDD date, from calendar + exceptions. */
function activeServices(zip: ZipReader, date: string): Set<string> {
  const active = new Set<string>();
  const dow = new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
  ).getDay();
  const dayCols = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday",
  ];
  if (zip.entries.has("calendar.txt")) {
    const { header, lines } = parseCsv(zip.read("calendar.txt"));
    const col = (name: string) => header.indexOf(name);
    for (const line of lines) {
      const f = splitLine(line);
      if (f.length < 2) continue;
      if (
        f[col("start_date")] <= date &&
        date <= f[col("end_date")] &&
        f[col(dayCols[dow])] === "1"
      ) {
        active.add(f[col("service_id")]);
      }
    }
  }
  if (zip.entries.has("calendar_dates.txt")) {
    const { header, lines } = parseCsv(zip.read("calendar_dates.txt"));
    const col = (name: string) => header.indexOf(name);
    for (const line of lines) {
      const f = splitLine(line);
      if (f.length < 3 || f[col("date")] !== date) continue;
      if (f[col("exception_type")] === "1") {
        active.add(f[col("service_id")]);
      } else {
        active.delete(f[col("service_id")]);
      }
    }
  }
  return active;
}

interface RawFeed {
  prefix: string;
  zip: ZipReader;
}

export interface LoadOptions {
  /** Service date, YYYYMMDD. */
  date: string;
  /** Only stops inside this box (plus their patterns) are kept. */
  bounds: { north: number; south: number; east: number; west: number };
}

export function loadTimetable(gtfsDir: string, opts: LoadOptions): Timetable {
  const feeds: RawFeed[] = fs
    .readdirSync(gtfsDir)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => ({
      prefix: f.replace(/\.zip$/, "") + ":",
      zip: new ZipReader(fs.readFileSync(path.join(gtfsDir, f))),
    }));

  const stopIds: string[] = [];
  const stopName: string[] = [];
  const lat: number[] = [];
  const lng: number[] = [];
  const stopIdx = new Map<string, number>();
  const patterns: Pattern[] = [];
  const transfersRaw: Array<[number, number, number]> = [];

  // Stops beyond the map area still matter when a trip passes through
  // them, so keep every stop and filter at access time instead. The
  // pad keeps park-and-rides just outside the frame usable.
  const pad = 0.05;
  const b = opts.bounds;
  const inArea = (la: number, lo: number) =>
    la > b.south - pad && la < b.north + pad && lo > b.west - pad && lo < b.east + pad;

  for (const feed of feeds) {
    const { zip, prefix } = feed;
    // stops
    {
      const { header, lines } = parseCsv(zip.read("stops.txt"));
      const col = (n: string) => header.indexOf(n);
      for (const line of lines) {
        const f = splitLine(line);
        if (f.length < 3) continue;
        const id = prefix + f[col("stop_id")];
        stopIdx.set(id, stopIds.length);
        stopIds.push(id);
        stopName.push(f[col("stop_name")] ?? "");
        lat.push(Number(f[col("stop_lat")]));
        lng.push(Number(f[col("stop_lon")]));
      }
    }
    // trips on the service date
    const services = activeServices(zip, opts.date);
    const tripService = new Map<string, boolean>();
    {
      const { header, lines } = parseCsv(zip.read("trips.txt"));
      const col = (n: string) => header.indexOf(n);
      for (const line of lines) {
        const f = splitLine(line);
        if (f.length < 3) continue;
        tripService.set(
          f[col("trip_id")],
          services.has(f[col("service_id")]),
        );
      }
    }
    // stop_times -> per-trip sequences (only active trips)
    const tripStops = new Map<string, Array<[number, number, number, number]>>();
    {
      const { header, lines } = parseCsv(zip.read("stop_times.txt"));
      const col = (n: string) => header.indexOf(n);
      const cTrip = col("trip_id");
      const cArr = col("arrival_time");
      const cDep = col("departure_time");
      const cStop = col("stop_id");
      const cSeq = col("stop_sequence");
      for (const line of lines) {
        const f = splitLine(line);
        if (f.length < 5) continue;
        const tripId = f[cTrip];
        if (!tripService.get(tripId)) continue;
        const si = stopIdx.get(prefix + f[cStop]);
        if (si === undefined || !f[cArr]) continue;
        let list = tripStops.get(tripId);
        if (!list) {
          tripStops.set(tripId, (list = []));
        }
        list.push([Number(f[cSeq]), si, timeToSec(f[cArr]), timeToSec(f[cDep])]);
      }
    }
    // group trips into patterns by stop sequence
    const byPattern = new Map<string, Array<{ arr: number[]; dep: number[] }>>();
    const patternStops = new Map<string, number[]>();
    for (const seq of tripStops.values()) {
      seq.sort((p, q) => p[0] - q[0]);
      const stops = seq.map((s) => s[1]);
      if (stops.length < 2 || !stops.some((s) => inArea(lat[s], lng[s]))) {
        continue;
      }
      const key = stops.join(",");
      let list = byPattern.get(key);
      if (!list) {
        byPattern.set(key, (list = []));
        patternStops.set(key, stops);
      }
      list.push({ arr: seq.map((s) => s[2]), dep: seq.map((s) => s[3]) });
    }
    for (const [key, trips] of byPattern) {
      const stops = Int32Array.from(patternStops.get(key) as number[]);
      trips.sort((p, q) => p.dep[0] - q.dep[0]);
      const n = stops.length;
      const arr = new Int32Array(trips.length * n);
      const dep = new Int32Array(trips.length * n);
      trips.forEach((t, ti) => {
        for (let s = 0; s < n; s++) {
          arr[ti * n + s] = t.arr[s];
          dep[ti * n + s] = t.dep[s];
        }
      });
      patterns.push({ stops, arr, dep, tripCount: trips.length });
    }
    // declared transfers
    if (zip.entries.has("transfers.txt")) {
      const { header, lines } = parseCsv(zip.read("transfers.txt"));
      const col = (n: string) => header.indexOf(n);
      for (const line of lines) {
        const f = splitLine(line);
        if (f.length < 2) continue;
        const a = stopIdx.get(prefix + f[col("from_stop_id")]);
        const c = stopIdx.get(prefix + f[col("to_stop_id")]);
        if (a === undefined || c === undefined) continue;
        const t = Number(f[col("min_transfer_time")] || 120);
        transfersRaw.push([a, c, Math.max(t, 30)]);
      }
    }
  }

  // proximity transfers: stops within 200 m walk of each other
  const kmLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
  const cell = 0.003;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < stopIds.length; i++) {
    const key = `${Math.floor(lat[i] / cell)},${Math.floor(lng[i] / cell)}`;
    let bkt = grid.get(key);
    if (!bkt) grid.set(key, (bkt = []));
    bkt.push(i);
  }
  for (let i = 0; i < stopIds.length; i++) {
    const ci = Math.floor(lat[i] / cell);
    const cj = Math.floor(lng[i] / cell);
    for (let a = ci - 1; a <= ci + 1; a++) {
      for (let c = cj - 1; c <= cj + 1; c++) {
        for (const j of grid.get(`${a},${c}`) ?? []) {
          if (j <= i) continue;
          const m = Math.hypot(
            (lat[i] - lat[j]) * 111320,
            (lng[i] - lng[j]) * kmLng * 1000,
          );
          if (m <= 200) {
            const sec = Math.max(30, Math.round((m * 1.3) / 1.35));
            transfersRaw.push([i, j, sec]);
            transfersRaw.push([j, i, sec]);
          }
        }
      }
    }
  }

  const patternsAtStop: number[][] = stopIds.map(() => []);
  patterns.forEach((p, pi) => {
    const seen = new Set<number>();
    for (const s of p.stops) {
      if (!seen.has(s)) {
        seen.add(s);
        patternsAtStop[s].push(pi);
      }
    }
  });
  const transfers: Array<Array<[number, number]>> = stopIds.map(() => []);
  for (const [a, c, t] of transfersRaw) {
    transfers[a].push([c, t]);
  }

  return {
    stopIds,
    stopName,
    stopLat: Float64Array.from(lat),
    stopLng: Float64Array.from(lng),
    patterns,
    patternsAtStop,
    transfers,
  };
}

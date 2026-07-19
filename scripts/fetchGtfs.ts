// fetchGtfs.ts: download the GTFS feeds for transit routing into
// data/gtfs/. King County Metro carries the buses; Sound Transit
// carries Link light rail and Sounder. Cached: pass --force to
// refresh. Prints per-feed statistics as a load check.
//
// See TRANSIT.md for the design this feeds.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ZipReader } from "../src/lib/zip.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gtfsDir = path.join(root, "data", "gtfs");

interface Feed {
  id: string;
  label: string;
  urls: string[];
}

const FEEDS: Feed[] = [
  {
    id: "kcm",
    label: "King County Metro",
    urls: [
      "https://metro.kingcounty.gov/GTFS/google_transit.zip",
      "https://gtfs.sound.obaweb.org/prod/1_gtfs.zip",
    ],
  },
  {
    id: "st",
    label: "Sound Transit",
    urls: ["https://gtfs.sound.obaweb.org/prod/40_gtfs.zip"],
  },
];

async function download(feed: Feed): Promise<Buffer> {
  let lastErr: unknown;
  for (const url of feed.urls) {
    try {
      process.stderr.write(`gtfs: ${feed.id} from ${new URL(url).host} …\n`);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`http ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      process.stderr.write(`  failed: ${(err as Error).message}\n`);
    }
  }
  throw lastErr;
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) {
      n++;
    }
  }
  return n; // header included; close enough for a stat line
}

export async function main({ force = false } = {}): Promise<void> {
  fs.mkdirSync(gtfsDir, { recursive: true });
  for (const feed of FEEDS) {
    const file = path.join(gtfsDir, `${feed.id}.zip`);
    if (fs.existsSync(file) && !force) {
      console.log(`gtfs: ${feed.id}.zip already present (use --force to refresh)`);
    } else {
      const buf = await download(feed);
      fs.writeFileSync(file, buf);
    }
    const zip = new ZipReader(fs.readFileSync(file));
    const stat = (name: string) => {
      const entry = zip.entries.get(name);
      return entry ? countLines(zip.read(name)) - 1 : 0;
    };
    console.log(
      `gtfs: ${feed.label}: ${stat("stops.txt")} stops, ` +
        `${stat("routes.txt")} routes, ${stat("trips.txt")} trips, ` +
        `${stat("stop_times.txt")} stop times` +
        (zip.entries.has("transfers.txt") ? `, ${stat("transfers.txt")} transfers` : ""),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({ force: process.argv.includes("--force") });
}

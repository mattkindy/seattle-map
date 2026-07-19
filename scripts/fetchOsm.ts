// fetchOsm.ts: download the drivable road network for the grid's
// bounding box from OpenStreetMap (Overpass API) into data/osm.json.
// Cached: skips the download if the file already exists. Pass --force
// (or force: true) to refresh.
//
// Only road classes a car uses are requested, which keeps the response
// to something one query can return. Service roads, paths, and tracks
// are excluded on purpose. `out qt` (not `out skel`) so way tags,
// maxspeed above all, survive the download.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Grid } from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DRIVABLE =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|" +
  "living_street|motorway_link|trunk_link|primary_link|secondary_link|" +
  "tertiary_link";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function fetchOsm(query: string): Promise<{ elements: unknown[] }> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      process.stderr.write(`osm: querying ${new URL(url).host} …\n`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        throw new Error(`http ${res.status}`);
      }
      const json = JSON.parse(await res.text()) as { elements?: unknown[] };
      if (!json.elements || json.elements.length === 0) {
        throw new Error("empty response");
      }
      return json as { elements: unknown[] };
    } catch (err) {
      lastErr = err;
      process.stderr.write(`  failed: ${(err as Error).message}\n`);
    }
  }
  throw lastErr;
}

export async function main({ force = false } = {}): Promise<void> {
  const out = path.join(root, "data", "osm.json");
  if (fs.existsSync(out) && !force) {
    console.log("osm: data/osm.json already present (use --force to refresh)");
    return;
  }
  const grid = JSON.parse(
    fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
  ) as Grid;
  const b = grid.bounds;
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const query = `[out:json][timeout:240];
way["highway"~"^(${DRIVABLE})$"]["access"!~"^(no|private)$"](${bbox});
(._;>;);
out qt;`;

  const json = await fetchOsm(query);
  const ways = json.elements.filter((e) => (e as { type: string }).type === "way").length;
  const nodes = json.elements.filter((e) => (e as { type: string }).type === "node").length;
  fs.writeFileSync(out, JSON.stringify(json));
  console.log(`osm: ${ways} ways, ${nodes} nodes -> data/osm.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({ force: process.argv.includes("--force") });
}

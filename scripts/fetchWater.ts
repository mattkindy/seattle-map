// fetchWater.ts: download water geometry for the basemap into
// data/water.json. Lakes, bays, and waterways arrive as natural=water
// polygons (ways and multipolygon relations); the Sound arrives as
// natural=coastline ways that buildViewer assembles and closes against
// the map edge. Cached: pass --force to refresh.
//
// This is display geometry only. The hand-drawn polygons in
// generateGrid.ts keep their job of masking anchor points; they are
// deliberately coarse there so they do not eat shoreline anchors.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dataFileExists, writeJsonGz } from "../src/lib/data.ts";
import type { Grid } from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function fetchOverpass(query: string): Promise<{ elements: unknown[] }> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      process.stderr.write(`water: querying ${new URL(url).host} …\n`);
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
  const out = path.join(root, "data", "water.json");
  if (dataFileExists(out) && !force) {
    console.log("water: data/water.json already present (use --force to refresh)");
    return;
  }
  const grid = JSON.parse(
    fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
  ) as Grid;
  const b = grid.bounds;
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // out geom inlines coordinates on every way and relation member, so
  // no node recursion is needed.
  const query = `[out:json][timeout:180];
(
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  relation["waterway"="riverbank"](${bbox});
  way["natural"="coastline"](${bbox});
);
out geom;`;

  const json = await fetchOverpass(query);
  const kinds = new Map<string, number>();
  for (const el of json.elements as Array<{ type: string }>) {
    kinds.set(el.type, (kinds.get(el.type) ?? 0) + 1);
  }
  writeJsonGz(out, json);
  console.log(
    `water: ${[...kinds].map(([k, n]) => `${n} ${k}s`).join(", ")} -> data/water.json.gz`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({ force: process.argv.includes("--force") });
}

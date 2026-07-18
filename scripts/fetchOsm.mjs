// fetchOsm.mjs — download the drivable road network for the grid's
// bounding box from OpenStreetMap (Overpass API) into data/osm.json.
// Cached: skips the download if the file already exists. Delete it to
// refresh.
//
// Only road classes a car uses are requested, which keeps the response
// to something one query can return. Service roads, paths, and tracks
// are excluded on purpose.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "data", "osm.json");

if (fs.existsSync(out) && !process.argv.includes("--force")) {
  console.log("osm: data/osm.json already present (use --force to refresh)");
  process.exit(0);
}

const grid = JSON.parse(
  fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
);
const b = grid.bounds;
const bbox = `${b.south},${b.west},${b.north},${b.east}`;

const DRIVABLE =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|" +
  "living_street|motorway_link|trunk_link|primary_link|secondary_link|" +
  "tertiary_link";

const query = `[out:json][timeout:240];
way["highway"~"^(${DRIVABLE})$"]["access"!~"^(no|private)$"](${bbox});
(._;>;);
out skel qt;`;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function fetchOsm() {
  let lastErr;
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
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.elements || json.elements.length === 0) {
        throw new Error("empty response");
      }
      return json;
    } catch (err) {
      lastErr = err;
      process.stderr.write(`  failed: ${err.message}\n`);
    }
  }
  throw lastErr;
}

const json = await fetchOsm();
const ways = json.elements.filter((e) => e.type === "way").length;
const nodes = json.elements.filter((e) => e.type === "node").length;
fs.writeFileSync(out, JSON.stringify(json));
console.log(`osm: ${ways} ways, ${nodes} nodes -> data/osm.json`);

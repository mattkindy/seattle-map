// Gzipped JSON data files. The large fetched inputs (OSM roads, water
// geometry) commit to the repo compressed, so fresh checkouts and CI
// runs never depend on Overpass being reachable. Readers accept either
// form; writers produce the compressed one.

import fs from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

const gzPath = (jsonPath: string) => jsonPath + ".gz";

export function dataFileExists(jsonPath: string): boolean {
  return fs.existsSync(gzPath(jsonPath)) || fs.existsSync(jsonPath);
}

export function readJsonGz<T>(jsonPath: string): T {
  if (fs.existsSync(gzPath(jsonPath))) {
    return JSON.parse(gunzipSync(fs.readFileSync(gzPath(jsonPath))).toString("utf8")) as T;
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf8")) as T;
}

export function writeJsonGz(jsonPath: string, value: unknown): void {
  fs.writeFileSync(gzPath(jsonPath), gzipSync(JSON.stringify(value), { level: 6 }));
  // A stale uncompressed sibling would shadow nothing (readers prefer
  // the .gz) but would still confuse; remove it.
  if (fs.existsSync(jsonPath)) {
    fs.unlinkSync(jsonPath);
  }
}

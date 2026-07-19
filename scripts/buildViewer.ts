// buildViewer.ts: assemble docs/embedding.js for the site from every
// embedded slice (freeflow baseline plus each captured traffic slice),
// the shared mesh edges, and a table of example routes with per-slice
// minutes, distortion factors, and the driving route itself. The site is
// static; this file is the whole data hand-off, inlined so
// docs/index.html opens from file:// and serves on Pages.
//
// Each route's drawn path is the shortest-time drive over the road
// network, projected onto the anchor mesh (every road node maps to its
// nearest anchor, consecutive repeats collapse). The projection lets the
// path morph with the embedding. Routes can differ per slice when
// congestion changes the fastest road.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyTraffic,
  buildGraph,
  dijkstraPath,
  largestScc,
  makeSnapper,
  type OsmElement,
  type RoadGraph,
} from "../src/roadRouter.ts";
import type { Reading } from "../src/traffic/index.ts";
import {
  FREEFLOW,
  type EmbeddingFile,
  type Grid,
  type MatrixFile,
  type TrafficFile,
} from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");

// Example routes for the site: pairs people actually drive, spanning
// the compressed corridors and the stretched crossings.
const ROUTES: Array<{ name: string; a: [number, number]; b: [number, number] }> = [
  { name: "Northgate to Downtown", a: [47.708, -122.328], b: [47.606, -122.333] },
  { name: "Green Lake to Georgetown", a: [47.6805, -122.322], b: [47.548, -122.323] },
  { name: "Ballard to U District", a: [47.668, -122.384], b: [47.66, -122.313] },
  { name: "Magnolia to Capitol Hill", a: [47.647, -122.4], b: [47.623, -122.316] },
  { name: "West Seattle to Ballard", a: [47.566, -122.387], b: [47.668, -122.384] },
];

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
const KM_PER_MILE = 1.60934;

export async function main(): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(dataDir, "grid.json"), "utf8"),
  ) as Grid;

  const sliceIds = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("embedding-") && f.endsWith(".json"))
    .map((f) => f.slice("embedding-".length, -".json".length));
  // Freeflow baseline first, then captures.
  const ordered = [
    ...sliceIds.filter((s) => s === FREEFLOW),
    ...sliceIds.filter((s) => s !== FREEFLOW).sort(),
  ];
  if (!ordered.includes(FREEFLOW)) {
    throw new Error("no freeflow embedding; run the pipeline first");
  }

  const nearestAnchor = (lat: number, lng: number): number => {
    let best = 0;
    let bd = Infinity;
    grid.anchors.forEach((p, i) => {
      const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const readingsOf = new Map<string, Reading[]>();
  const slices = ordered.map((slice) => {
    const emb = JSON.parse(
      fs.readFileSync(path.join(dataDir, `embedding-${slice}.json`), "utf8"),
    ) as EmbeddingFile;
    let label = "Free flow";
    let capturedAt: string | null = null;
    if (slice !== FREEFLOW) {
      const traffic = JSON.parse(
        fs.readFileSync(path.join(dataDir, `traffic-${slice}.json`), "utf8"),
      ) as TrafficFile;
      label = traffic.label;
      capturedAt = traffic.capturedAt;
      readingsOf.set(slice, traffic.readings);
    }
    return {
      id: slice,
      label,
      capturedAt,
      traffic: emb.traffic,
      stress: emb.stress,
      anchors: emb.anchors,
    };
  });

  const matrices = new Map(
    ordered.map((slice) => [
      slice,
      (
        JSON.parse(
          fs.readFileSync(path.join(dataDir, `matrix-${slice}.json`), "utf8"),
        ) as MatrixFile
      ).seconds,
    ]),
  );

  // Road graphs for route geometry, one per slice. Skipped (straight
  // fallback) when no OSM data is present, e.g. a synthetic-only run.
  const osmPath = path.join(dataDir, "osm.json");
  let graphs: Map<string, RoadGraph> | null = null;
  let snap: ((la: number, lo: number) => number) | null = null;
  if (fs.existsSync(osmPath)) {
    const osm = JSON.parse(fs.readFileSync(osmPath, "utf8")) as {
      elements: OsmElement[];
    };
    const base = buildGraph(osm.elements);
    const { mask } = largestScc(base);
    snap = makeSnapper(base, mask);
    graphs = new Map(
      ordered.map((slice) => {
        const readings = readingsOf.get(slice);
        return [slice, readings ? applyTraffic(base, readings) : base];
      }),
    );
  }

  // Project a road-node path onto the anchor mesh: nearest anchor per
  // node, consecutive repeats collapsed, endpoints pinned. The
  // nearest-anchor assignment can flicker between two anchors along a
  // road that runs between them, leaving a-b-a stutters; collapse those
  // until none remain.
  function meshPath(
    graph: RoadGraph,
    nodes: number[],
    ai: number,
    bi: number,
  ): number[] {
    const out: number[] = [ai];
    for (const u of nodes) {
      const a = nearestAnchor(graph.lat[u], graph.lng[u]);
      if (a !== out[out.length - 1]) {
        out.push(a);
      }
    }
    if (out[out.length - 1] !== bi) {
      out.push(bi);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = out.length - 3; i >= 0; i--) {
        if (i + 2 < out.length && out[i] === out[i + 2]) {
          out.splice(i + 1, 2);
          changed = true;
        }
      }
    }
    return out;
  }

  const routes = ROUTES.map(({ name, a, b }) => {
    const ai = nearestAnchor(a[0], a[1]);
    const bi = nearestAnchor(b[0], b[1]);
    const pa = grid.anchors[ai];
    const pb = grid.anchors[bi];
    const geoKm = Math.hypot(
      (pa.lat - pb.lat) * KM_PER_DEG_LAT,
      (pa.lng - pb.lng) * kmPerDegLng,
    );
    const minutes: Record<string, number> = {};
    const factor: Record<string, number> = {};
    const routePath: Record<string, number[]> = {};
    for (const slice of ordered) {
      const seconds = matrices.get(slice) as (number | null)[][];
      const there = seconds[ai][bi];
      const back = seconds[bi][ai];
      const s =
        there != null && back != null ? (there + back) / 2 : (there ?? back);
      minutes[slice] = s == null ? NaN : Number((s / 60).toFixed(1));
      const anchors = (slices.find((x) => x.id === slice) as (typeof slices)[0])
        .anchors;
      const qa = anchors[ai];
      const qb = anchors[bi];
      factor[slice] = Number(
        (Math.hypot(qa.tx - qb.tx, qa.ty - qb.ty) / geoKm).toFixed(2),
      );
      let mesh = [ai, bi];
      const graph = graphs?.get(slice);
      if (graph && snap) {
        const nodes = dijkstraPath(
          graph,
          snap(pa.lat, pa.lng),
          snap(pb.lat, pb.lng),
        );
        if (nodes.length > 0) {
          mesh = meshPath(graph, nodes, ai, bi);
        }
      }
      routePath[slice] = mesh;
    }
    return {
      name,
      ai,
      bi,
      miles: Number((geoKm / KM_PER_MILE).toFixed(1)),
      minutes,
      factor,
      path: routePath,
    };
  });

  const payload = { edges: grid.edges, slices, routes };
  const body = `window.EMBEDDING = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(path.join(root, "docs", "embedding.js"), body);

  // Stamp the page's script reference with a content hash so browsers
  // never pair a cached data file with a newer page.
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 8);
  const indexPath = path.join(root, "docs", "index.html");
  const page = fs.readFileSync(indexPath, "utf8");
  const stamped = page.replace(
    /src="\.\/embedding\.js[^"]*"/,
    `src="./embedding.js?v=${hash}"`,
  );
  if (stamped !== page) {
    fs.writeFileSync(indexPath, stamped);
  }

  console.log(
    `viewer: ${slices.length} slices (${ordered.join(", ")}), ` +
      `${routes.length} routes -> docs/embedding.js (v=${hash})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

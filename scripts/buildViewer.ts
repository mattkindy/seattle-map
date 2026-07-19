// buildViewer.ts: assemble docs/embedding.js for the site from every
// embedded slice (freeflow baseline plus each captured traffic slice),
// the shared mesh edges, and a table of example routes with per-slice
// minutes, distortion factors, and the driving route itself. The site is
// static; this file is the whole data hand-off, inlined so
// docs/index.html opens from file:// and serves on Pages.
//
// Each route's drawn path is the shortest-time drive over the road
// network, emitted as downsampled road geometry; the page warps those
// vertices through the anchor displacement field, the same warp the
// basemap uses. Routes can differ per slice when congestion changes the
// fastest road.

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

// Basemap street tiers by highway class. Tier drives stroke width in
// the viewer; classes absent here (residential and below) stay off the
// basemap to keep the payload small.
const STREET_TIER: Record<string, number> = {
  motorway: 0,
  motorway_link: 0,
  trunk: 0,
  trunk_link: 0,
  primary: 1,
  primary_link: 1,
  secondary: 2,
  tertiary: 3,
};
// Drop vertices closer than this to the last kept one; street shape at
// map scale survives far coarser sampling than routing needs.
const SIMPLIFY_M = 90;
// Water ring segments longer than this get midpoints inserted so the
// outline bends with the warp instead of cutting straight across it.
const DENSIFY_M = 300;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return Math.hypot(
    (aLat - bLat) * KM_PER_DEG_LAT * 1000,
    (aLng - bLng) * kmPerDegLng * 1000,
  );
}

type LatLng = [number, number];

interface Basemap {
  water: LatLng[][];
  streets: Array<{ t: number; p: LatLng[] }>;
}

function extractBasemap(
  osmElements: OsmElement[],
  waterRings: Array<{ ring: Array<[number, number]> }>,
): Basemap {
  const nodeLat = new Map<number, number>();
  const nodeLng = new Map<number, number>();
  for (const el of osmElements) {
    if (el.type === "node") {
      nodeLat.set(el.id, el.lat);
      nodeLng.set(el.id, el.lon);
    }
  }
  // 4 decimal places is ~11 m, plenty at basemap scale.
  const rnd = (x: number): number => Number(x.toFixed(4));

  // OSM splits roads at every junction, so a single avenue arrives as
  // dozens of short ways. Collect raw node chains per tier, stitch
  // chains that share an endpoint into long polylines, then simplify.
  // Without stitching, most ways are shorter than the simplify
  // tolerance and the payload drowns in per-fragment overhead.
  const rawByTier = new Map<number, number[][]>();
  for (const el of osmElements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) {
      continue;
    }
    const t = STREET_TIER[el.tags?.highway ?? ""];
    if (t === undefined) {
      continue;
    }
    let chains = rawByTier.get(t);
    if (!chains) {
      chains = [];
      rawByTier.set(t, chains);
    }
    chains.push(el.nodes.filter((id) => nodeLat.has(id)));
  }

  function stitch(chains: number[][]): number[][] {
    // endpoint node id -> indexes of chains that start or end there
    const at = new Map<number, number[]>();
    chains.forEach((c, i) => {
      for (const end of [c[0], c[c.length - 1]]) {
        let list = at.get(end);
        if (!list) {
          at.set(end, (list = []));
        }
        list.push(i);
      }
    });
    const used = new Uint8Array(chains.length);
    const out: number[][] = [];
    for (let i = 0; i < chains.length; i++) {
      if (used[i]) {
        continue;
      }
      used[i] = 1;
      const chain = [...chains[i]];
      // Grow at the tail, then at the head, while an unused chain
      // continues from the current endpoint.
      for (const dir of [1, -1] as const) {
        for (;;) {
          const end = dir === 1 ? chain[chain.length - 1] : chain[0];
          const next = (at.get(end) ?? []).find((j) => !used[j]);
          if (next === undefined) {
            break;
          }
          used[next] = 1;
          let seg = chains[next];
          if (dir === 1) {
            if (seg[0] !== end) {
              seg = [...seg].reverse();
            }
            chain.push(...seg.slice(1));
          } else {
            if (seg[seg.length - 1] !== end) {
              seg = [...seg].reverse();
            }
            chain.unshift(...seg.slice(0, -1));
          }
        }
      }
      out.push(chain);
    }
    return out;
  }

  const streets: Basemap["streets"] = [];
  for (const [t, chains] of rawByTier) {
    for (const chain of stitch(chains)) {
      const p: LatLng[] = [];
      let lastLat = NaN;
      let lastLng = NaN;
      for (let k = 0; k < chain.length; k++) {
        const la = nodeLat.get(chain[k]) as number;
        const lo = nodeLng.get(chain[k]) as number;
        const isEnd = k === chain.length - 1;
        if (
          p.length === 0 ||
          isEnd ||
          metersBetween(lastLat, lastLng, la, lo) >= SIMPLIFY_M
        ) {
          p.push([rnd(la), rnd(lo)]);
          lastLat = la;
          lastLng = lo;
        }
      }
      if (p.length >= 2) {
        streets.push({ t, p });
      }
    }
  }

  // Water rings arrive as [lng, lat]; emit [lat, lng] like everything
  // else, with long segments densified so they bend under the warp.
  const water: LatLng[][] = waterRings.map(({ ring }) => {
    const out: LatLng[] = [];
    for (let i = 0; i < ring.length; i++) {
      const [aLng, aLat] = ring[i];
      const [bLng, bLat] = ring[(i + 1) % ring.length];
      out.push([rnd(aLat), rnd(aLng)]);
      const len = metersBetween(aLat, aLng, bLat, bLng);
      const cuts = Math.floor(len / DENSIFY_M);
      for (let c = 1; c <= cuts; c++) {
        const f = c / (cuts + 1);
        out.push([rnd(aLat + (bLat - aLat) * f), rnd(aLng + (bLng - aLng) * f)]);
      }
    }
    return out;
  });

  return { water, streets };
}

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

  // Road graphs for route geometry, one per slice, plus the basemap
  // streets. Skipped (straight fallback, no basemap) when no OSM data
  // is present, e.g. a synthetic-only run.
  const osmPath = path.join(dataDir, "osm.json");
  let graphs: Map<string, RoadGraph> | null = null;
  let snap: ((la: number, lo: number) => number) | null = null;
  let basemap: Basemap | null = null;
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
    basemap = extractBasemap(osm.elements, grid.water ?? []);
  }

  // Route geometry as geographic coordinates, downsampled. The viewer
  // warps these vertices with the same displacement field as the
  // basemap, so the route follows real roads at the geographic end of
  // the slider and bends with the city at the other. (An earlier
  // version projected the path onto the anchor mesh; the nearest-anchor
  // assignment wandered off the corridor near freeways.)
  function geoPath(graph: RoadGraph, nodes: number[]): LatLng[] {
    const out: LatLng[] = [];
    let lastLat = NaN;
    let lastLng = NaN;
    nodes.forEach((u, i) => {
      const la = graph.lat[u];
      const lo = graph.lng[u];
      const isEnd = i === nodes.length - 1;
      if (
        out.length === 0 ||
        isEnd ||
        metersBetween(lastLat, lastLng, la, lo) >= 180
      ) {
        out.push([Number(la.toFixed(5)), Number(lo.toFixed(5))]);
        lastLat = la;
        lastLng = lo;
      }
    });
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
    const routePath: Record<string, LatLng[]> = {};
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
      let pts: LatLng[] = [
        [pa.lat, pa.lng],
        [pb.lat, pb.lng],
      ];
      const graph = graphs?.get(slice);
      if (graph && snap) {
        const nodes = dijkstraPath(
          graph,
          snap(pa.lat, pa.lng),
          snap(pb.lat, pb.lng),
        );
        if (nodes.length > 0) {
          pts = geoPath(graph, nodes);
        }
      }
      routePath[slice] = pts;
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

  const payload = { edges: grid.edges, slices, routes, basemap };
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

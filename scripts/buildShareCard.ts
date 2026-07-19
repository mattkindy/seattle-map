// buildShareCard.ts: render docs/share.png, the 1200x630 social preview
// card. The left side is the city warped to its most recent traffic
// slice (the shape is the story); the right side is the title. Reads
// the viewer payload (docs/embedding.js), writes an SVG, and shells to
// rsvg-convert, which must be installed (brew install librsvg). Not
// part of the pipeline; run via `npm run sharecard` after a rebuild.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const W = 1200;
const H = 630;
const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

interface ViewerAnchor {
  lat: number;
  lng: number;
  tx: number;
  ty: number;
}

interface ViewerPayload {
  modes: Array<{
    id: string;
    slices: Array<{ id: string; label: string; anchors: ViewerAnchor[] }>;
  }>;
  routes: Array<{ name: string; path: Record<string, Array<[number, number]>> }>;
  basemap: {
    water: Array<Array<[number, number]>>;
    streets: Array<{ t: number; p: Array<[number, number]> }>;
  } | null;
}

export async function main(): Promise<void> {
  const raw = fs.readFileSync(path.join(root, "docs", "embedding.js"), "utf8");
  const payload = JSON.parse(
    raw.slice(raw.indexOf("=") + 1).replace(/;\s*$/, ""),
  ) as ViewerPayload;
  if (!payload.basemap) {
    throw new Error("no basemap in docs/embedding.js; run the pipeline first");
  }
  const drive = payload.modes.find((m) => m.id === "drive") ?? payload.modes[0];
  const slice = drive.slices[drive.slices.length - 1];

  // Same displacement warp as the viewer, evaluated at full stretch:
  // each vertex moves by the inverse-distance-weighted displacement of
  // its six nearest anchors.
  const geo = slice.anchors.map((a) => [a.lng * kmPerDegLng, a.lat * KM_PER_DEG_LAT]);
  const disp = slice.anchors.map((a, i) => [a.tx - geo[i][0], a.ty - geo[i][1]]);
  const cellKm = 1.2;
  const hash = new Map<string, number[]>();
  geo.forEach((g, i) => {
    const key = Math.floor(g[0] / cellKm) + "," + Math.floor(g[1] / cellKm);
    let b = hash.get(key);
    if (!b) {
      hash.set(key, (b = []));
    }
    b.push(i);
  });
  function warp(la: number, lo: number): [number, number] {
    const x = lo * kmPerDegLng;
    const y = la * KM_PER_DEG_LAT;
    const ci = Math.floor(x / cellKm);
    const cj = Math.floor(y / cellKm);
    const found: Array<[number, number]> = [];
    for (let r = 0; r <= 3; r++) {
      for (let a = ci - r; a <= ci + r; a++) {
        for (let b = cj - r; b <= cj + r; b++) {
          if (Math.max(Math.abs(a - ci), Math.abs(b - cj)) !== r) continue;
          for (const i of hash.get(a + "," + b) ?? []) {
            const dx = geo[i][0] - x;
            const dy = geo[i][1] - y;
            found.push([dx * dx + dy * dy, i]);
          }
        }
      }
      if (found.length >= 6 && r >= 1) break;
    }
    if (found.length === 0) {
      return [x, y];
    }
    found.sort((p, q) => p[0] - q[0]);
    let ws = 0;
    let ax = 0;
    let ay = 0;
    for (const [d2, i] of found.slice(0, 6)) {
      const w = 1 / (d2 + 1e-6);
      ws += w;
      ax += w * disp[i][0];
      ay += w * disp[i][1];
    }
    return [x + ax / ws, y + ay / ws];
  }

  // Warp all geometry, then fit to the left panel.
  const streets = payload.basemap.streets
    .filter((s) => s.t <= 2)
    .map((s) => ({ t: s.t, v: s.p.map(([la, lo]) => warp(la, lo)) }));
  const water = payload.basemap.water.map((ring) =>
    ring.map(([la, lo]) => warp(la, lo)),
  );
  const route = payload.routes[0];
  const routePts = (route.path[slice.id] ?? []).map(([la, lo]) => warp(la, lo));

  const all = [...streets.flatMap((s) => s.v), ...water.flat()];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const panelW = 560;
  const pad = 24;
  const s = Math.min((panelW - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const px = (p: [number, number]) =>
    `${((p[0] - x0) * s + pad + (panelW - 2 * pad - (x1 - x0) * s) / 2).toFixed(1)},${(
      H - pad - (p[1] - y0) * s - (H - 2 * pad - (y1 - y0) * s) / 2
    ).toFixed(1)}`;

  const streetEls = streets
    .map((st) => {
      const width = st.t === 0 ? 2.2 : st.t === 1 ? 1.3 : 0.8;
      const op = st.t === 0 ? 0.9 : st.t === 1 ? 0.75 : 0.55;
      return `<polyline points="${st.v.map(px).join(" ")}" fill="none" stroke="#9aa0a6" stroke-width="${width}" opacity="${op}"/>`;
    })
    .join("\n");
  const waterEls = water
    .map((r) => `<path d="M${r.map(px).join("L")}Z" fill="#b8d4e8" opacity="0.8"/>`)
    .join("\n");
  const routeEl = routePts.length
    ? `<polyline points="${routePts.map(px).join(" ")}" fill="none" stroke="#3a6ea5" stroke-width="4" stroke-linecap="round"/>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${waterEls}
${streetEls}
${routeEl}
<g font-family="Georgia, serif" fill="#121212">
  <text x="620" y="150" font-family="Helvetica, Arial, sans-serif" font-size="18" letter-spacing="3" fill="#5a5a5a">AN INTERACTIVE MAP</text>
  <text x="620" y="230" font-size="56" font-weight="bold">Seattle, if Distance</text>
  <text x="620" y="298" font-size="56" font-weight="bold">Were Measured</text>
  <text x="620" y="366" font-size="56" font-weight="bold">in Minutes</text>
  <text x="620" y="440" font-size="26" fill="#5a5a5a">The city, redrawn by its drive times.</text>
  <text x="620" y="478" font-size="26" fill="#5a5a5a">Speed limits vs. Friday rush.</text>
</g>
</svg>`;

  const svgPath = path.join(root, "docs", "share-card.svg");
  fs.writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", [
    "-w", String(W), "-h", String(H),
    "-o", path.join(root, "docs", "share.png"),
    svgPath,
  ]);
  fs.unlinkSync(svgPath);
  const size = fs.statSync(path.join(root, "docs", "share.png")).size;
  console.log(`sharecard: docs/share.png (${(size / 1024).toFixed(0)} KB, slice ${slice.id})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

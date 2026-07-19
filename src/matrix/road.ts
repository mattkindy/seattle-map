// Speed-limit routing over the OSM road network (src/roadRouter), with
// the slice's traffic readings applied to edge weights when present.
// Available once data/osm.json has been fetched.

import path from "node:path";

import { dataFileExists, readJsonGz } from "../lib/data.ts";
import { applyTraffic, buildGraph, driveMatrix, type OsmElement } from "../roadRouter.ts";
import type { MatrixProvider } from "./index.ts";

const osmPath = (root: string) => path.join(root, "data", "osm.json");

export const road: MatrixProvider = {
  name: "road",
  available: (ctx) => dataFileExists(osmPath(ctx.root)),
  async build(anchors, ctx) {
    const osm = readJsonGz<{ elements: OsmElement[] }>(osmPath(ctx.root));
    ctx.log(`road: building graph from ${osm.elements.length} elements …\n`);
    let graph = buildGraph(osm.elements);
    ctx.log(`road: ${graph.n} nodes, ${graph.head.length} directed edges\n`);
    if (ctx.traffic) {
      ctx.log(
        `road: applying ${ctx.traffic.readings.length} ${ctx.traffic.provider} speed readings\n`,
      );
      graph = applyTraffic(graph, ctx.traffic.readings);
    }
    return driveMatrix(graph, anchors, ctx.log);
  },
};

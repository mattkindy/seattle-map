# Seattle Map

Live map: https://mattkindy.github.io/seattle-map/ (with an
[illustrated math page](https://mattkindy.github.io/seattle-map/math.html)).

A time-space cartogram of Seattle: a map where the distance between two
points reflects how long it takes to drive between them, not how far
apart they sit. The map has two views, free-flow speed limits and
measured Friday-evening traffic, and a slider that morphs the city
between geography and drive-time shape.

The idea came from a stay on Capitol Hill. Visiting friends in Ballard
took far longer than the map distance suggested, while Phinney Ridge to
downtown, which looks farther, went by quickly. Seattle's drive times
depend on direction and water in a way geographic maps cannot show, so
this project redraws the city with time as the ruler.

## How it works

The pipeline is a chain of small TypeScript scripts, each writing a JSON
file the next one reads:

1. `scripts/generateGrid.ts` lays a hex grid over the city, drops
   points in water, and connects neighbors into a mesh (733 anchors).
2. `scripts/fetchOsm.ts` downloads the drivable street network from
   [OpenStreetMap](https://www.openstreetmap.org/about) via Overpass.
   OSM supplies each road's shape, speed limit, and one-way rules
   (© OpenStreetMap contributors).
3. `scripts/fetchTraffic.ts` captures a named traffic slice: a slowdown
   reading near every anchor, from
   [TomTom's flow API](https://developer.tomtom.com/traffic-api/documentation/tomtom-maps/traffic-flow/flow-segment-data)
   when `TOMTOM_API_KEY` is set, else a modeled profile.
4. `scripts/fetchMatrix.ts` routes every anchor pair over the network
   (graph build, largest strongly connected component, Dijkstra; all in
   `src/roadRouter.ts`, dependency-free) and writes one drive-time
   matrix per slice. Traffic slices multiply edge times by interpolated
   slowdowns.
5. `scripts/embed.ts` turns a matrix into 2D positions (classical MDS,
   SMACOF refinement, Procrustes alignment; `src/embedding.ts`).
6. `scripts/buildViewer.ts` bundles every slice plus a table of example
   routes into `docs/embedding.js` for the static site in `docs/`.

Data sources are behind provider interfaces (`src/traffic`,
`src/matrix`): each source is one file implementing a shared contract,
selection is by key availability with an env override, and a new source
(HERE, WSDOT, Google) is a file added to a registry. Shared
rate-limiting lives in `src/lib/pool.ts`.

## Run it

```bash
npm run pipeline           # grid -> osm -> matrices -> embeddings -> viewer
open docs/index.html

# capture a new traffic slice (TomTom key from developer.tomtom.com):
TOMTOM_API_KEY=... npm run traffic -- tuesday-morning "Tuesday morning"
npm run pipeline           # picks up every captured slice

npm run typecheck          # tsc over src/ and scripts/
```

Scripts run through `npx tsx`; Node 23.6+ also runs them directly. The
pipeline itself has no runtime dependencies.

## What the data shows

At posted speed limits, north-south freeway trips draw at about
two-thirds of their geographic distance (Green Lake to Georgetown:
0.62x) while east-west water crossings stretch to half again as far
(Magnolia to Capitol Hill: 1.55x). Friday-evening traffic lengthens the
average trip by roughly a fifth and cuts the freeway advantage, so the
compressed routes give some distance back while the crossings stretch
further. Fit quality (stress-1): 0.135 free-flow, 0.119 with traffic.

## Where this goes

- More slices: weekday morning rush, midday, late night.
- More modes: transit via GTFS is the interesting one, then bike.
- A basemap warped through the mesh (thin-plate spline over anchor
  displacement) so streets and shorelines bend with the times.
- Measured drive times from a routing API as another matrix provider.

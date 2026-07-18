# Seattle Map

Live map: https://mattkindy.github.io/seattle-map/ (with a
[plain-language explanation](https://mattkindy.github.io/seattle-map/) and an
[illustrated math page](https://mattkindy.github.io/seattle-map/math.html)).

A time-space cartogram of Seattle: a map where the distance between two
points reflects how long it takes to travel between them, not how far
apart they are. Seattle is a good subject because travel time is so
direction-dependent: north-south rides fast corridors while east-west
fights water crossings, so the city should visibly stretch sideways and
shear at the bridges.

## How it works

1. `scripts/generateGrid.mjs` lays a hex grid of anchor points over the
   city and drops the ones in water (about 730 anchors).
2. `scripts/fetchMatrix.mjs` builds the pairwise drive-time matrix.
   With `GOOGLE_MAPS_API_KEY` set it uses the Distance Matrix API in
   25x25 blocks (price out n^2 elements before a dense run). Without a
   key it uses a synthetic Seattle model (fast north-south, slow
   east-west, bridge penalties) so the whole pipeline runs with zero
   setup.
3. `scripts/embed.mjs` runs multidimensional scaling (classical MDS +
   SMACOF refinement, no dependencies) to place anchors so screen
   distance approximates drive time, then Procrustes-aligns the result
   back to geography so north stays up.
4. `docs/index.html` is the site (GitHub Pages serves `docs/`): the
   interactive map plus a plain-language explanation, with the math
   walk-through in `docs/math.html`. It opens from disk too; the
   embedding is inlined as `docs/embedding.js` at build time.

## Run it

```bash
npm run pipeline   # grid -> matrix -> embedding (synthetic by default)
open docs/index.html
```

First sanity result from the synthetic matrix: Northgate to Columbia
City (north-south) compresses to 0.90x its geographic distance, while
Ballard to the U District (east-west on slow surface streets) stretches
to 1.64x.

## Where this goes

- Real drive times via the Distance Matrix API (key in `GOOGLE_MAPS_API_KEY`).
- More modes: transit (GTFS via OpenTripPlanner is the interesting
  one), bike, walk. One embedding per (mode, time-of-day).
- Rush-hour slices: separate matrices at 8am / 1pm / 6pm.
- A real basemap warped through the mesh (thin-plate spline over the
  anchor displacement) instead of the bare mesh, so streets and
  shorelines bend with the times.

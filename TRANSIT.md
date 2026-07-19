# Transit mode: design

Add public transit as a second travel mode beside driving, so the map
can answer the question it was built for: how far apart places sit on
the bus.

## Shape of the change

Mode becomes an explicit dimension. Today every artifact is implicitly
drive-mode: `matrix-<slice>.json`, `embedding-<slice>.json`. The mode
dimension makes that explicit:

- Files: `matrix-<mode>-<slice>.json`, `embedding-<mode>-<slice>.json`.
  Drive keeps its slices (freeflow, captured traffic). Transit slices
  name a departure context (`weekday-0830`, `weekday-1200`), because
  transit time depends on when you leave, not on congestion readings.
- Viewer payload: `modes: [{ id, label, slices: [...] }]`. The site
  gains a mode selector beside the slice selector; routes and the
  table carry per-mode numbers.
- Provider registry: `transit` joins `google | road | synthetic` in
  `src/matrix`. Selection stays availability-based: the provider is
  available once GTFS data is fetched.

## Data

Two GTFS feeds, fetched by `scripts/fetchGtfs.ts` into `data/gtfs/`:

- King County Metro (buses): `metro.kingcounty.gov/GTFS/google_transit.zip`,
  with the OneBusAway mirror as fallback.
- Sound Transit (Link light rail, Sounder): the OneBusAway mirror.
  Link matters; it is the fastest north-south transit in the city.

Zip extraction is a small from-scratch reader (`src/lib/zip.ts`) over
Node's `zlib.inflateRawSync`; no dependencies. The files that matter:
`stops`, `routes`, `trips`, `stop_times`, `calendar`,
`calendar_dates`, and `transfers` where present.

## Routing

RAPTOR (round-based public transit routing), the standard timetable
algorithm. Per source anchor:

1. Access: walk times from the anchor to nearby stops, computed over
   the road graph with symmetrized edges (walkers ignore one-way
   rules) at 1.35 m/s, cut off at 12 minutes.
2. Rounds: each RAPTOR round relaxes one more boarding. A round scans
   every route that gained a reachable stop, boards the earliest trip
   catchable at each stop, and improves arrival times downstream.
   Foot transfers (stops within 200 m, plus GTFS transfers) run
   between rounds. Four rounds (three transfers) is enough for a city
   trip.
3. Egress: arrival time at an anchor is the best over its nearby
   stops plus the walk from each.

A transit trip's total time is walk + wait + ride + transfers, seeded
by a departure time. The slice fixes the service day and departure
(first cut: a Wednesday, 8:30 am). Frequencies-based trips expand to
timetabled trips at load.

The transit matrix is asymmetric like the drive matrix and symmetrizes
the same way in the embedding.

## What the map should show

Transit Seattle should look different from drive Seattle in two ways
worth checking for: Link compresses its station corridor harder than
I-5 compresses driving (no traffic, no parking), while everywhere off
the rail and RapidRide spines stretches badly, since a 15-minute drive
that requires two buses can take an hour. If the embedding does not
show both effects, something is wrong with the model.

## Phases

1. Fetch + parse: zip reader, GTFS load, feed statistics (this lands
   first; nothing downstream changes).
2. Routing: walk graph, RAPTOR, transit matrix provider; validate
   spot travel times against real trip-planner estimates.
3. Mode dimension: file renames, pipeline loop over modes, viewer
   mode selector, copy that explains the transit view.

Out of scope for v0: real-time transit delays, fare-based route
choice, bike and walk modes (walk is nearly geographic distance; bike
needs elevation, which is its own project).

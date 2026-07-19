// Transit time slices. A transit slice names a departure context, not
// a congestion capture: the timetable already encodes how service
// varies by hour. The service date is the next Wednesday at build
// time, a typical weekday inside the fetched feeds' validity window.

export interface TransitSlice {
  id: string;
  label: string;
  /** Departure time, HH:MM, local. */
  depart: string;
}

export const TRANSIT_SLICES: TransitSlice[] = [
  { id: "weekday-0830", label: "Weekday 8:30 am", depart: "08:30" },
];

/** Next Wednesday (or today if Wednesday), YYYYMMDD local. */
export function serviceDate(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

export function departSeconds(depart: string): number {
  const [h, m] = depart.split(":").map(Number);
  return h * 3600 + m * 60;
}

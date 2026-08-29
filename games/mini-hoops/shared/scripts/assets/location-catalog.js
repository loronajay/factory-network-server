// The registry of rooms you can shoot in.
//
// Same contract as the ball catalog: adding a room is a data change. Drop a
// backdrop at `assets/backgrounds/<id>.jpg` and add a row.
//
// LOCATIONS ARE COSMETIC ONLY. The backdrop is painted to the canvas and nothing
// else reads it — no geometry, no physics, no scoring. This is deliberate and it
// is the same constraint the ball catalog is under: leaderboard entries are keyed
// on hoop mode and round length, so a room that changed the shot would make two
// entries on one board incomparable.
//
// The art is authored at exactly the canvas size (CANVAS_WIDTH x CANVAS_HEIGHT),
// so a backdrop blits 1:1 with no resampling. `tests/location-catalog.test.js`
// checks that, because a mis-sized backdrop is a subtly soft room that is easy to
// miss and annoying to trace.

const BACKGROUND_ASSET_ROOT = "assets/backgrounds";

export const LOCATIONS = Object.freeze([
  Object.freeze({
    id: "bedroom",
    label: "Bedroom",
    blurb: "Where every mini hoop career starts.",
  }),
  Object.freeze({
    id: "warehouse",
    label: "Warehouse",
    blurb: "High ceilings, long echo, nobody watching.",
  }),
  Object.freeze({
    id: "police",
    label: "Police Office",
    blurb: "Shooting on the clock, on the taxpayer's dime.",
  }),
  Object.freeze({
    id: "detention",
    label: "Detention",
    blurb: "Forty minutes of nothing to do but shoot.",
  }),
  Object.freeze({
    id: "cubicle",
    label: "Cubicle",
    blurb: "The wastebasket league's spiritual home.",
  }),
  Object.freeze({
    id: "rec-hall",
    label: "Rec Hall",
    blurb: "The chairs are folded. The court is still open.",
  }),
  Object.freeze({
    id: "school-gym",
    label: "School Gym",
    blurb: "After the last bell, the floor is yours.",
  }),
  Object.freeze({
    id: "fieldhouse",
    label: "Fieldhouse",
    blurb: "Old brick, bright maple, one very long echo.",
  }),
]);

export const DEFAULT_LOCATION = "bedroom";

export function locationIds() {
  return LOCATIONS.map((location) => location.id);
}

/** Resolve a location id, falling back to the default rather than throwing. */
export function locationById(id) {
  return LOCATIONS.find((location) => location.id === id) || LOCATIONS.find((location) => location.id === DEFAULT_LOCATION);
}

/** Path to a location's backdrop, relative to the cabinet root. */
export function locationBackdropPath(id) {
  return `${BACKGROUND_ASSET_ROOT}/${locationById(id).id}.jpg`;
}

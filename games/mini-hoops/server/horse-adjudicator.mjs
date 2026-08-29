// Rules on one HORSE shot.
//
// Same rule as `mini-hoops-adjudicator.mjs`: no outcome supplied by a browser
// participates in this ruling. The client sends a pull and the phase of the
// target's motion clock it released on — nothing about whether it went in.
//
// THE LOOP ITSELF IS THE CABINET'S, mirrored rather than re-typed.
// `sim/horse-replay.js` is the flight with the browser taken off it, and it is
// what the cabinet's own tools and its CPU planner run too. This file used to
// carry a second copy of it, which is a copy of the one thing in the whole mode
// that must not differ between the two machines: a half-tick of disagreement
// here is a made basket only one of them saw.
//
// WHAT IT ADDS is the shape of the answer this server wants — `made`, the
// contacts for the client's own narration, and WHICH TOOLS the ball used, which
// is what `sim/horse.js` needs to hold a matcher to the apparatus the setter
// proved.
import { replayHorseShot } from "../shared/scripts/sim/horse-replay.js";

export function adjudicateHorseShot({ intent, setup, motionSeconds = 0 }) {
  const replay = replayHorseShot({ setup, intent, motionSeconds });
  return { made: replay.made, contacts: replay.contacts, touched: replay.touched };
}

import * as CANNON from './vendor/cannon-es.mjs';
import { LANE_TOP, PIN_COM, PIN_SHAPES, PIN_INERTIA_PER_MASS, PIN_POSITIONS, ROOM_BOXES,
  BALL_RADIUS, RELEASE_Z, DECK_END_Z, PIT_Z, GUTTER_CAPTURE_X, normalizedZ } from './geometry.mjs';
import { launchForShot, lanePointForShot } from './shot-path.mjs';
export { launchForShot } from './shot-path.mjs';

const UP = new CANNON.Vec3(0, 1, 0);
const up = new CANNON.Vec3();

// A pin is 1.78 units tall and 0.381m tall in life, so real gravity leaves the
// deck in about a fifth of its proper weight: struck pins balloon three units
// into the air, sail past their neighbours and shrug the ball aside, which is
// what reads as a ball lighter than the pins. GRAVITY is scaled to the geometry
// instead -- not the strict 9.82/0.214 the pin height alone implies, because
// the pin deck retains its original scale. The world is therefore deliberately
// in slow motion, and every other number here is read in that frame.
//
// FRICTION_GRAVITY is the load-bearing one. Cannon does not bound friction by
// the normal force it actually computed: it caps each friction equation at
// `friction * |frictionGravity| * reducedMass` and treats that cap as an
// IMPULSE, so the most a contact can shed in one step is `friction *
// |frictionGravity|` of speed no matter how short the step is. Left at the
// world gravity that is 3.96 units/s per contact per step -- and a standing pin
// rests on four base-box corners at 180Hz, so a pin arrived at 6 units/s and
// lost 41% of it in 5ms, pivoting on a base the deck was holding with about a
// hundred times the friction a 34-newton pin can generate. That is what read as
// pins gripping the lane and tipping in place instead of being knocked out of
// the rack, and it is the same sink that ate a third of the ball's momentum on
// the head pin and made the ball feel light. Setting it to GRAVITY * SUB_STEP
// restores the physical impulse, mu*m*g*dt, for one contact per step.
//
// With friction no longer eating the deck, the collisions have to be real to
// carry: pin-on-pin and ball-on-pin restitution are lacquered maple, not putty,
// and most of a strike is pins hitting pins. The ball still drives through the
// rack rather than bouncing off it -- that is the 4.4:1 mass ratio, not the
// restitution. Retune the block as a whole and re-run the deck tests: a pocket
// line must strike, a dead-flush head-on hit must split, a pin pushed at 6
// units/s must skid before it topples, and a struck pin must carry 3.5-9 units,
// stay under 1.2 up, and come to rest.
const SUB_STEP = 1 / 180;
export const TUNING = {
  GRAVITY: 22,
  FRICTION_GRAVITY: 22 * SUB_STEP,
  BALL_MASS: 6.8,
  PIN_MASS: 1.53,
  CONTACTS: [
    ['ball', 'lane', .035, .010], ['ball', 'gutter', .12, .020], ['ball', 'pin', .06, .35],
    ['pin', 'pin', .30, .35], ['pin', 'lane', .18, .022],
  ],
  BALL_DAMPING: { linear: .012, angular: .014 },
  PIN_DAMPING: { linear: .035, angular: .055 },
  PIN_SLEEP: { speed: .05, time: .40 },
};
// Cannon's own mass properties come from the body AABB, which is a block, not a
// pin. Replace them with the silhouette's, about the body's real centre of mass.
function setPinInertia(body) {
  const [x, y, z] = PIN_INERTIA_PER_MASS.map(perMass => perMass * body.mass);
  body.inertia.set(x, y, z);
  body.invInertia.set(1 / x, 1 / y, 1 / z);
  body.updateInertiaWorld(true);
}

export function auditPinTip(pin, dt) {
  pin.body.quaternion.vmult(UP, up);
  pin.tipTime = up.y < .88 ? pin.tipTime + dt : Math.max(0, pin.tipTime - dt * .28);
  if (up.y < .72 || pin.tipTime > .075) pin.wasTipped = true;
  if (pin.body.position.z < DECK_END_Z + .18 || Math.abs(pin.body.position.x) > 3.4) pin.enteredPit = true;
}

export function isKnockedPin(pin) {
  pin.body.quaternion.vmult(UP, up);
  return pin.wasTipped || pin.enteredPit || up.y < .84 || pin.body.position.y < LANE_TOP + PIN_COM - .13;
}

// The 3D engine returns the same pin/ball snapshot shape the match runtime
// consumes, but owns real rigid bodies privately. A world lives for ONE roll.
export function create3dPhysics(physics) {
  function createSimulation(pins, shot) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -TUNING.GRAVITY, 0),
      frictionGravity: new CANNON.Vec3(0, -TUNING.FRICTION_GRAVITY, 0) });
    world.allowSleep = true;
    world.solver.iterations = 18;
    world.solver.tolerance = .001;
    world.broadphase = new CANNON.SAPBroadphase(world);
    const materials = Object.fromEntries(['lane','gutter','pin','ball'].map(name => [name, new CANNON.Material(name)]));
    world.defaultContactMaterial.friction = .1;
    world.defaultContactMaterial.restitution = .04;
    for (const [a,b,friction,restitution] of TUNING.CONTACTS) world.addContactMaterial(new CANNON.ContactMaterial(materials[a], materials[b], {
      friction, restitution, contactEquationStiffness: 8e7, contactEquationRelaxation: 3,
    }));
    for (const { size, pos, surface } of ROOM_BOXES) {
      const body = new CANNON.Body({ mass: 0, material: materials[surface] || materials.gutter,
        shape: new CANNON.Box(new CANNON.Vec3(...size.map(v => v / 2))), collisionFilterGroup: 1 });
      body.position.set(...pos);
      world.addBody(body);
    }
    const snapshots = pins.filter(p => p.standing).map(p => ({ ...p, contacted: false }));
    const entries = snapshots.map(pin => {
      const [x,z] = PIN_POSITIONS[pin.id - 1];
      const body = new CANNON.Body({ mass: TUNING.PIN_MASS, material: materials.pin,
        linearDamping: TUNING.PIN_DAMPING.linear, angularDamping: TUNING.PIN_DAMPING.angular, allowSleep: true, sleepSpeedLimit: TUNING.PIN_SLEEP.speed,
        sleepTimeLimit: TUNING.PIN_SLEEP.time, collisionFilterGroup: 2 });
      body.addShape(new CANNON.Box(new CANNON.Vec3(.125,.055,.125)), new CANNON.Vec3(0,.06-PIN_COM,0));
      for (const [y,r] of PIN_SHAPES) body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0,y-PIN_COM,0));
      body.position.set(x, LANE_TOP + PIN_COM + .003, z);
      setPinInertia(body);
      body.addEventListener('collide', event => { if (event.body.mass > 0) pin.contacted = true; });
      world.addBody(body);
      return { id: pin.id, body, tipTime: 0, wasTipped: false, enteredPit: false, snapshot: pin };
    });
    const launch = launchForShot(physics, shot);
    const body = new CANNON.Body({ mass: TUNING.BALL_MASS * (shot.massScale || 1), material: materials.ball,
      shape: new CANNON.Sphere(BALL_RADIUS), linearDamping: TUNING.BALL_DAMPING.linear,
      angularDamping: TUNING.BALL_DAMPING.angular,
      allowSleep: false, collisionFilterGroup: 4, collisionFilterMask: 1 | 2 });
    body.position.set(launch.x, LANE_TOP + BALL_RADIUS + .012, RELEASE_Z);
    body.velocity.set(launch.vx, -.04, -launch.speed);
    body.angularVelocity.set(-launch.speed / BALL_RADIUS, (shot.hook || 0) * 3.2, -(shot.aim || 0) * 1.6);
    world.addBody(body);
    const sim = { world, entries, body, pins: snapshots, shot: { ...shot }, startStanding: snapshots.length,
      guided: true, launchSpeed: launch.speed, travelDeadline: (RELEASE_Z - PIT_Z) / launch.speed + 1.5,
      ball: { x: launch.x / 3, y: -physics.RACK_FRONT_Z * physics.Z_SCALE, active: true, gutterSide: 0 },
      elapsed: 0, settleAt: null, stillFor: 0, complete: false, threeD: true };
    body.addEventListener('collide', event => {
      if (event.body.collisionFilterGroup === 2) sim.guided = false;
    });
    return sim;
  }

  function stepSimulation(sim, dt) {
    if (sim.complete) return;
    sim.elapsed += dt;
    const { body, ball, shot } = sim;
    if (!ball.gutterSide && Math.abs(body.position.x) > GUTTER_CAPTURE_X && body.position.z > DECK_END_Z) {
      ball.gutterSide = Math.sign(body.position.x);
      sim.guided = false;
      body.collisionFilterMask = 1; // Capture is permanent; gutter rails cannot rescue the shot.
    }
    if (ball.gutterSide && body.position.z > DECK_END_Z) {
      body.position.x = ball.gutterSide * 3.4;
      body.velocity.x = 0;
    } else if (sim.guided && body.position.z > DECK_END_Z) {
      const nextZ = body.position.z - sim.launchSpeed * dt;
      const next = lanePointForShot(physics, shot, normalizedZ(nextZ));
      body.velocity.x = (next.x - body.position.x) / dt;
      body.velocity.z = -sim.launchSpeed;
      body.angularVelocity.x = -sim.launchSpeed / BALL_RADIUS;
      body.angularVelocity.z = -body.velocity.x / BALL_RADIUS;
    }
    sim.world.step(dt);
    for (const entry of sim.entries) {
      auditPinTip(entry, dt);
      const pin = entry.snapshot;
      // Standing state is monotonic within a roll, including a pin bouncing upright.
      if (isKnockedPin(entry)) pin.standing = false;
      pin.x = entry.body.position.x / 3;
      pin.y = (normalizedZ(entry.body.position.z) - physics.RACK_FRONT_Z) * physics.Z_SCALE;
    }
    ball.x = ball.gutterSide ? ball.gutterSide * physics.GUTTER_CENTER_X : body.position.x / 3;
    ball.y = (normalizedZ(body.position.z) - physics.RACK_FRONT_Z) * physics.Z_SCALE;
    const escaped = body.position.z < PIT_Z || body.position.y < -2.1;
    // V6 could wait forever when a ball stopped before entering the pit. The
    // hard deadline also starts the settle clock for slow and trapped balls.
    if (sim.settleAt === null && (escaped || sim.elapsed >= sim.travelDeadline)) sim.settleAt = sim.elapsed;
    if (sim.settleAt !== null) {
      // Wait on a quiet deck rather than a flat timer: the old fixed window cut
      // a live rack off at 1.65s while making every ordinary roll sit through
      // it. Only the deck is asked -- a pin tumbling into the pit can no longer
      // change the count -- and a pin that is already down is held to a looser
      // bar, because a fallen pin is a chain of spheres and rolls on almost
      // forever at a crawl no standing pin will ever feel.
      const moving = sim.entries.some(p => p.body.position.z > DECK_END_Z + .1 && p.body.position.y > -.4
        && (p.snapshot.standing
          ? p.body.velocity.lengthSquared() > .014 || p.body.angularVelocity.lengthSquared() > .020
          : p.body.velocity.lengthSquared() > .55));
      sim.stillFor = moving ? 0 : sim.stillFor + dt;
      const waited = sim.elapsed - sim.settleAt;
      if (sim.stillFor >= .38 || (!moving && waited >= 1.05) || waited >= 2.6) {
        sim.complete = true;
        ball.active = false;
      }
    }
  }

  function clearFallen(pins) {
    const standing = new Set(pins.filter(p => p.standing).map(p => p.id));
    return physics.createRack().filter(p => standing.has(p.id));
  }

  return { fullLaneSimulation: true, createSimulation, stepSimulation, clearFallen,
    knockedCount: sim => sim.startStanding - sim.pins.filter(p => p.standing).length };
}

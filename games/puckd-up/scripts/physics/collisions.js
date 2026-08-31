import { L, X_LIMIT, Z_RAIL_LIMIT, GOAL_CLEAR, GOAL_CAPTURE_Z, CONTACT_R } from '../config.js';
// Planar collision helpers accept body-shaped data, independent of Cannon or Three.
export function capPuck(puckBody, max = 29) {
    const sp = Math.hypot(puckBody.velocity.x, puckBody.velocity.z);
    if (sp > max) {
        const k = max / sp;
        puckBody.velocity.x *= k;
        puckBody.velocity.z *= k;
    }
}
export function hardContainPuck(puckBody) {
    // Native rigid-body contacts handle normal rail impacts. This is a deterministic
    // post-step safety envelope for extreme boosted contacts and corner cases.
    // It preserves the actual goal openings instead of simply clamping Z everywhere.
    let x = puckBody.position.x, z = puckBody.position.z;
    let vx = puckBody.velocity.x, vz = puckBody.velocity.z;
    const railBounce = .965;
    let impacts = 0;
    if (x > X_LIMIT) {
        x = X_LIMIT;
        if (vx > 0) {
            vx = -vx * railBounce;
            impacts++;
        }
    }
    else if (x < -X_LIMIT) {
        x = -X_LIMIT;
        if (vx < 0) {
            vx = -vx * railBounce;
            impacts++;
        }
    }
    const inGoalChannel = Math.abs(x) <= GOAL_CLEAR;
    if (!inGoalChannel) {
        if (z > Z_RAIL_LIMIT) {
            z = Z_RAIL_LIMIT;
            if (vz > 0) {
                vz = -vz * railBounce;
                impacts++;
            }
        }
        else if (z < -Z_RAIL_LIMIT) {
            z = -Z_RAIL_LIMIT;
            if (vz < 0) {
                vz = -vz * railBounce;
                impacts++;
            }
        }
    }
    puckBody.position.x = x;
    puckBody.position.z = z;
    puckBody.position.y = .20;
    puckBody.velocity.x = vx;
    puckBody.velocity.z = vz;
    puckBody.velocity.y = 0;
    capPuck(puckBody, 29);
    // Count velocity reflections, not positional corrections. A native contact
    // already moving inward cannot produce a second sound in this fallback.
    return impacts;
}
export function capturePuck(puckBody, playerScored) {
    // Once the puck has crossed the goal plane it is no longer a live rigid body.
    // Freezing it here prevents a high-speed goal from visually continuing off-cabinet
    // during the score celebration delay.
    const sign = playerScored ? -1 : 1;
    puckBody.position.x = Math.max(-GOAL_CLEAR, Math.min(GOAL_CLEAR, puckBody.position.x));
    puckBody.position.z = sign * GOAL_CAPTURE_Z;
    puckBody.position.y = .20;
    puckBody.velocity.set(0, 0, 0);
    puckBody.angularVelocity.set(0, 0, 0);
}
export function sweptMalletContact(puckBody, mallet, p0x, p0z, m0x, m0z, onStrike = () => {
}) {
    const p1x = puckBody.position.x, p1z = puckBody.position.z;
    const m1x = mallet.body.position.x, m1z = mallet.body.position.z;
    const r0x = p0x - m0x, r0z = p0z - m0z;
    const dx = (p1x - m1x) - r0x, dz = (p1z - m1z) - r0z;
    const a = dx * dx + dz * dz;
    if (a < 1e-10)
        return false;
    const c = r0x * r0x + r0z * r0z - CONTACT_R * CONTACT_R;
    if (c <= 0)
        return false; // already touching at step start: let Cannon handle it
    const b = 2 * (r0x * dx + r0z * dz);
    const disc = b * b - 4 * a * c;
    if (disc < 0)
        return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > 1)
        return false;
    let nx = r0x + dx * t, nz = r0z + dz * t;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-7)
        return false;
    nx /= nl;
    nz /= nl;
    const rvx = puckBody.velocity.x - mallet.body.velocity.x;
    const rvz = puckBody.velocity.z - mallet.body.velocity.z;
    const vn = rvx * nx + rvz * nz;
    if (vn >= -.02)
        return false; // Cannon already bounced it, or contact is separating
    // Put the puck back on the impact side, just outside the mallet.
    puckBody.position.x = m1x + nx * (CONTACT_R + .012);
    puckBody.position.z = m1z + nz * (CONTACT_R + .012);
    // Resolve normal relative velocity with a lively air-hockey restitution.
    const restitution = .94;
    const j = -(1 + restitution) * vn;
    puckBody.velocity.x += nx * j;
    puckBody.velocity.z += nz * j;
    onStrike();
    capPuck(puckBody, 29);
    return true;
}
export function goalCrossing(puckBody, p0z) {
    const x = puckBody.position.x, z = puckBody.position.z;
    if (Math.abs(x) > GOAL_CLEAR)
        return null;
    // Continuous plane-crossing test: a puck cannot skip completely through the
    // scoring zone between physics samples, even at the full 29 m/s speed ceiling.
    const northPlane = L / 2 + .10;
    const southPlane = -northPlane;
    if ((p0z <= northPlane && z > northPlane) || z > northPlane + .20) {
        return 'cpu';
    }
    if ((p0z >= southPlane && z < southPlane) || z < southPlane - .20) {
        return 'player';
    }
    return null;
}

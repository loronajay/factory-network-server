import { W, L } from '../config.js';
function reflectX(x) {
    const min = -W / 2 + .48, max = W / 2 - .48, span = max - min;
    let q = x - min, period = span * 2;
    q = ((q % period) + period) % period;
    return min + (q > span ? period - q : q);
}
export function updateCPU(cpu, puckBody, d, dt, random = Math.random) {
    const maxSpeed = [6.3, 8.8, 11.9][d], react = [.13, .055, .018][d];
    const px = puckBody.position.x, pz = puckBody.position.z, vx = puckBody.velocity.x, vz = puckBody.velocity.z;
    let tx = 0, tz = -5.7;
    if (pz < .7) {
        if (vz < -.15) {
            const t = Math.max(0, (-5.45 - pz) / vz);
            tx = reflectX(px + vx * t);
            tz = -5.55;
        }
        else if (pz < -1.0) {
            tx = px * .86;
            tz = Math.min(-1.2, pz - 1.05);
        }
    }
    tx += (random() - .5) * react * 8;
    tx = Math.max(-W / 2 + .82, Math.min(W / 2 - .82, tx));
    tz = Math.max(-L / 2 + .82, Math.min(-.72, tz));
    const dx = tx - cpu.body.position.x, dz = tz - cpu.body.position.z, dist = Math.hypot(dx, dz) || 1;
    const speed = Math.min(maxSpeed, dist / Math.max(dt, .001));
    cpu.body.velocity.set(dx / dist * speed, 0, dz / dist * speed);
}

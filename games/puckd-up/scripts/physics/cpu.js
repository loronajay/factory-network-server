import { planRivalMove } from './rivals.js';

export function updateCPU(cpu, puckBody, rivalId, dt, random = Math.random, context = {}) {
    const playerBody = context.player?.body;
    const plan = planRivalMove(rivalId, {
        cpu: cpu.body.position,
        puck: { ...puckBody.position, vx: puckBody.velocity.x, vz: puckBody.velocity.z },
        player: playerBody?.position || { x: 0, z: 5.8 },
    }, random);
    const dx = plan.x - cpu.body.position.x, dz = plan.z - cpu.body.position.z;
    const distance = Math.hypot(dx, dz) || 1;
    const speed = Math.min(plan.speed, distance / Math.max(dt, .001));
    cpu.body.velocity.set(dx / distance * speed, 0, dz / distance * speed);
}

import { W, L } from '../config.js';
import { createWorld } from './world.js';
import { capPuck, hardContainPuck, sweptMalletContact, goalCrossing, capturePuck } from './collisions.js';
import { updateCPU } from './cpu.js';
import { updatePlayer } from '../input/player-motion.js';
// Owns rigid-body updates. Input is sampled once per fixed tick; events are facts,
// not presentation calls. An opponent controller can replace the CPU at this seam.
export function createSimulation(CANNON, match, { emit = () => {
}, random = Math.random, opponent = updateCPU, humanOpponent = false, bodies = createWorld(CANNON) } = {}) {
    const { world, puckBody, player, cpu } = bodies;
    const metrics = { speed: 0, lastShot: 0, power: 0 };
    let elapsed = 0, lastPlayerBoost = -Infinity, lastCpuBoost = -Infinity, lastFire = -Infinity, lastSpeed = 0;
    function strike(mallet, isPlayer) {
        emit({ type: 'puck-hit', player: isPlayer });
        const previous = isPlayer ? lastPlayerBoost : lastCpuBoost;
        if (elapsed - previous < (isPlayer || humanOpponent ? .075 : .09))
            return;
        if (isPlayer)
            lastPlayerBoost = elapsed;
        else
            lastCpuBoost = elapsed;
        const mv = mallet.body.velocity;
        if (Math.hypot(mv.x, mv.z) < 2)
            return;
        const coefficient = isPlayer || humanOpponent ? .42 : .25;
        puckBody.velocity.x += mv.x * coefficient;
        puckBody.velocity.z += mv.z * coefficient;
        capPuck(puckBody);
        metrics.lastShot = Math.max(metrics.lastShot, Math.hypot(puckBody.velocity.x, puckBody.velocity.z));
    }
    function collide(event) {
        if (match.state.phase !== 'live')
            return;
        if (event.body === player.body)
            strike(player, true);
        else if (event.body === cpu.body)
            strike(cpu, false);
        else if (Math.abs(event.contact?.getImpactVelocityAlongNormal() ?? Math.hypot(puckBody.velocity.x, puckBody.velocity.z)) > .01)
            emit({ type: 'wall-hit' });
    }
    puckBody.addEventListener('collide', collide);
    const playerStrike = () => strike(player, true), cpuStrike = () => strike(cpu, false);
    function contain() {
        const impacts = hardContainPuck(puckBody);
        for (let i = 0; i < impacts; i++)
            emit({ type: 'wall-hit' });
    }
    function stop() {
        for (const body of [puckBody, player.body, cpu.body]) {
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
        }
        metrics.speed = metrics.power = 0;
    }
    function resetRound(servingPlayer) {
        stop();
        puckBody.position.set(0, .20, servingPlayer ? 1.15 : -1.15);
        puckBody.quaternion.set(0, 0, 0, 1);
        for (const [mallet, z] of [[player, 5.8], [cpu, -5.8]]) {
            mallet.target.set(0, .25, z);
            mallet.body.position.set(0, .25, z);
        }
        lastPlayerBoost = lastCpuBoost = -Infinity;
    }
    function clampMallets() {
        for (const [mallet, min, max] of [[player, .72, L / 2 - .78], [cpu, -L / 2 + .78, -.72]]) {
            mallet.body.position.x = Math.max(-W / 2 + .77, Math.min(W / 2 - .77, mallet.body.position.x));
            mallet.body.position.z = Math.max(min, Math.min(max, mallet.body.position.z));
            mallet.body.position.y = .25;
        }
    }
    return {
        bodies, metrics,
        handle(event) {
            if (event.type === 'round-reset')
                resetRound(event.servingPlayer);
            if (event.type === 'serve' && !event.servingPlayer && !humanOpponent)
                puckBody.velocity.set((random() - .5) * 1.8, 0, 3.6);
            if (event.type === 'goal') {
                capturePuck(puckBody, event.playerScored);
                metrics.speed = 0;
            }
            if (event.type === 'match-reset') {
                stop();
                metrics.lastShot = 0;
            }
            if (event.type === 'match-start') {
                metrics.lastShot = lastSpeed = 0;
                lastFire = -Infinity;
            }
        },
        tick(dt, input) {
            if (match.state.screen !== 'playing')
                return;
            elapsed += dt;
            if (match.state.phase !== 'live')
                return;
            if (input.target) {
                player.target.x = input.target.x;
                player.target.z = input.target.z;
            }
            player.target.x = Math.max(-W / 2 + .8, Math.min(W / 2 - .8, player.target.x + input.dx));
            player.target.z = Math.max(.8, Math.min(L / 2 - .85, player.target.z + input.dz));
            metrics.power = updatePlayer(player, input.keys, dt);
            opponent(cpu, puckBody, match.config.cpuDifficulty, dt, random);
            const p0x = puckBody.position.x, p0z = puckBody.position.z;
            const pl0x = player.body.position.x, pl0z = player.body.position.z;
            const cp0x = cpu.body.position.x, cp0z = cpu.body.position.z;
            world.step(dt);
            clampMallets();
            contain();
            sweptMalletContact(puckBody, player, p0x, p0z, pl0x, pl0z, playerStrike);
            sweptMalletContact(puckBody, cpu, p0x, p0z, cp0x, cp0z, cpuStrike);
            contain();
            const scorer = goalCrossing(puckBody, p0z);
            if (scorer && match.score(scorer === 'player'))
                return;
            const speed = Math.hypot(puckBody.velocity.x, puckBody.velocity.z);
            if (speed > lastSpeed + 1.5)
                metrics.lastShot = Math.max(metrics.lastShot, speed);
            metrics.speed = lastSpeed = speed;
            if (speed > 23 && elapsed - lastFire > 4) {
                lastFire = elapsed;
                emit({ type: 'on-fire' });
            }
        },
        dispose() {
            puckBody.removeEventListener('collide', collide);
            stop();
        },
    };
}

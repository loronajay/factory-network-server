import { W, L, PLAYER_MAX_SPEED, PLAYER_TRACK_TIME } from '../config.js';
export function updatePlayer(player, keys, dt) {
    const keySpeed = 12.0;
    if (keys.size) {
        let dx = 0, dz = 0;
        if (keys.has('a') || keys.has('arrowleft'))
            dx--;
        if (keys.has('d') || keys.has('arrowright'))
            dx++;
        if (keys.has('w') || keys.has('arrowup'))
            dz--;
        if (keys.has('s') || keys.has('arrowdown'))
            dz++;
        const m = Math.hypot(dx, dz) || 1;
        player.target.x += dx / m * keySpeed * dt;
        player.target.z += dz / m * keySpeed * dt;
        player.target.x = Math.max(-W / 2 + .8, Math.min(W / 2 - .8, player.target.x));
        player.target.z = Math.max(.8, Math.min(L / 2 - .85, player.target.z));
    }
    const dx = player.target.x - player.body.position.x, dz = player.target.z - player.body.position.z, dist = Math.hypot(dx, dz) || 1;
    // Use a fixed target-follow time rather than render-frame dt so mallet response
    // feels the same at 30/60/120+ Hz. The higher ceiling lets fast pointer-lock
    // motions translate into equally fast physical paddle corrections.
    const speed = Math.min(PLAYER_MAX_SPEED, dist / PLAYER_TRACK_TIME);
    player.body.velocity.set(dx / dist * speed, 0, dz / dist * speed);
    const swing = Math.hypot(player.body.velocity.x, player.body.velocity.z);
    return Math.min(100, swing / PLAYER_MAX_SPEED * 100);
}

import { W, L, GOAL, RAIL } from '../config.js';
export function tableRails() {
    const rails = [];
    const addWall = (x, z, sx, sz, rot = 0) => rails.push({ x, z, sx, sz, rot });
    addWall(-W / 2 - RAIL / 2, 0, RAIL, L + RAIL * 2);
    addWall(W / 2 + RAIL / 2, 0, RAIL, L + RAIL * 2);
    const endSeg = (W - GOAL) / 2;
    for (const z of [-L / 2 - RAIL / 2, L / 2 + RAIL / 2]) {
        addWall(-(GOAL / 2 + endSeg / 2), z, endSeg, RAIL);
        addWall((GOAL / 2 + endSeg / 2), z, endSeg, RAIL);
    }
    addWall(-W / 2 + .18, -L / 2 + .18, 1.25, .32, Math.PI / 4);
    addWall(W / 2 - .18, -L / 2 + .18, 1.25, .32, -Math.PI / 4);
    addWall(-W / 2 + .18, L / 2 - .18, 1.25, .32, -Math.PI / 4);
    addWall(W / 2 - .18, L / 2 - .18, 1.25, .32, Math.PI / 4);
    return rails;
}

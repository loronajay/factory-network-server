import { tableRails } from './table-layout.js';
// Cannon is supplied by the entry point. No DOM, rendering, or venue ownership here.
export function createWorld(CANNON) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    world.allowSleep = false;
    world.solver.iterations = 16;
    world.solver.tolerance = .0005;
    world.broadphase = new CANNON.SAPBroadphase(world);
    const puckMat = new CANNON.Material('puck'), railMat = new CANNON.Material('rail'), malletMat = new CANNON.Material('mallet');
    world.addContactMaterial(new CANNON.ContactMaterial(puckMat, railMat, { friction: .0015, restitution: .965, contactEquationStiffness: 1e8 }));
    world.addContactMaterial(new CANNON.ContactMaterial(puckMat, malletMat, { friction: .008, restitution: .94, contactEquationStiffness: 2e8 }));
    for (const { x, z, sx, sz, rot } of tableRails()) {
        const body = new CANNON.Body({
            mass: 0, material: railMat,
            shape: new CANNON.Box(new CANNON.Vec3(sx / 2, .32, sz / 2)),
            position: new CANNON.Vec3(x, .31, z)
        });
        body.quaternion.setFromEuler(0, rot, 0);
        world.addBody(body);
    }
    const puckBody = new CANNON.Body({
        mass: 1, material: puckMat,
        shape: new CANNON.Cylinder(.43, .43, .22, 28),
        position: new CANNON.Vec3(0, .20, 0)
    });
    puckBody.linearFactor.set(1, 0, 1);
    puckBody.angularFactor.set(0, 1, 0);
    puckBody.linearDamping = .055;
    puckBody.angularDamping = .10;
    world.addBody(puckBody);
    function makeMallet(z) {
        const body = new CANNON.Body({
            type: CANNON.Body.KINEMATIC, mass: 0, material: malletMat,
            shape: new CANNON.Cylinder(.73, .73, .36, 32),
            position: new CANNON.Vec3(0, .25, z)
        });
        body.linearFactor.set(1, 0, 1);
        body.angularFactor.set(0, 0, 0);
        world.addBody(body);
        return { body, target: new CANNON.Vec3(0, .25, z) };
    }
    const player = makeMallet(5.8), cpu = makeMallet(-5.8);
    return { world, puckBody, player, cpu };
}

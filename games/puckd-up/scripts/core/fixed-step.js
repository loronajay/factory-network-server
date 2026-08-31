import { FIXED_DT } from '../config.js';
// A display frame contributes time, never simulation rules. Long stalls are dropped.
export function createFixedStep(tick) {
    let accumulator = 0;
    return {
        advance(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0)
                return;
            accumulator += Math.min(seconds, .05);
            while (accumulator + 1e-12 >= FIXED_DT) {
                accumulator = Math.max(0, accumulator - FIXED_DT);
                tick(FIXED_DT);
            }
        },
        reset() {
            accumulator = 0;
        },
    };
}

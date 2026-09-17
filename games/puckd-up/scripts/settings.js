import { ARENA_IDS, DEFAULT_SETTINGS } from './config.js';
import { RIVAL_IDS } from './physics/rivals.js';
const LEGACY_RIVALS = ['rookie', 'viper', 'ace'];
// Only cabinet preferences live here. The platform remains the owner of identity.
export function normalizeSettings(value = {}) {
    const difficulty = Number.isInteger(value.cpuDifficulty) && value.cpuDifficulty >= 0 && value.cpuDifficulty <= 2 ? value.cpuDifficulty : 1;
    const legacyRival = Object.hasOwn(value, 'cpuDifficulty') && Number.isInteger(value.cpuDifficulty) ? LEGACY_RIVALS[value.cpuDifficulty] : null;
    return {
        ...DEFAULT_SETTINGS,
        playerColor: /^#[0-9a-f]{6}$/i.test(value.playerColor || '') ? value.playerColor.toLowerCase() : DEFAULT_SETTINGS.playerColor,
        cpuDifficulty: difficulty,
        rivalId: RIVAL_IDS.includes(value.rivalId) ? value.rivalId : legacyRival || DEFAULT_SETTINGS.rivalId,
        arenaId: ARENA_IDS.includes(value.arenaId) ? value.arenaId : DEFAULT_SETTINGS.arenaId,
        muted: value.muted === true,
    };
}
export function loadSettings(storage) {
    try {
        const difficulty = storage.getItem('tableHockey.cpuDifficulty');
        return normalizeSettings({
            playerColor: storage.getItem('tableHockey.playerColor'),
            rivalId: storage.getItem('puckdUp.rivalId'),
            cpuDifficulty: difficulty === null || difficulty.trim() === '' ? undefined : Number(difficulty),
            arenaId: storage.getItem('tableHockey.arenaId'),
            muted: storage.getItem('puckdUp.muted') === 'true',
        });
    }
    catch {
        return normalizeSettings();
    }
}
export function saveSettings(storage, settings) {
    const config = normalizeSettings(settings);
    try {
        for (const key of ['playerColor', 'cpuDifficulty', 'arenaId'])
            storage.setItem(`tableHockey.${key}`, String(config[key]));
        storage.setItem('puckdUp.rivalId', config.rivalId);
        storage.setItem('puckdUp.muted', String(config.muted));
    }
    catch { /* Private browsing or storage quotas must not block gameplay. */
    }
}

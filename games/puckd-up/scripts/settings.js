import { ARENA_IDS, DEFAULT_SETTINGS } from './config.js';
// Only cabinet preferences live here. The platform remains the owner of identity.
export function normalizeSettings(value = {}) {
    return {
        ...DEFAULT_SETTINGS,
        playerColor: /^#[0-9a-f]{6}$/i.test(value.playerColor || '') ? value.playerColor.toLowerCase() : DEFAULT_SETTINGS.playerColor,
        cpuDifficulty: Number.isInteger(value.cpuDifficulty) && value.cpuDifficulty >= 0 && value.cpuDifficulty <= 2 ? value.cpuDifficulty : 1,
        arenaId: ARENA_IDS.includes(value.arenaId) ? value.arenaId : DEFAULT_SETTINGS.arenaId,
        muted: value.muted === true,
    };
}
export function loadSettings(storage) {
    try {
        const difficulty = storage.getItem('tableHockey.cpuDifficulty');
        return normalizeSettings({
            playerColor: storage.getItem('tableHockey.playerColor'),
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
        storage.setItem('puckdUp.muted', String(config.muted));
    }
    catch { /* Private browsing or storage quotas must not block gameplay. */
    }
}

// Lobby staging only. The future authoritative simulation belongs in this game
// module, never in the generic router. No gameplay/record relay before it exists.
export const definition = {
    id: 'puckd-up',
    matchmaking: { strategy: 'lobby' },
    lobbyGame: {
        gameId: 'puckd-up',
        lobbyLimits: { minPlayers: 2, maxPlayers: 2 },
        canStart: () => false,
        handleMessage() {
            return { handled: true, error: {
                code: 'ONLINE_NOT_READY',
                message: 'Online matches are not available yet. Lobby preparation only.',
            } };
        },
    },
};

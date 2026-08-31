# Puck'd Up: lobby preparation

Registered as a two-seat v2 lobby game. Quick Search sends explicit 2/2 limits
and settings { protocolVersion: 1, targetScore: 7 }. Private rooms use the same
contract. The generic lobby owns rosters, host transfer and disconnect cleanup.

This is NOT playable online yet. canStart always returns false and all game
messages return ONLINE_NOT_READY. Keep both gates until a server-owned match
engine and a latency-tested client synchronization adapter ship together.

The cabinet resolves Player Factory identity through the platform auth API.
The WebSocket identity field remains client-supplied display metadata, matching
existing casual-lobby conventions; it is not account authentication or permission
to award records. Never trust it for durable result ownership.

Next pass: authenticate account-to-seat bindings, mirror/test the cabinet's
240 Hz physics, accept sequenced paddle intent (not positions or scores), publish
snapshots, handle disconnect/forfeit and reconnection, then attest completed
matches to platform-api. Durable records stay in platform-api; no database or
leaderboard persistence belongs in Factory Network.

Run npm run test:puckd-up. Deploy the server before publishing the lobby client:
an older unregistered server falls back to generic relay and lacks the start gate.

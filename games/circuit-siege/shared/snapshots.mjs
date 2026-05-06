const DEFAULT_MATCH_DURATION_MS = 5 * 60 * 1000;

function deriveTimerMsRemaining(parsed) {
  const timerMsRemaining = Number(parsed?.timerMsRemaining);
  if (Number.isFinite(timerMsRemaining) && timerMsRemaining >= 0) {
    return Math.floor(timerMsRemaining);
  }

  const startedAt = Number(parsed?.startedAt);
  const endsAt = Number(parsed?.endsAt);
  if (Number.isFinite(startedAt) && Number.isFinite(endsAt) && endsAt >= startedAt) {
    return Math.floor(Math.max(0, endsAt - startedAt));
  }

  if (parsed?.phase === "ended") {
    return 0;
  }

  return DEFAULT_MATCH_DURATION_MS;
}

export function serializeMatchSnapshot(snapshot) {
  return JSON.stringify(snapshot || {});
}

export function parseMatchSnapshotMessage(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    if (typeof parsed.phase !== "string" || parsed.phase.length === 0) {
      return null;
    }

    return {
      ...parsed,
      timerMsRemaining: deriveTimerMsRemaining(parsed)
    };
  } catch {
    return null;
  }
}

export function serializeMatchEvent(event) {
  return JSON.stringify(event || {});
}

export function parseMatchEventMessage(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    if (typeof parsed.eventType !== "string" || parsed.eventType.length === 0) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

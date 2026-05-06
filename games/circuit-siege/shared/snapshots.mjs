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

    const timerMsRemaining = Number(parsed.timerMsRemaining);
    if (!Number.isFinite(timerMsRemaining) || timerMsRemaining < 0) {
      return null;
    }

    return {
      ...parsed,
      timerMsRemaining: Math.floor(timerMsRemaining)
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

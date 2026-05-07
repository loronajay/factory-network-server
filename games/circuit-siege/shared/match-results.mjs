export function createScoreWinResult(winnerSide, loserSide) {
  return {
    type: "win",
    reason: "score",
    winnerSide,
    loserSide
  };
}

export function createTimerDrawResult() {
  return {
    type: "draw",
    reason: "timer",
    winnerSide: null,
    loserSide: null
  };
}

export function createTimerWinResult(winnerSide, loserSide) {
  return {
    type: "win",
    reason: "timer",
    winnerSide,
    loserSide
  };
}

export function createDisconnectWinResult(winnerSide, loserSide, message = "opponent disconnected") {
  return {
    type: "win",
    reason: "disconnect",
    winnerSide,
    loserSide,
    message
  };
}

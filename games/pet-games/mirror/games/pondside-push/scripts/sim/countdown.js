const COUNTDOWN_SECONDS = 3;
const GO_SECONDS = 0.65;
const TIME_EPSILON = 1e-9;

/** Fixed-step pre-round gate. Play unlocks as soon as the GO phase begins. */
export function createRoundCountdown() {
  return {
    phase: "countdown",
    remaining: COUNTDOWN_SECONDS,
    complete: false,
  };
}

export function stepRoundCountdown(countdown, dt) {
  let elapsed = Math.max(0, dt);

  if (countdown.phase === "countdown") {
    const consumed = Math.min(countdown.remaining, elapsed);
    countdown.remaining -= consumed;
    elapsed -= consumed;
    if (countdown.remaining <= TIME_EPSILON) {
      countdown.phase = "go";
      countdown.remaining = GO_SECONDS;
    }
  }

  if (countdown.phase === "go" && elapsed > 0) {
    countdown.remaining -= elapsed;
    if (countdown.remaining <= TIME_EPSILON) {
      countdown.phase = "complete";
      countdown.remaining = 0;
      countdown.complete = true;
    }
  }

  return countdown;
}

export function countdownLabel(countdown) {
  if (countdown.phase === "countdown") return String(Math.max(1, Math.ceil(countdown.remaining - TIME_EPSILON)));
  if (countdown.phase === "go") return "GO!";
  return "";
}

export function isCountdownBlocking(countdown) {
  return countdown.phase === "countdown";
}

export function createInputState() {
  return {
    left: false,
    right: false,
    dropHeld: false,
    dropRequested: false,
  };
}

export function directionForKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (normalized === "arrowleft" || normalized === "a") return "left";
  if (normalized === "arrowright" || normalized === "d") return "right";
  return null;
}

export function isDropKey(key) {
  const normalized = String(key || "").toLowerCase();
  return normalized === " " || normalized === "space" || normalized === "spacebar";
}

export function updateInputForKey(input, key, pressed) {
  if (isDropKey(key)) {
    const isPressed = Boolean(pressed);
    return {
      ...input,
      dropHeld: isPressed,
      dropRequested: isPressed && !input.dropHeld ? true : input.dropRequested,
    };
  }

  const direction = directionForKey(key);
  if (!direction) return input;
  return {
    ...input,
    [direction]: Boolean(pressed),
  };
}

export function consumeDropRequest(input) {
  if (!input.dropRequested) return input;
  return {
    ...input,
    dropRequested: false,
  };
}

export function shouldPreventGameKey(key) {
  return directionForKey(key) !== null || isDropKey(key);
}

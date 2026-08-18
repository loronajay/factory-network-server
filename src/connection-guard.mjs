export function createMessageRateLimiter({ limit = 240, windowMs = 1000, now = () => Date.now() } = {}) {
  let windowStartedAt = now();
  let count = 0;

  return {
    take() {
      const current = now();
      if (current - windowStartedAt >= windowMs) {
        windowStartedAt = current;
        count = 0;
      }
      count++;
      return limit <= 0 || count <= limit;
    },
  };
}

export function parseAllowedOrigins(value = "") {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

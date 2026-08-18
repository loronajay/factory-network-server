// WebSocket implementations commonly emit `error` and then `close` for the
// same failed connection. Cleanup must run once or a reconnectable lobby seat
// can be suspended by the first event and removed by the second.
export function createDisconnectOnce(onDisconnect) {
  let disconnected = false;
  return function disconnectOnce(reason) {
    if (disconnected) return false;
    disconnected = true;
    onDisconnect(reason);
    return true;
  };
}

let lastErrorTime = 0;
const ERROR_THROTTLE_MS = 1000 * 60 * 5;

export function throttledError(message: string): void {
  const now = Date.now();
  if (now - lastErrorTime >= ERROR_THROTTLE_MS) {
    console.error(`[${new Date().toISOString()}] SERVER ERROR: ${message}`);
    lastErrorTime = now;
  }
}

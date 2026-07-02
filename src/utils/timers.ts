/**
 * Prevent a timer from keeping a Node.js process alive.
 * No-op in browsers, where `setTimeout` returns a number.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') {
    t.unref();
  }
}

import test from 'ava';

import { unrefTimer } from './timers';

test('unrefTimer unrefs Node.js timers', (t) => {
  const timer = setTimeout(() => {}, 1000);
  unrefTimer(timer);
  clearTimeout(timer);
  t.pass();
});

test('unrefTimer is a no-op for browser-style numeric timer handles', (t) => {
  // In browsers setTimeout returns a number, which has no unref method.
  unrefTimer(42 as unknown as ReturnType<typeof setTimeout>);
  t.pass();
});

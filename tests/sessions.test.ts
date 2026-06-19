import { test } from "node:test";
import assert from "node:assert/strict";
import { withLock, BusyError, type Session } from "../src/sessions.js";

// withLock only touches session.inFlight, so a bare object is enough here.
const makeSession = () => ({}) as Session;

test("withLock runs the work and returns its value, then frees", async () => {
  const s = makeSession();
  const r = await withLock(s, async () => 42);
  assert.equal(r, 42);
  assert.equal(s.inFlight, undefined);
});

test("withLock rejects a second call while one is in flight", async () => {
  const s = makeSession();
  let release: () => void = () => {};
  const first = withLock(s, () => new Promise<void>((res) => (release = res)));
  await assert.rejects(withLock(s, async () => 1), BusyError);
  release();
  await first;
});

test("withLock frees the lock even when the work throws", async () => {
  const s = makeSession();
  await assert.rejects(withLock(s, async () => {
    throw new Error("boom");
  }));
  assert.equal(s.inFlight, undefined);
  assert.equal(await withLock(s, async () => "ok"), "ok");
});

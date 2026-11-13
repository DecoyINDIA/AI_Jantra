import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter } from "./rateLimit.js";

describe("rateLimit", () => {
  it("allows requests up to max and blocks subsequent requests within window", () => {
    let now = 1000;
    const limiter = createFixedWindowLimiter({
      windowMs: 60000,
      max: 3,
      now: () => now,
    });

    const v1 = limiter("client-1");
    assert.equal(v1.allowed, true);
    assert.equal(v1.remaining, 2);

    const v2 = limiter("client-1");
    assert.equal(v2.allowed, true);
    assert.equal(v2.remaining, 1);

    const v3 = limiter("client-1");
    assert.equal(v3.allowed, true);
    assert.equal(v3.remaining, 0);

    const v4 = limiter("client-1");
    assert.equal(v4.allowed, false);
    assert.equal(v4.remaining, 0);
    assert.equal(v4.retryAfterSec, 60);
  });

  it("resets bucket after window expires", () => {
    let now = 1000;
    const limiter = createFixedWindowLimiter({
      windowMs: 60000,
      max: 2,
      now: () => now,
    });

    limiter("client-1");
    limiter("client-1");
    assert.equal(limiter("client-1").allowed, false);

    // Advance clock past window
    now += 60001;
    const vFresh = limiter("client-1");
    assert.equal(vFresh.allowed, true);
    assert.equal(vFresh.remaining, 1);
  });

  it("maintains independent buckets for distinct keys", () => {
    const limiter = createFixedWindowLimiter({
      windowMs: 60000,
      max: 1,
    });

    assert.equal(limiter("ip-1").allowed, true);
    assert.equal(limiter("ip-1").allowed, false);

    assert.equal(limiter("ip-2").allowed, true);
    assert.equal(limiter("ip-2").allowed, false);
  });
});

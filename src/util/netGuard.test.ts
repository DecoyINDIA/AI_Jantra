import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHost, isBlockedAddress } from "./netGuard.js";

describe("netGuard", () => {
  describe("isBlockedAddress", () => {
    it("blocks private IPv4 ranges", () => {
      assert.equal(isBlockedAddress("127.0.0.1"), true);
      assert.equal(isBlockedAddress("10.0.0.1"), true);
      assert.equal(isBlockedAddress("172.16.0.1"), true);
      assert.equal(isBlockedAddress("192.168.1.1"), true);
      assert.equal(isBlockedAddress("169.254.169.254"), true);
    });

    it("blocks test/documentation IPv4 ranges", () => {
      assert.equal(isBlockedAddress("192.0.2.1"), true);
      assert.equal(isBlockedAddress("198.51.100.1"), true);
      assert.equal(isBlockedAddress("203.0.113.1"), true);
    });

    it("blocks loopback and link-local IPv6 ranges", () => {
      assert.equal(isBlockedAddress("::1"), true);
      assert.equal(isBlockedAddress("fe80::1"), true);
      assert.equal(isBlockedAddress("fc00::1"), true);
    });

    it("allows valid public IP addresses", () => {
      assert.equal(isBlockedAddress("8.8.8.8"), false);
      assert.equal(isBlockedAddress("1.1.1.1"), false);
      assert.equal(isBlockedAddress("93.184.216.34"), false);
    });

    it("treats non-IP strings as blocked address", () => {
      assert.equal(isBlockedAddress("example.com"), true);
      assert.equal(isBlockedAddress("not-an-ip"), true);
    });
  });

  describe("assertPublicHost", () => {
    it("rejects forbidden hostnames and suffixes", async () => {
      await assert.rejects(assertPublicHost("localhost"));
      await assert.rejects(assertPublicHost("api.local"));
      await assert.rejects(assertPublicHost("service.internal"));
    });

    it("resolves and approves public hostnames", async () => {
      const ips = await assertPublicHost("example.com");
      assert.ok(Array.isArray(ips) && ips.length > 0);
      for (const ip of ips) {
        assert.equal(isBlockedAddress(ip), false);
      }
    });
  });
});

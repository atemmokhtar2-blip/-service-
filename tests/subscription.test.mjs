import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedChannelMember, isFactoryAdmin } from "../src/subscription.ts";

test("accepts the channel owner and administrators", () => {
  assert.equal(isAllowedChannelMember({ status: "creator" }), true);
  assert.equal(isAllowedChannelMember({ status: "administrator" }), true);
});

test("accepts subscribed members and restricted members only when is_member is true", () => {
  assert.equal(isAllowedChannelMember({ status: "member" }), true);
  assert.equal(isAllowedChannelMember({ status: "restricted", is_member: true }), true);
  assert.equal(isAllowedChannelMember({ status: "restricted", is_member: false }), false);
});

test("rejects users who left or were banned", () => {
  assert.equal(isAllowedChannelMember({ status: "left" }), false);
  assert.equal(isAllowedChannelMember({ status: "kicked" }), false);
});

test("recognizes only explicitly configured factory admin IDs", () => {
  assert.equal(isFactoryAdmin(12345, "12345, 67890"), true);
  assert.equal(isFactoryAdmin(67890, "12345, 67890"), true);
  assert.equal(isFactoryAdmin(99999, "12345, 67890"), false);
  assert.equal(isFactoryAdmin(12345, ""), false);
});

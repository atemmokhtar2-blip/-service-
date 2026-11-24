import test from "node:test";
import assert from "node:assert/strict";
import { githubEditConfigFromEnv } from "../src/github-edit-intake.ts";

test("GitHub edit intake is disabled unless explicitly enabled", () => {
  assert.equal(githubEditConfigFromEnv({}), null);
  assert.equal(githubEditConfigFromEnv({ GITHUB_EDIT_REQUESTS_ENABLED: "false" }), null);
});

test("GitHub edit intake requires a private-repository target, token and explicit cutoff", () => {
  assert.equal(githubEditConfigFromEnv({
    GITHUB_EDIT_REQUESTS_ENABLED: "true",
    GITHUB_EDIT_REQUESTS_REPO: "owner/repo",
    GITHUB_EDIT_REQUESTS_TOKEN: "test-token",
  }), null);
  assert.equal(githubEditConfigFromEnv({
    GITHUB_EDIT_REQUESTS_ENABLED: "true",
    GITHUB_EDIT_REQUESTS_REPO: "not-a-repo",
    GITHUB_EDIT_REQUESTS_TOKEN: "test-token",
    GITHUB_EDIT_REQUESTS_ACTIVATED_AFTER: "2026-11-24T00:00:00.000Z",
  }), null);
});

test("GitHub edit intake accepts a fully configured target", () => {
  const config = githubEditConfigFromEnv({
    GITHUB_EDIT_REQUESTS_ENABLED: "true",
    GITHUB_EDIT_REQUESTS_REPO: "atemmokhtar2-blip/XELVOR-EDIT-REQUESTS",
    GITHUB_EDIT_REQUESTS_TOKEN: "test-token",
    GITHUB_EDIT_REQUESTS_ACTIVATED_AFTER: "2026-11-24T00:00:00.000Z",
  });
  assert.ok(config);
  assert.equal(config.repo, "atemmokhtar2-blip/XELVOR-EDIT-REQUESTS");
  assert.equal(config.activatedAfter.toISOString(), "2026-11-24T00:00:00.000Z");
});

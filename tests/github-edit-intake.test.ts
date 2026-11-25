import test from "node:test";
import assert from "node:assert/strict";
import { githubEditConfigFromEnv } from "../src/github-edit-intake.ts";

test("GitHub edit intake is disabled unless explicitly enabled", () => {
  assert.equal(githubEditConfigFromEnv({}), null);
  assert.equal(githubEditConfigFromEnv({ GITHUB_EDIT_REQUESTS_ENABLED: "false" }), null);
});

test("GitHub edit intake requires a private-repository target, GitHub App credentials and explicit cutoff", () => {
  assert.equal(githubEditConfigFromEnv({
    GITHUB_EDIT_REQUESTS_ENABLED: "true",
    GITHUB_EDIT_REQUESTS_REPO: "owner/repo",
    GITHUB_EDIT_REQUESTS_APP_ID: "12345",
    GITHUB_EDIT_REQUESTS_INSTALLATION_ID: "67890",
    GITHUB_EDIT_REQUESTS_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----",
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
  assert.equal(config.appId, "12345");
  assert.equal(config.installationId, "67890");
  assert.equal(config.activatedAfter.toISOString(), "2026-11-24T00:00:00.000Z");
});

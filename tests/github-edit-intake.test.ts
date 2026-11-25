import test from "node:test";
import assert from "node:assert/strict";
import { githubEditConfigFromEnv } from "../src/github-edit-intake.ts";

const appEnv = {
  GITHUB_EDIT_REQUESTS_ENABLED: "true",
  GITHUB_EDIT_REQUESTS_REPO: "atemmokhtar2-blip/Aat-EDIT-REQUESTS",
  GITHUB_EDIT_REQUESTS_APP_ID: "12345",
  GITHUB_EDIT_REQUESTS_INSTALLATION_ID: "67890",
  GITHUB_EDIT_REQUESTS_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----",
  GITHUB_EDIT_REQUESTS_ACTIVATED_AFTER: "2026-11-24T00:00:00.000Z",
};

test("GitHub edit intake is disabled unless explicitly enabled", () => {
  assert.equal(githubEditConfigFromEnv({}), null);
  assert.equal(githubEditConfigFromEnv({ GITHUB_EDIT_REQUESTS_ENABLED: "false" }), null);
});

test("GitHub edit intake requires complete GitHub App credentials and an explicit cutoff", () => {
  assert.equal(githubEditConfigFromEnv({
    GITHUB_EDIT_REQUESTS_ENABLED: "true",
    GITHUB_EDIT_REQUESTS_REPO: "owner/repo",
    GITHUB_EDIT_REQUESTS_APP_ID: "12345",
    GITHUB_EDIT_REQUESTS_INSTALLATION_ID: "67890",
    GITHUB_EDIT_REQUESTS_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\ntest\\n-----END RSA PRIVATE KEY-----",
  }), null);
  assert.equal(githubEditConfigFromEnv({ ...appEnv, GITHUB_EDIT_REQUESTS_APP_ID: "bad" }), null);
  assert.equal(githubEditConfigFromEnv({ ...appEnv, GITHUB_EDIT_REQUESTS_INSTALLATION_ID: "" }), null);
  assert.equal(githubEditConfigFromEnv({ ...appEnv, GITHUB_EDIT_REQUESTS_REPO: "bad/repo/name" }), null);
});

test("GitHub edit intake accepts the GitHub App configuration", () => {
  const config = githubEditConfigFromEnv(appEnv);
  assert.ok(config);
  assert.equal(config.repo, "atemmokhtar2-blip/Aat-EDIT-REQUESTS");
  assert.equal(config.appId, "12345");
  assert.equal(config.installationId, "67890");
  assert.equal(config.activatedAfter.toISOString(), "2026-11-24T00:00:00.000Z");
  assert.ok(config.privateKey.includes("BEGIN RSA PRIVATE KEY"));
});

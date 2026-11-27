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


test("dedupe lists private-repository issues instead of using Search API", async () => {
  const { findExistingIssue } = await import("../src/github-edit-intake.ts");
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await findExistingIssue(
    { repo: "owner/private-repo", token: "test-token", activatedAfter: new Date("2026-11-24T00:00:00.000Z") },
    "3afcf0a0-ea7d-42ff-a6e8-ce7562752c15",
    fetcher as typeof fetch,
    "2026-11-27T07:00:00.000Z",
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\\/repos\\/owner\\/private-repo\\/issues\\?/);
  assert.match(calls[0], /state=all/);
  assert.match(calls[0], /sort=created/);
  assert.doesNotMatch(calls[0], /search\\/issues/);
});

test("dedupe reuses an existing issue marker and ignores pull requests", async () => {
  const { findExistingIssue } = await import("../src/github-edit-intake.ts");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify([
      { number: 9, html_url: "https://github.com/owner/repo/pull/9", pull_request: {}, body: "<!-- xelvor-edit-request:3afcf0a0-ea7d-42ff-a6e8-ce7562752c15 -->", created_at: "2026-11-27T07:02:00Z" },
      { number: 8, html_url: "https://github.com/owner/repo/issues/8", body: "<!-- xelvor-edit-request:3afcf0a0-ea7d-42ff-a6e8-ce7562752c15 -->", created_at: "2026-11-27T07:01:00Z" }
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await findExistingIssue(
    { repo: "owner/private-repo", token: "test-token", activatedAfter: new Date("2026-11-24T00:00:00.000Z") },
    "3afcf0a0-ea7d-42ff-a6e8-ce7562752c15",
    fetcher as typeof fetch,
    "2026-11-27T07:00:00.000Z",
  );
  assert.equal(result.number, 8);
  assert.equal(calls, 1);
});

test("dedupe paginates and fails closed when the scan cannot be completed", async () => {
  const { findExistingIssue } = await import("../src/github-edit-intake.ts");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    const items = Array.from({ length: 100 }, (_, index) => ({
      number: 1000 - index,
      body: "unrelated",
      created_at: "2026-11-27T07:02:00Z",
    }));
    return new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    findExistingIssue(
      { repo: "owner/private-repo", token: "test-token", activatedAfter: new Date("2026-11-24T00:00:00.000Z") },
      "3afcf0a0-ea7d-42ff-a6e8-ce7562752c15",
      fetcher as typeof fetch,
      "2026-11-27T07:00:00.000Z",
    ),
    /github_edit_dedupe_scan_incomplete/,
  );
  assert.equal(calls, 5);
});

test("GitHub HTTP errors expose only a short sanitized provider message", async () => {
  const { findExistingIssue } = await import("../src/github-edit-intake.ts");
  const secret = "test-secret-token";
  const fetcher = async () => new Response(JSON.stringify({
    message: `Validation Failed: ${secret}\\nextra`,
    errors: [{ message: "invalid query" }],
  }), { status: 422, headers: { "content-type": "application/json" } });
  await assert.rejects(
    findExistingIssue(
      { repo: "owner/private-repo", token: secret, activatedAfter: new Date("2026-11-24T00:00:00.000Z") },
      "3afcf0a0-ea7d-42ff-a6e8-ce7562752c15",
      fetcher as typeof fetch,
      "2026-11-27T07:00:00.000Z",
    ),
    (error: any) => {
      assert.equal(error.status, 422);
      assert.equal(error.providerMessage, "Validation Failed: [redacted] extra");
      assert.doesNotMatch(error.providerMessage, /test-secret-token/);
      return true;
    },
  );
});

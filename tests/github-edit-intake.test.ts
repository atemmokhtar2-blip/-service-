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
  assert.ok(calls[0].includes("/repos/owner/private-repo/issues?"));
  assert.ok(calls[0].includes("state=all"));
  assert.ok(calls[0].includes("sort=created"));
  assert.ok(!calls[0].includes("search/issues"));
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
  assert.equal(calls, 2);
});

test("GitHub HTTP errors expose only a short sanitized provider message", async () => {
  const { findExistingIssue } = await import("../src/github-edit-intake.ts");
  const secret = "test-secret-token";
  const fetcher = async () => new Response(JSON.stringify({
    message: `Validation Failed: ${secret}\nextra`,
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


test("publishing creates once and reuses the same issue after a retry", async () => {
  const { publishIssue } = await import("../src/github-edit-intake.ts");
  const requestId = "3afcf0a0-ea7d-42ff-a6e8-ce7562752c15";
  let storedIssue: any = null;
  let createCount = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/private-repo")) {
      return new Response(JSON.stringify({ private: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/issues?")) {
      return new Response(JSON.stringify(storedIssue ? [storedIssue] : []), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/issues") && init?.method === "POST") {
      createCount++;
      const body = JSON.parse(String(init.body));
      storedIssue = {
        number: 41,
        html_url: "https://github.com/owner/private-repo/issues/41",
        body: body.body,
        created_at: "2026-11-27T07:01:00.000Z",
      };
      return new Response(JSON.stringify(storedIssue), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected_test_request");
  };
  const config = {
    repo: "owner/private-repo",
    token: "test-token",
    activatedAfter: new Date("2026-11-24T00:00:00.000Z"),
  };
  const row = {
    request_id: requestId,
    public_code: "XLV-TEST",
    request_text: "test request",
    payment_source: "free",
    created_at: "2026-11-27T07:00:00.000Z",
    template_key: "test-template",
    bot_username: null,
  };
  const first = await publishIssue(config, row, fetcher as typeof fetch);
  const retry = await publishIssue(config, row, fetcher as typeof fetch);
  assert.equal(first.number, 41);
  assert.equal(retry.number, 41);
  assert.equal(createCount, 1);
});

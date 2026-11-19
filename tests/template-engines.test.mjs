import test from "node:test";
import assert from "node:assert/strict";
import {
  createTemplateRegistry,
  listTemplates,
  TEMPLATE_REGISTRY,
} from "../src/engines/template_registry.js";
import {
  validateProvisionInput,
  validateProvisionResponse,
  validateProvisionStatus,
} from "../src/engines/provision_contract.ts";

const definition = (key) => ({
  key,
  title: `Template ${key}`,
  description: `Description for ${key}`,
  provisionUrlEnv: `${key.toUpperCase().replace(/-/g, "_")}_PROVISION_URL`,
  contractVersion: 1,
  readiness: { kind: "provision-only" },
  requiresPrimaryAdmin: false,
  acceptLegacyResponse: false,
});

test("registry supports more than fifty templates without a switch statement", () => {
  const entries = Array.from({ length: 60 }, (_, index) => definition(`template-${index + 1}`));
  const registry = createTemplateRegistry(entries);
  assert.equal(registry.size, 60);
  assert.equal(registry.get("template-60")?.title, "Template template-60");
});

test("registry rejects duplicate keys and malformed adapter configuration", () => {
  assert.throws(() => createTemplateRegistry([definition("download"), definition("download")]), /duplicate_template_key/);
  assert.throws(() => createTemplateRegistry([{ ...definition("bad/key") }]), /invalid_template_key/);
  assert.throws(() => createTemplateRegistry([{ ...definition("sample"), provisionUrlEnv: "not-safe" }]), /invalid_provision_env/);
  assert.throws(() => createTemplateRegistry([{ ...definition("sample"), readiness: { kind: "http-json", path: "//evil", timeoutMs: 5000 } }]), /invalid_readiness_path/);
});

test("built-in template catalog contains the current three adapters", () => {
  assert.deepEqual(listTemplates().map(item => item.key), ["download", "pre-crime", "marayti"]);
  assert.equal(TEMPLATE_REGISTRY.get("download")?.requiresPrimaryAdmin, true);
  assert.equal(TEMPLATE_REGISTRY.get("download")?.acceptLegacyResponse, false);
  assert.equal(TEMPLATE_REGISTRY.get("marayti")?.acceptLegacyResponse, true);
});

test("provision input validator fails closed on invalid owner, template, or token", () => {
  assert.equal(validateProvisionInput({ ownerId: 12345, templateKey: "download", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ab" }).ok, true);
  assert.equal(validateProvisionInput({ ownerId: 0, templateKey: "download", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ab" }).ok, false);
  assert.equal(validateProvisionInput({ ownerId: 12345, templateKey: "unknown", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ab" }).ok, false);
  assert.equal(validateProvisionInput({ ownerId: 12345, templateKey: "download", token: "not-a-token" }).ok, false);
});

test("adapter result must attest request, bot identity, contract version, and Download owner admin", () => {
  const expected = {
    requestId: "req-123",
    ownerId: 12345,
    botId: 987654321,
    botUsername: "example_download_bot",
    template: TEMPLATE_REGISTRY.get("download"),
  };
  const valid = {
    contract_version: 1,
    request_id: "req-123",
    instance_id: "instance-1",
    bot_id: 987654321,
    bot_username: "example_download_bot",
    status: "provisioning",
    primary_admin_id: 12345,
    owner_admin_confirmed: true,
  };
  assert.equal(validateProvisionResponse(valid, expected).ok, true);
  assert.equal(validateProvisionResponse({ ...valid, request_id: "other" }, expected).ok, false);
  assert.equal(validateProvisionResponse({ ...valid, bot_id: 111 }, expected).ok, false);
  assert.equal(validateProvisionResponse({ ...valid, contract_version: 2 }, expected).ok, false);
  assert.equal(validateProvisionResponse({ ...valid, owner_admin_confirmed: false }, expected).ok, false);
  assert.equal(validateProvisionResponse({ ...valid, primary_admin_id: 9 }, expected).ok, false);
  assert.equal(validateProvisionResponse({ ...valid, status: "success" }, expected).ok, false);
  const legacyTemplate = TEMPLATE_REGISTRY.get("marayti");
  assert.equal(validateProvisionResponse({
    request_id: "req-123", instance_id: "legacy-1", bot_id: 987654321,
    bot_username: "example_download_bot", status: "provisioning",
  }, { ...expected, template: legacyTemplate }).ok, true);
  assert.equal(validateProvisionResponse({
    ...valid, contract_version: undefined,
  }, expected).ok, false);
});


test("status refresh is bound to the same request, bot, and primary owner", () => {
  const expected = {
    requestId: "req-123",
    ownerId: 12345,
    botId: 987654321,
    botUsername: "example_download_bot",
    template: TEMPLATE_REGISTRY.get("download"),
  };
  const valid = {
    contract_version: 1,
    request_id: "req-123",
    instance_id: "instance-1",
    bot_id: 987654321,
    bot_username: "example_download_bot",
    status: "active",
    primary_admin_id: 12345,
    owner_admin_confirmed: true,
  };
  assert.equal(validateProvisionStatus(valid, expected).ok, true);
  assert.equal(validateProvisionStatus({ ...valid, request_id: "other" }, expected).ok, false);
  assert.equal(validateProvisionStatus({ ...valid, bot_id: 999 }, expected).ok, false);
  assert.equal(validateProvisionStatus({ ...valid, primary_admin_id: 999 }, expected).ok, false);
  assert.equal(validateProvisionStatus({ ...valid, owner_admin_confirmed: false }, expected).ok, false);
  assert.equal(validateProvisionStatus({ ...valid, status: "reserved" }, expected).ok, false);
});

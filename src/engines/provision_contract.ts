import { getTemplateDefinition, type TemplateDefinition } from "./template_registry.js";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string };

const TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;

export function validateProvisionInput(input: unknown): ValidationResult<{
  ownerId: number;
  templateKey: string;
  token: string;
  template: TemplateDefinition;
}> {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_PROVISION_INPUT" };
  const value = input as Record<string, unknown>;
  const ownerId = value.ownerId;
  const templateKey = value.templateKey;
  const token = value.token;
  if (typeof ownerId !== "number" || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
    return { ok: false, code: "INVALID_OWNER_ID" };
  }
  if (typeof templateKey !== "string") return { ok: false, code: "INVALID_TEMPLATE_KEY" };
  const template = getTemplateDefinition(templateKey);
  if (!template) return { ok: false, code: "TEMPLATE_NOT_REGISTERED" };
  if (typeof token !== "string" || token.length > 200 || !TOKEN_PATTERN.test(token.trim())) {
    return { ok: false, code: "INVALID_BOT_TOKEN_FORMAT" };
  }
  return {
    ok: true,
    value: { ownerId, templateKey, token: token.trim(), template },
  };
}

export function validateProvisionResponse(
  input: unknown,
  expected: {
    requestId: string;
    ownerId: number;
    botId: number;
    botUsername?: string;
    template: TemplateDefinition;
  },
): ValidationResult<{
  instanceId: string;
  botId: number;
  botUsername?: string;
  status: "active" | "provisioning";
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "SOURCE_RESPONSE_NOT_OBJECT" };
  }
  const value = input as Record<string, unknown>;
  if (value.contract_version === undefined || value.contract_version === null) {
    if (!expected.template.acceptLegacyResponse) {
      return { ok: false, code: "SOURCE_CONTRACT_VERSION_MISMATCH" };
    }
  } else if (value.contract_version !== expected.template.contractVersion) {
    return { ok: false, code: "SOURCE_CONTRACT_VERSION_MISMATCH" };
  }
  if (value.request_id !== expected.requestId) {
    return { ok: false, code: "SOURCE_REQUEST_ID_MISMATCH" };
  }
  if (typeof value.instance_id !== "string" || !value.instance_id.trim() || value.instance_id.length > 128) {
    return { ok: false, code: "SOURCE_INSTANCE_ID_INVALID" };
  }
  if (typeof value.bot_id !== "number" || !Number.isSafeInteger(value.bot_id)
    || value.bot_id <= 0 || value.bot_id !== expected.botId) {
    return { ok: false, code: "SOURCE_BOT_ID_MISMATCH" };
  }
  if (value.bot_username !== undefined && value.bot_username !== null) {
    if (typeof value.bot_username !== "string" || !USERNAME_PATTERN.test(value.bot_username)) {
      return { ok: false, code: "SOURCE_BOT_USERNAME_INVALID" };
    }
    if (expected.botUsername && value.bot_username.toLowerCase() !== expected.botUsername.toLowerCase()) {
      return { ok: false, code: "SOURCE_BOT_USERNAME_MISMATCH" };
    }
  } else if (expected.botUsername) {
    return { ok: false, code: "SOURCE_BOT_USERNAME_MISSING" };
  }
  if (value.status !== "active" && value.status !== "provisioning") {
    return { ok: false, code: "SOURCE_STATUS_INVALID" };
  }
  if (expected.template.requiresPrimaryAdmin) {
    if (value.owner_admin_confirmed !== true) {
      return { ok: false, code: "SOURCE_OWNER_ADMIN_NOT_CONFIRMED" };
    }
    if (value.primary_admin_id !== expected.ownerId) {
      return { ok: false, code: "SOURCE_PRIMARY_ADMIN_MISMATCH" };
    }
  }
  return {
    ok: true,
    value: {
      instanceId: value.instance_id,
      botId: value.bot_id,
      ...(typeof value.bot_username === "string" ? { botUsername: value.bot_username } : {}),
      status: value.status,
    },
  };
}

export function validateProvisionStatus(
  input: unknown,
  expected: {
    requestId: string;
    ownerId: number;
    botId: number;
    botUsername?: string;
    template: TemplateDefinition;
  },
): ValidationResult<{
  instanceId: string;
  botId: number;
  botUsername?: string;
  status: "active" | "provisioning" | "failed";
  errorCode?: string;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "SOURCE_STATUS_NOT_OBJECT" };
  }
  const value = input as Record<string, unknown>;
  if (value.contract_version !== expected.template.contractVersion) {
    return { ok: false, code: "SOURCE_STATUS_CONTRACT_VERSION_MISMATCH" };
  }
  if (value.request_id !== expected.requestId) {
    return { ok: false, code: "SOURCE_STATUS_REQUEST_ID_MISMATCH" };
  }
  if (typeof value.instance_id !== "string" || !value.instance_id.trim() || value.instance_id.length > 128) {
    return { ok: false, code: "SOURCE_STATUS_INSTANCE_ID_INVALID" };
  }
  if (typeof value.bot_id !== "number" || !Number.isSafeInteger(value.bot_id)
    || value.bot_id <= 0 || value.bot_id !== expected.botId) {
    return { ok: false, code: "SOURCE_STATUS_BOT_ID_MISMATCH" };
  }
  if (value.bot_username !== undefined && value.bot_username !== null) {
    if (typeof value.bot_username !== "string" || !USERNAME_PATTERN.test(value.bot_username)) {
      return { ok: false, code: "SOURCE_STATUS_BOT_USERNAME_INVALID" };
    }
    if (expected.botUsername && value.bot_username.toLowerCase() !== expected.botUsername.toLowerCase()) {
      return { ok: false, code: "SOURCE_STATUS_BOT_USERNAME_MISMATCH" };
    }
  } else if (expected.botUsername) {
    return { ok: false, code: "SOURCE_STATUS_BOT_USERNAME_MISSING" };
  }
  if (value.status !== "active" && value.status !== "provisioning" && value.status !== "failed") {
    return { ok: false, code: "SOURCE_STATUS_INVALID" };
  }
  if (expected.template.requiresPrimaryAdmin) {
    if (value.owner_admin_confirmed !== true || value.primary_admin_id !== expected.ownerId) {
      return { ok: false, code: "SOURCE_STATUS_OWNER_ADMIN_MISMATCH" };
    }
  }
  const errorCode = value.error_code;
  if (errorCode !== undefined && errorCode !== null
    && (typeof errorCode !== "string" || !/^[a-z0-9_]{1,80}$/i.test(errorCode))) {
    return { ok: false, code: "SOURCE_STATUS_ERROR_CODE_INVALID" };
  }
  return {
    ok: true,
    value: {
      instanceId: value.instance_id,
      botId: value.bot_id,
      ...(typeof value.bot_username === "string" ? { botUsername: value.bot_username } : {}),
      status: value.status,
      ...(typeof errorCode === "string" ? { errorCode } : {}),
    },
  };
}

export function validateProvisionUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!isLoopback && url.protocol !== "https:") || (isLoopback && !["http:", "https:"].includes(url.protocol))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export async function checkTemplateReadiness(
  baseUrl: URL,
  template: TemplateDefinition,
  fetcher: typeof fetch = fetch,
): Promise<ValidationResult<true>> {
  if (template.readiness.kind === "provision-only") return { ok: true, value: true };
  const url = new URL(template.readiness.path, baseUrl.origin);
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(template.readiness.timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, code: "SOURCE_HEALTH_HTTP_ERROR" };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).ready !== true) {
      return { ok: false, code: "SOURCE_NOT_READY" };
    }
    return { ok: true, value: true };
  } catch {
    return { ok: false, code: "SOURCE_HEALTH_UNREACHABLE" };
  }
}

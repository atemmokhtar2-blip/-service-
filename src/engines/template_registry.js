const TEMPLATE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{2,79}$/;

function assertDefinition(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_template_definition");
  if (typeof input.key !== "string" || input.key.length > 48 || !TEMPLATE_KEY.test(input.key)) {
    throw new Error("invalid_template_key");
  }
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 100) {
    throw new Error("invalid_template_title");
  }
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 1000) {
    throw new Error("invalid_template_description");
  }
  if (typeof input.provisionUrlEnv !== "string" || !ENV_KEY.test(input.provisionUrlEnv)) {
    throw new Error("invalid_provision_env");
  }
  if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) {
    throw new Error("invalid_contract_version");
  }
  if (typeof input.requiresPrimaryAdmin !== "boolean") throw new Error("invalid_primary_admin_policy");
  if (typeof input.acceptLegacyResponse !== "boolean") throw new Error("invalid_legacy_response_policy");
  if (input.readiness?.kind === "http-json") {
    const path = input.readiness.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")
      || path.includes("..") || path.includes("\\") || /[?#\\s]/.test(path)) {
      throw new Error("invalid_readiness_path");
    }
    if (!Number.isSafeInteger(input.readiness.timeoutMs)
      || input.readiness.timeoutMs < 1000 || input.readiness.timeoutMs > 30000) {
      throw new Error("invalid_readiness_timeout");
    }
  } else if (input.readiness?.kind !== "provision-only") {
    throw new Error("invalid_readiness_policy");
  }
  return Object.freeze({ ...input, readiness: Object.freeze({ ...input.readiness }) });
}

export function createTemplateRegistry(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) throw new Error("empty_template_registry");
  const registry = new Map();
  for (const raw of definitions) {
    const definition = assertDefinition(raw);
    if (registry.has(definition.key)) throw new Error("duplicate_template_key");
    registry.set(definition.key, definition);
  }
  return registry;
}

const BUILTIN_TEMPLATES = [
  {
    key: "download",
    title: "بوت التحميل",
    description: "تحميل الوسائط من المنصات المدعومة",
    provisionUrlEnv: "DOWNLOAD_PROVISION_URL",
    contractVersion: 1,
    readiness: { kind: "http-json", path: "/health", timeoutMs: 8000 },
    requiresPrimaryAdmin: true,
    acceptLegacyResponse: false,
  },
  {
    key: "pre-crime",
    title: "بوت الحماية",
    description: "إدارة وحماية مجموعات تيليجرام",
    provisionUrlEnv: "PRECRIME_PROVISION_URL",
    contractVersion: 1,
    readiness: { kind: "provision-only" },
    requiresPrimaryAdmin: false,
    acceptLegacyResponse: true,
  },
  {
    key: "marayti",
    title: "بوت مرايتي",
    description: "نظام المراسلة المجهولة",
    provisionUrlEnv: "MARAYTI_PROVISION_URL",
    contractVersion: 1,
    readiness: { kind: "provision-only" },
    requiresPrimaryAdmin: false,
    acceptLegacyResponse: true,
  },
];

export const TEMPLATE_REGISTRY = createTemplateRegistry(BUILTIN_TEMPLATES);

export function getTemplateDefinition(key) {
  return TEMPLATE_REGISTRY.get(key);
}

export function listTemplates() {
  return Object.freeze(Array.from(TEMPLATE_REGISTRY.values()));
}

export function templateMenuRecord() {
  return Object.freeze(Object.fromEntries(
    listTemplates().map(({ key, title, description }) => [key, Object.freeze({ title, description })]),
  ));
}

export type ReadinessPolicy =
  | { readonly kind: "provision-only" }
  | { readonly kind: "http-json"; readonly path: string; readonly timeoutMs: number };

export type TemplateDefinition = {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly provisionUrlEnv: string;
  readonly contractVersion: number;
  readonly readiness: ReadinessPolicy;
  readonly requiresPrimaryAdmin: boolean;
  readonly acceptLegacyResponse: boolean;
};

export function createTemplateRegistry(
  definitions: readonly TemplateDefinition[],
): ReadonlyMap<string, TemplateDefinition>;

export const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateDefinition>;
export function getTemplateDefinition(key: string): TemplateDefinition | undefined;
export function listTemplates(): readonly TemplateDefinition[];
export function templateMenuRecord(): Readonly<Record<string, { title: string; description: string }>>;

const SAFE_DIAGNOSTIC_CODE = /^[a-z0-9_]{3,60}$/i;

/** Only allow short machine codes into logs; never log arbitrary upstream text. */
export function diagnosticCode(value: unknown): string {
  if (typeof value === "string" && SAFE_DIAGNOSTIC_CODE.test(value)) return value;
  return "UNCLASSIFIED";
}

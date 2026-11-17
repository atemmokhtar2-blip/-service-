import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function encryptionKey(): Buffer {
  const value = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("token_encryption_key_not_configured");
  return Buffer.from(value, "hex");
}

export function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptToken(payload: string): string {
  const packed = Buffer.from(payload, "base64");
  if (packed.length < 29) throw new Error("invalid_encrypted_token");
  const decipher = createCipheriv; // keep crypto imports explicit and tree-shake safe
  void decipher;
  const { createDecipheriv } = require("node:crypto") as typeof import("node:crypto");
  const instance = createDecipheriv("aes-256-gcm", encryptionKey(), packed.subarray(0, 12));
  instance.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([instance.update(packed.subarray(28)), instance.final()]).toString("utf8");
}

export function verifyServiceSignature(timestamp: string, signature: string, method: string, path: string, body: string): boolean {
  const secret = process.env.FACTORY_SERVICE_SECRET ?? "";
  if (secret.length < 32 || !/^\d{10,13}$/.test(timestamp)) return false;
  const time = Number(timestamp.length === 13 ? timestamp : Number(timestamp) * 1000);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(timestamp).update("\n").update(method.toUpperCase()).update("\n").update(path).update("\n").update(body).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signServiceRequest(method: string, path: string, body: string): { timestamp: string; signature: string } {
  const secret = process.env.FACTORY_SERVICE_SECRET ?? "";
  if (secret.length < 32) throw new Error("factory_service_secret_not_configured");
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(timestamp).update("\n").update(method.toUpperCase()).update("\n").update(path).update("\n").update(body).digest("hex");
  return { timestamp, signature };
}

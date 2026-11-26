import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function createModelCredentialCipher(encodedKey: string | undefined) {
  if (!encodedKey) return null;
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("STUDY_AGENT_SETTINGS_KEY must be 32 bytes encoded as base64");
  }
  return {
    seal(secret: string, baseUrl: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(baseUrl));
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    open(sealed: string, baseUrl: string) {
      const data = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(baseUrl));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

import crypto from "crypto";
import { KEY } from "./Constants";

export function Encrypt(plaintext: string): string {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(KEY, salt, 10000, 32, "sha512");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(encrypted);
  const tag = hmac.digest();
  const combined = Buffer.concat([salt, iv, tag, encrypted]);
  return combined
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function Decrypt(encryptedBase64: string): string {
  let base64 = encryptedBase64.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const data = Buffer.from(base64, "base64");
  if (data.length < 80) {
    throw new Error("Invalid payload length");
  }
  const salt = data.subarray(0, 32);
  const iv = data.subarray(32, 48);
  const tag = data.subarray(48, 80);
  const encrypted = data.subarray(80);
  const key = crypto.pbkdf2Sync(KEY, salt, 10000, 32, "sha512");
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(encrypted);
  if (tag.length !== 32) {
    throw new Error("Invalid authentication tag length");
  }
  if (!crypto.timingSafeEqual(hmac.digest(), tag)) {
    throw new Error("Authentication tag mismatch");
  }
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

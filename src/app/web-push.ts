import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

// Web Push with only node:crypto: the message is encrypted for one browser (RFC 8291, aes128gcm) and the request is
// signed by this server (VAPID, RFC 8292).

export interface PushSubscriptionKeys {
  endpoint: string;
  // The browser's P-256 public key, uncompressed, and its 16-byte authentication secret, both base64url.
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  // A mailto: or https: contact the push service can reach about this server.
  subject: string;
}

const b64 = (value: string) => Buffer.from(value, "base64url");
const recordSize = 4096;

function newSender() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, salt: randomBytes(16) };
}

// The sender's key pair and salt are new for every message; tests pass fixed ones to check the RFC example.
export function encryptPushMessage(plaintext: Buffer, keys: Pick<PushSubscriptionKeys, "p256dh" | "auth">, sender = newSender()) {
  const { ecdh, salt } = sender;
  const receiverPublic = b64(keys.p256dh);
  const senderPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, b64(keys.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // One record, ended by the 0x02 delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}

// A signed token for the push service at the endpoint's origin, valid for twelve hours.
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()) {
  const publicKey = b64(vapid.publicKey);
  const key = createPrivateKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", d: vapid.privateKey,
    x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33, 65).toString("base64url"),
  } });
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${unsigned}.${signature}, k=${vapid.publicKey}`;
}

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") };
}

export type PushResult = "sent" | "gone" | "failed";

// Sends one message. A 404 or 410 means the browser dropped the subscription, so it should be forgotten.
export async function sendPush(
  subscription: PushSubscriptionKeys, message: object, vapid: VapidKeys, fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const response = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(24 * 3600), Urgency: "normal",
    },
    body: encryptPushMessage(Buffer.from(JSON.stringify(message)), subscription),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) return "failed";
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "sent" : "failed";
}

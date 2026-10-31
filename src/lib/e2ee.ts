const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PRIVATE_KEY_AAD = (userId: string) => encoder.encode("vyra-e2ee-private-v1:" + userId);

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export type E2EEIdentity = {
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
};

export type StoredE2EEIdentity = {
  publicKey: JsonWebKey;
  wrappedPrivateKey: string;
  salt: string;
  iv: string;
  keyVersion: number;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  if (password.length < 10) throw new Error("Use your VYRA password (at least 10 characters).");
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createE2EEIdentity(userId: string, password: string): Promise<{
  identity: E2EEIdentity;
  stored: StoredE2EEIdentity;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(password, salt);
  const privateBytes = encoder.encode(JSON.stringify(privateJwk));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(PRIVATE_KEY_AAD(userId)) },
    wrappingKey,
    privateBytes
  );
  const lockedPrivateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  return {
    identity: { privateKey: lockedPrivateKey, publicKey },
    stored: {
      publicKey,
      wrappedPrivateKey: toBase64(new Uint8Array(wrapped)),
      salt: toBase64(salt),
      iv: toBase64(iv),
      keyVersion: 1
    }
  };
}

export async function unlockE2EEIdentity(
  userId: string,
  password: string,
  stored: StoredE2EEIdentity
): Promise<E2EEIdentity> {
  try {
    const salt = fromBase64(stored.salt);
    const iv = fromBase64(stored.iv);
    const wrappingKey = await deriveWrappingKey(password, salt);
    const privateBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(PRIVATE_KEY_AAD(userId)) },
      wrappingKey,
      asArrayBuffer(fromBase64(stored.wrappedPrivateKey))
    );
    const privateJwk = JSON.parse(decoder.decode(privateBytes)) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    return { privateKey, publicKey: stored.publicKey };
  } catch {
    throw new Error("That password could not unlock this account's encrypted messaging key.");
  }
}

export async function deriveConversationKey(
  identity: E2EEIdentity,
  peerPublicKey: JsonWebKey,
  conversationId: string
): Promise<CryptoKey> {
  const peerKey = await crypto.subtle.importKey(
    "jwk",
    peerPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    identity.privateKey,
    256
  ));
  try {
    const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("vyra-dm-e2ee-v1"),
        info: encoder.encode("conversation:" + conversationId)
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    sharedBits.fill(0);
  }
}

export async function encryptText(value: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("vyra-message-v1") },
    key,
    encoder.encode(value)
  );
  return "vyra1." + toBase64(iv) + "." + toBase64(new Uint8Array(cipher));
}

export async function decryptText(value: string, key: CryptoKey): Promise<string> {
  const [version, encodedIv, encodedCipher] = value.split(".");
  if (version !== "vyra1" || !encodedIv || !encodedCipher) {
    throw new Error("This message was sent before encrypted messaging was enabled.");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(encodedIv)), additionalData: asArrayBuffer(encoder.encode("vyra-message-v1")) },
    key,
    asArrayBuffer(fromBase64(encodedCipher))
  );
  return decoder.decode(plain);
}

export async function encryptFile(file: Blob, key: CryptoKey, conversationId: string): Promise<{
  blob: Blob;
  iv: string;
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(await file.arrayBuffer());
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("vyra-file-v1:" + conversationId) },
    key,
    plain
  );
  plain.fill(0);
  return { blob: new Blob([cipher], { type: "application/octet-stream" }), iv: toBase64(iv) };
}

export async function decryptFile(blob: Blob, iv: string, key: CryptoKey, conversationId: string, mimeType: string): Promise<Blob> {
  const cipher = await blob.arrayBuffer();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(iv)), additionalData: asArrayBuffer(encoder.encode("vyra-file-v1:" + conversationId)) },
    key,
    cipher
  );
  return new Blob([plain], { type: mimeType || "application/octet-stream" });
}

export function isEncryptedEnvelope(value: string): boolean {
  return /^vyra1\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/.test(value);
}

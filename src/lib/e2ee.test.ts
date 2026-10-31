import { describe, expect, it } from "vitest";
import {
  createE2EEIdentity,
  unlockE2EEIdentity,
  deriveConversationKey,
  encryptText,
  decryptText,
  encryptFile,
  decryptFile,
} from "./e2ee";

describe("VYRA end-to-end encryption", () => {
  it("allows both participants to derive the same conversation key without exporting private keys", async () => {
    const alice = await createE2EEIdentity("alice-test", "correct horse battery staple");
    const bob = await createE2EEIdentity("bob-test", "another secure passphrase");

    expect(alice.identity.privateKey.extractable).toBe(false);
    expect(bob.identity.privateKey.extractable).toBe(false);

    const aliceKey = await deriveConversationKey(alice.identity, bob.identity.publicKey, "conversation-test");
    const bobKey = await deriveConversationKey(bob.identity, alice.identity.publicKey, "conversation-test");
    const ciphertext = await encryptText("hello from Alice", aliceKey);

    expect(ciphertext).toMatch(/^vyra1\./);
    await expect(decryptText(ciphertext, bobKey)).resolves.toBe("hello from Alice");
  });

  it("rejects a wrong VYRA password when unlocking the wrapped private key", async () => {
    const created = await createE2EEIdentity("alice-test", "correct horse battery staple");
    await expect(
      unlockE2EEIdentity("alice-test", "this is the wrong password", created.stored)
    ).rejects.toThrow(/could not unlock/i);
  });

  it("encrypts photos and voice-note blobs before they leave the device", async () => {
    const alice = await createE2EEIdentity("alice-test", "correct horse battery staple");
    const bob = await createE2EEIdentity("bob-test", "another secure passphrase");
    const aliceKey = await deriveConversationKey(alice.identity, bob.identity.publicKey, "conversation-media");
    const bobKey = await deriveConversationKey(bob.identity, alice.identity.publicKey, "conversation-media");

    const original = new Blob(["private audio payload"], { type: "audio/webm" });
    const encrypted = await encryptFile(original, aliceKey, "conversation-media");
    expect(await encrypted.blob.text()).not.toContain("private audio payload");

    const opened = await decryptFile(
      encrypted.blob,
      encrypted.iv,
      bobKey,
      "conversation-media",
      "audio/webm"
    );
    await expect(opened.text()).resolves.toBe("private audio payload");
    expect(opened.type).toBe("audio/webm");
  });

  it("cannot decrypt a message using a different conversation key", async () => {
    const alice = await createE2EEIdentity("alice-test", "correct horse battery staple");
    const bob = await createE2EEIdentity("bob-test", "another secure passphrase");
    const aliceKey = await deriveConversationKey(alice.identity, bob.identity.publicKey, "conversation-one");
    const wrongKey = await deriveConversationKey(bob.identity, alice.identity.publicKey, "conversation-two");
    const ciphertext = await encryptText("secret", aliceKey);
    await expect(decryptText(ciphertext, wrongKey)).rejects.toThrow();
  });
});

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import {
  decryptFile,
  decryptString,
  encryptFile,
  encryptString,
  generateIdentity,
  identityToRecipient,
} from "../encryptor";

// Defensive re-install of the real node:fs/promises — see migrate.test.ts
// for the full explanation of the bleed this guards against.
{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

describe("encryptor", () => {
  // T004 — generateIdentity + identityToRecipient

  test("generateIdentity returns an AGE-SECRET-KEY-1 string", async () => {
    const identity = await generateIdentity();
    expect(identity).toStartWith("AGE-SECRET-KEY-1");
  });

  test("identityToRecipient returns an age1 public key", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    expect(recipient).toStartWith("age1");
    expect(recipient.length).toBeGreaterThan(10);
  });

  test("different calls to generateIdentity produce distinct keys", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a).not.toBe(b);
  });

  // T005 — encryptString / decryptString round-trip

  test("encryptString output starts with AGE armor header", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const armored = await encryptString("hello", [recipient]);
    expect(armored).toContain("-----BEGIN AGE ENCRYPTED FILE-----");
  });

  test("encryptString + decryptString round-trips plaintext", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "my secret config value";
    const armored = await encryptString(plaintext, [recipient]);
    const decrypted = await decryptString(armored, identity);
    expect(decrypted).toBe(plaintext);
  });

  test("encryptString with two recipients decrypts with either key", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const rec1 = await identityToRecipient(id1);
    const rec2 = await identityToRecipient(id2);
    const plaintext = "shared secret";
    const armored = await encryptString(plaintext, [rec1, rec2]);
    expect(await decryptString(armored, id1)).toBe(plaintext);
    expect(await decryptString(armored, id2)).toBe(plaintext);
  });

  test("encryptString throws when recipients array is empty", async () => {
    await expect(encryptString("data", [])).rejects.toThrow(
      "No recipients configured for encryption",
    );
  });

  // T006 — wrong key

  test("decryptString throws when wrong identity is used", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const rec1 = await identityToRecipient(id1);
    const armored = await encryptString("secret", [rec1]);
    await expect(decryptString(armored, id2)).rejects.toThrow();
  });

  // T007 — encryptFile / decryptFile

  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    // Cleanup is done once in afterAll — keep individual tests isolated here
  });

  test("encryptFile + decryptFile round-trips a text file", async () => {
    const inputPath = join(tmpDir, "plain.txt");
    const encryptedPath = join(tmpDir, "plain.txt.age");
    const decryptedPath = join(tmpDir, "plain.decrypted.txt");
    const content = "file content line 1\nfile content line 2\n";

    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    await writeFile(inputPath, content, "utf8");
    await encryptFile(inputPath, encryptedPath, [recipient]);
    await decryptFile(encryptedPath, decryptedPath, identity);

    const result = await Bun.file(decryptedPath).text();
    expect(result).toBe(content);
  });
});

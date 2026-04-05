import { readFile, writeFile } from "node:fs/promises";
import * as age from "age-encryption";

/**
 * Encrypt a plaintext string for one or more age X25519 recipients.
 * The output is ASCII-armored so it can be stored as a UTF-8 text file.
 *
 * @param plaintext  UTF-8 string to encrypt
 * @param recipients One or more age X25519 public keys (age1…)
 * @returns ASCII-armored age ciphertext
 */
export async function encryptString(plaintext: string, recipients: string[]): Promise<string> {
  if (recipients.length === 0) {
    throw new Error("No recipients configured for encryption");
  }

  const enc = new age.Encrypter();
  for (const recipient of recipients) {
    enc.addRecipient(recipient);
  }

  const ciphertext = await enc.encrypt(plaintext);
  return age.armor.encode(ciphertext);
}

/**
 * Decrypt an ASCII-armored age ciphertext using a private (identity) key.
 *
 * @param armored   ASCII-armored age ciphertext (-----BEGIN AGE ENCRYPTED FILE-----)
 * @param identity  age identity string (AGE-SECRET-KEY-1…)
 * @returns Decrypted UTF-8 plaintext
 */
export async function decryptString(armored: string, identity: string): Promise<string> {
  const dec = new age.Decrypter();
  dec.addIdentity(identity);
  const ciphertext = age.armor.decode(armored);
  return dec.decrypt(ciphertext, "text");
}

/**
 * Generate a new age X25519 identity (private key) string.
 * Returns the AGE-SECRET-KEY-1… identity string.
 */
export async function generateIdentity(): Promise<string> {
  return age.generateIdentity();
}

/**
 * Derive the age X25519 public key (recipient) from an identity string.
 */
export async function identityToRecipient(identity: string): Promise<string> {
  return age.identityToRecipient(identity);
}

/** Encrypt a UTF-8 file and write the armored ciphertext to disk. */
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  recipients: string[],
): Promise<void> {
  const raw = await readFile(inputPath, "utf8");
  const encrypted = await encryptString(raw, recipients);
  await writeFile(outputPath, encrypted, "utf8");
}

/** Decrypt an armored age file and write the plaintext back to disk. */
export async function decryptFile(
  inputPath: string,
  outputPath: string,
  identity: string,
): Promise<void> {
  const encrypted = await readFile(inputPath, "utf8");
  const decrypted = await decryptString(encrypted, identity);
  await writeFile(outputPath, decrypted, "utf8");
}

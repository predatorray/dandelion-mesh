import test from 'ava';

import {
  arrayBufferToHex,
  decrypt,
  encrypt,
  EncryptedPayload,
  generateKeyBundle,
  hexToArrayBuffer,
  importPublicKey,
} from './CryptoService';

// Use a small modulus to keep tests fast; 2048 is the minimum for RSA-OAEP.
const MODULUS = 2048;

// ---------------------------------------------------------------------------
// Hex utilities
// ---------------------------------------------------------------------------

test('arrayBufferToHex converts empty buffer', (t) => {
  t.is(arrayBufferToHex(new ArrayBuffer(0)), '');
});

test('arrayBufferToHex converts known bytes', (t) => {
  const buf = new Uint8Array([0x00, 0x0f, 0xff, 0xab]).buffer;
  t.is(arrayBufferToHex(buf), '000fffab');
});

test('hexToArrayBuffer converts empty string', (t) => {
  const buf = hexToArrayBuffer('');
  t.is(buf.byteLength, 0);
});

test('hexToArrayBuffer converts known hex', (t) => {
  const buf = hexToArrayBuffer('000fffab');
  t.deepEqual(new Uint8Array(buf), new Uint8Array([0x00, 0x0f, 0xff, 0xab]));
});

test('hex round-trip', (t) => {
  const original = new Uint8Array([1, 2, 3, 127, 128, 255]);
  const hex = arrayBufferToHex(original.buffer);
  const restored = new Uint8Array(hexToArrayBuffer(hex));
  t.deepEqual(restored, original);
});

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

test('generateKeyBundle produces keys and JWK', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);

  t.truthy(bundle.publicKey);
  t.truthy(bundle.privateKey);
  t.truthy(bundle.publicKeyJwk);
  t.is(bundle.publicKeyJwk.kty, 'RSA');
  t.is(bundle.publicKeyJwk.alg, 'RSA-OAEP-256');
});

test('two generated bundles have different keys', async (t) => {
  const a = await generateKeyBundle(MODULUS);
  const b = await generateKeyBundle(MODULUS);
  t.notDeepEqual(a.publicKeyJwk.n, b.publicKeyJwk.n);
});

// ---------------------------------------------------------------------------
// importPublicKey
// ---------------------------------------------------------------------------

test('importPublicKey produces a usable CryptoKey', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const imported = await importPublicKey(bundle.publicKeyJwk);

  t.is(imported.type, 'public');
  t.is(imported.algorithm.name, 'RSA-OAEP');
  t.deepEqual(imported.usages, ['encrypt']);
});

// ---------------------------------------------------------------------------
// Encrypt / Decrypt round-trip
// ---------------------------------------------------------------------------

test('encrypt then decrypt recovers plaintext', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('hello dandelion-mesh');

  const payload = await encrypt(plaintext, bundle.publicKey);
  const recovered = await decrypt(payload, bundle.privateKey);

  t.deepEqual(recovered, plaintext);
});

test('encrypt then decrypt with imported public key', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const imported = await importPublicKey(bundle.publicKeyJwk);
  const plaintext = new TextEncoder().encode('imported key test');

  const payload = await encrypt(plaintext, imported);
  const recovered = await decrypt(payload, bundle.privateKey);

  t.deepEqual(recovered, plaintext);
});

test('encrypt then decrypt works for empty plaintext', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new Uint8Array(0);

  const payload = await encrypt(plaintext, bundle.publicKey);
  const recovered = await decrypt(payload, bundle.privateKey);

  t.deepEqual(recovered, plaintext);
});

test('encrypt then decrypt works for large plaintext', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new Uint8Array(10_000);
  crypto.getRandomValues(plaintext);

  const payload = await encrypt(plaintext, bundle.publicKey);
  const recovered = await decrypt(payload, bundle.privateKey);

  t.deepEqual(recovered, plaintext);
});

// ---------------------------------------------------------------------------
// Encrypt output structure
// ---------------------------------------------------------------------------

test('encrypted payload has expected hex fields', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('structure test');

  const payload = await encrypt(plaintext, bundle.publicKey);

  t.true(typeof payload.encryptedKey === 'string');
  t.true(typeof payload.iv === 'string');
  t.true(typeof payload.ciphertext === 'string');
  // All fields should be valid hex (even length, hex chars only)
  for (const field of [payload.encryptedKey, payload.iv, payload.ciphertext]) {
    t.regex(field, /^([0-9a-f]{2})*$/);
  }
  // IV should be 12 bytes = 24 hex chars
  t.is(payload.iv.length, 24);
});

test('encrypting same plaintext twice produces different ciphertexts', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('nonce test');

  const a = await encrypt(plaintext, bundle.publicKey);
  const b = await encrypt(plaintext, bundle.publicKey);

  // Different AES keys and IVs each time
  t.not(a.encryptedKey, b.encryptedKey);
  t.not(a.iv, b.iv);
  t.not(a.ciphertext, b.ciphertext);
});

// ---------------------------------------------------------------------------
// Decryption with wrong key fails
// ---------------------------------------------------------------------------

test('decrypt with wrong private key throws', async (t) => {
  const alice = await generateKeyBundle(MODULUS);
  const bob = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('for alice only');

  const payload = await encrypt(plaintext, alice.publicKey);

  await t.throwsAsync(() => decrypt(payload, bob.privateKey));
});

test('decrypt with tampered ciphertext throws', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('integrity test');

  const payload = await encrypt(plaintext, bundle.publicKey);
  // Flip a byte in the ciphertext
  const tampered: EncryptedPayload = {
    ...payload,
    ciphertext:
      payload.ciphertext.slice(0, -2) +
      (payload.ciphertext.slice(-2) === '00' ? 'ff' : '00'),
  };

  await t.throwsAsync(() => decrypt(tampered, bundle.privateKey));
});

test('decrypt with tampered IV throws', async (t) => {
  const bundle = await generateKeyBundle(MODULUS);
  const plaintext = new TextEncoder().encode('iv test');

  const payload = await encrypt(plaintext, bundle.publicKey);
  const tampered: EncryptedPayload = {
    ...payload,
    iv: payload.iv.slice(0, -2) + (payload.iv.slice(-2) === '00' ? 'ff' : '00'),
  };

  await t.throwsAsync(() => decrypt(tampered, bundle.privateKey));
});

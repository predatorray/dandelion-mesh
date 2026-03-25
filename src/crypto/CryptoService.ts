/**
 * RSA-OAEP + AES-GCM hybrid encryption service.
 *
 * RSA is used to encrypt a random AES session key, and AES-GCM encrypts the
 * actual payload. This avoids RSA plaintext size limits while providing
 * authenticated encryption for the message body.
 */

const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12;
const RSA_HASH = 'SHA-256';

export interface CryptoKeyBundle {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** JWK export of the public key, suitable for broadcasting */
  publicKeyJwk: JsonWebKey;
}

export interface EncryptedPayload {
  /** RSA-encrypted AES key (hex) */
  encryptedKey: string;
  /** AES-GCM initialization vector (hex) */
  iv: string;
  /** AES-GCM ciphertext (hex) */
  ciphertext: string;
}

/** Generate an RSA-OAEP key pair and export the public key as JWK */
export async function generateKeyBundle(
  modulusLength = 4096
): Promise<CryptoKeyBundle> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: RSA_HASH,
    },
    true,
    ['encrypt', 'decrypt']
  );
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyJwk,
  };
}

/** Import a peer's public key from its JWK representation */
export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: RSA_HASH },
    false,
    ['encrypt']
  );
}

/** Encrypt arbitrary data with a recipient's RSA public key (hybrid encryption) */
export async function encrypt(
  plaintext: Uint8Array,
  recipientPublicKey: CryptoKey
): Promise<EncryptedPayload> {
  // Generate random AES key
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true,
    ['encrypt']
  );

  // Encrypt the AES key with RSA
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedAesKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    recipientPublicKey,
    rawAesKey
  );

  // Encrypt the plaintext with AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );

  return {
    encryptedKey: arrayBufferToHex(encryptedAesKey),
    iv: arrayBufferToHex(iv.buffer),
    ciphertext: arrayBufferToHex(ciphertext),
  };
}

/** Decrypt a hybrid-encrypted payload with the recipient's RSA private key */
export async function decrypt(
  payload: EncryptedPayload,
  privateKey: CryptoKey
): Promise<Uint8Array> {
  // Decrypt the AES key with RSA
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    hexToArrayBuffer(payload.encryptedKey)
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    rawAesKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['decrypt']
  );

  // Decrypt the ciphertext with AES-GCM
  const iv = hexToArrayBuffer(payload.iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    hexToArrayBuffer(payload.ciphertext)
  );

  return new Uint8Array(plaintext);
}

// --- Hex conversion utilities ---

export function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

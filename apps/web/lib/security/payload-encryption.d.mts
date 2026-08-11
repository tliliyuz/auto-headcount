export type EncryptedJsonPayload = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: string;
  payloadHash: string;
};

export function encryptJsonPayload(
  value: unknown,
  options: { key: string; keyVersion: string },
): Promise<EncryptedJsonPayload>;

export function decryptJsonPayload(
  payload: Pick<EncryptedJsonPayload, "ciphertext" | "nonce">,
  options: { key: string },
): Promise<unknown>;

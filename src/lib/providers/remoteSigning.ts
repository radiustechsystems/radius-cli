import { keccak256, parseSignature, serializeTransaction, type Hex, type TransactionSerializable } from 'viem';

export async function signLegacyTransaction(
  tx: unknown,
  signHash: (hash: Hex) => Promise<Hex>,
): Promise<Hex> {
  const transaction = tx as TransactionSerializable;
  const serialized = serializeTransaction(transaction);
  const signature = await signHash(keccak256(serialized));
  return serializeTransaction(transaction, parseSignature(signature)) as Hex;
}

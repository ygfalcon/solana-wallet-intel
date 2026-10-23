import { base58 } from "@scure/base";

export function isSolanaAddress(value: string): boolean {
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

declare module "circomlibjs" {
  interface PoseidonF {
    toObject(el: Uint8Array): bigint;
    fromObject(n: bigint): Uint8Array;
    toString(el: Uint8Array, radix?: number): string;
    e(n: bigint | number | string): Uint8Array;
    zero: Uint8Array;
    one: Uint8Array;
    p: bigint;
  }

  interface Poseidon {
    (inputs: bigint[]): Uint8Array;
    F: PoseidonF;
  }

  export function buildPoseidon(): Promise<Poseidon>;
  export function buildEddsa(): Promise<any>;
  export function buildBabyjub(): Promise<any>;
  export function buildMimc7(): Promise<any>;
  export function buildMimcSponge(): Promise<any>;
}

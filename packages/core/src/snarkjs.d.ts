declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasmFileOrDir: string | Uint8Array,
      zkeyFileOrBuffer: string | Uint8Array,
    ): Promise<{ proof: any; publicSignals: string[] }>;

    verify(vkey: any, publicSignals: string[], proof: any): Promise<boolean>;
  };
}

// Type declarations for optional dependencies
// These are loaded dynamically with graceful degradation
declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: { quantized?: boolean }
  ): Promise<any>
}

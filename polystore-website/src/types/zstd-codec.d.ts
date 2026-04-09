declare module 'zstd-codec' {
  type ZstdModule = {
    Simple: new () => {
      compress: (input: Uint8Array) => Uint8Array
      decompress: (input: Uint8Array) => Uint8Array
    }
  }

  export const ZstdCodec: {
    run: (cb: (zstd: ZstdModule) => void) => void
  }
}

export const POLYFS_ROOT_BYTES = 32

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

export function polyfsRootHexFromMdu0Root(mdu0Root: Uint8Array): string {
  if (!(mdu0Root instanceof Uint8Array)) {
    throw new Error('PolyFS root must be a Uint8Array')
  }
  if (mdu0Root.byteLength !== POLYFS_ROOT_BYTES) {
    throw new Error(`PolyFS root must be ${POLYFS_ROOT_BYTES} bytes; got ${mdu0Root.byteLength}`)
  }
  return `0x${Array.from(mdu0Root, hexByte).join('')}`
}


// Independent wire fixture: no producer/parser helpers are used for encoding.
export function polyfsMetadataFixture(records: Array<{ path: string; start?: bigint; size?: bigint; flags?: number; timestamp?: bigint }> = []): Uint8Array {
  const mdu = new Uint8Array(8 * 1024 * 1024)
  const logical = new Uint8Array(48 * 128 * 1024 / 32 * 31)
  const view = new DataView(logical.buffer)
  logical.set([78, 73, 76, 70, 2, 0, 0, 1])
  view.setUint32(8, records.length, true)
  records.forEach((record, index) => {
    const offset = 128 + index * 256
    view.setBigUint64(offset, record.start ?? 0n, true)
    view.setBigUint64(offset + 8, (BigInt(record.flags ?? 0) << 56n) | (record.size ?? 0n), true)
    view.setBigUint64(offset + 16, record.timestamp ?? 0n, true)
    const path = new TextEncoder().encode(record.path)
    if (path.length > 232) throw new Error('fixture path too long')
    logical.set(path, offset + 24)
  })
  for (let logicalOffset = 0, physical = 16 * 128 * 1024; logicalOffset < logical.length; logicalOffset += 31, physical += 32) {
    mdu.set(logical.subarray(logicalOffset, logicalOffset + 31), physical + 1)
  }
  return mdu
}

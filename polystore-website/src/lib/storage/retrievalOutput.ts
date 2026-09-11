// Worker-owned OPFS handles write in place. Reopening createWritable with
// keepExistingData after every ACK can copy the entire output each wave.
type SyncAccess = {
  truncate(size: number): void
  write(bytes: Uint8Array, options: { at: number }): number
  flush(): void
  close(): void
}
export type RetrievalOutputRequest =
  | { action: 'create'; length: number }
  | { action: 'resume'; id: string; length: number }
  | { action: 'write'; id: string; offset: number; bytes: Uint8Array }
  | { action: 'flush' | 'file' | 'remove' | 'release'; id: string }

const outputs = new Map<string, { dir: FileSystemDirectoryHandle; file: FileSystemFileHandle; access: SyncAccess | null; length: number }>()
let opening = 0

export async function retrievalOutput(request: RetrievalOutputRequest): Promise<string | File | undefined> {
  if ('id' in request && !/^[0-9a-f-]{36}$/.test(request.id)) throw new Error('invalid retrieval output ID')
  if (request.action === 'create' || request.action === 'resume') {
    if (!Number.isSafeInteger(request.length) || request.length < 0) throw new Error('unsupported output length')
    // ponytail: four live outputs per tab; reject before funding instead of queuing.
    if (outputs.size + opening >= 4) throw new Error('too many active retrieval outputs')
    let dir: FileSystemDirectoryHandle | undefined, access: SyncAccess | undefined
    const id = request.action === 'resume' ? request.id : crypto.randomUUID()
    opening++
    try {
      const root = await navigator.storage.getDirectory()
      dir = await root.getDirectoryHandle('retrieval-output', { create: true })
      const file = await dir.getFileHandle(id, { create: request.action === 'create' })
      if (request.action === 'resume' && (await file.getFile()).size !== request.length) throw new Error('saved retrieval output length mismatch')
      // TypeScript's DOM-only library omits this dedicated-Worker method.
      const workerFile = file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> }
      if (!workerFile.createSyncAccessHandle) throw new Error('in-place browser storage is required before payment')
      access = await workerFile.createSyncAccessHandle()
      if (request.action === 'create') access.truncate(request.length)
      outputs.set(id, { dir, file, access, length: request.length })
      return id
    } catch (error) {
      access?.close()
      if (request.action === 'create') await dir?.removeEntry(id).catch(() => {})
      throw error
    } finally { opening-- }
  }
  const output = outputs.get(request.id)
  if (!output) {
    if (request.action === 'remove') {
      await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('retrieval-output'))
        .then((dir) => dir.removeEntry(request.id)).catch((error) => {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
      })
      return
    }
    throw new Error('retrieval output unavailable')
  }
  if (request.action === 'release') {
    try { output.access?.flush() }
    finally { try { output.access?.close() } finally { outputs.delete(request.id) } }
  } else if (request.action === 'remove') {
    output.access?.close(); output.access = null
    await output.dir.removeEntry(request.id)
    outputs.delete(request.id)
  } else if (request.action === 'file') {
    output.access?.flush(); output.access?.close(); output.access = null
    const file = await output.file.getFile()
    if (file.size !== output.length) throw new Error('output length mismatch')
    return file
  } else {
    if (!output.access) throw new Error('retrieval output already closed')
    if (request.action === 'flush') output.access.flush()
    else if (request.action === 'write') {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !(request.bytes instanceof Uint8Array) ||
        request.bytes.length > 8388608 || request.offset > output.length - request.bytes.length) throw new Error('output write out of range')
      for (let written = 0; written < request.bytes.length;) {
        const count = output.access.write(request.bytes.subarray(written), { at: request.offset + written })
        if (!Number.isSafeInteger(count) || count <= 0 || count > request.bytes.length - written) throw new Error(`incomplete output write at ${request.offset + written}: ${count} of ${request.bytes.length - written}`)
        written += count
      }
    }
  }
}

import { makeSparseArtifact, type SparseArtifactInput } from './sparseArtifacts'

export interface SparseUploadRequest {
  url: string
  headers: Record<string, string>
  artifact: SparseArtifactInput
  fetchImpl?: typeof fetch
}

function shouldRetrySparseUpload(response: Response, sendSize: number, fullSize: number): boolean {
  return sendSize < fullSize && (response.status === 400 || response.status === 411)
}

function buildBody(bytes: Uint8Array): Blob {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Blob([bytes as any])
}

export async function postSparseArtifact(request: SparseUploadRequest): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? fetch
  const sparseArtifact = makeSparseArtifact(request.artifact)
  const fullPayload = request.artifact.bytes

  const post = async (bodyBytes: Uint8Array, fullSizeHeader?: number): Promise<Response> => {
    const headers: Record<string, string> = {
      ...request.headers,
      'Content-Type': request.headers['Content-Type'] || 'application/octet-stream',
    }
    if (fullSizeHeader != null && bodyBytes.byteLength < fullSizeHeader) {
      headers['X-Nil-Full-Size'] = String(fullSizeHeader)
    } else {
      delete headers['X-Nil-Full-Size']
    }

    return fetchImpl(request.url, {
      method: 'POST',
      headers,
      body: buildBody(bodyBytes),
    })
  }

  let response = await post(sparseArtifact.bytes, sparseArtifact.fullSize)
  if (shouldRetrySparseUpload(response, sparseArtifact.bytes.byteLength, sparseArtifact.fullSize)) {
    response.body?.cancel?.().catch(() => {})
    response = await post(fullPayload, undefined)
  }
  return response
}

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

export async function postSparseArtifact(request: SparseUploadRequest): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? fetch
  const sparseArtifact = makeSparseArtifact(request.artifact)
  const fullPayload = request.artifact.bytes
  const asBodyInit = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit
  const defaultContentType = request.headers['Content-Type'] || 'application/octet-stream'
  const requestHeaders =
    request.headers['Content-Type'] === defaultContentType
      ? request.headers
      : { ...request.headers, 'Content-Type': defaultContentType }

  const post = async (bodyBytes: Uint8Array, fullSizeHeader?: number): Promise<Response> => {
    const headers: Record<string, string> =
      fullSizeHeader != null && bodyBytes.byteLength < fullSizeHeader
        ? { ...requestHeaders, 'X-PolyStore-Full-Size': String(fullSizeHeader) }
        : requestHeaders

    return fetchImpl(request.url, {
      method: 'POST',
      headers,
      body: asBodyInit(bodyBytes),
    })
  }

  let response = await post(sparseArtifact.bytes, sparseArtifact.fullSize)
  if (shouldRetrySparseUpload(response, sparseArtifact.bytes.byteLength, sparseArtifact.fullSize)) {
    response.body?.cancel?.().catch(() => {})
    response = await post(fullPayload, undefined)
  }
  return response
}

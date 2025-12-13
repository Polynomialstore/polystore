export interface NilfsFileEntry {
  path: string
  size_bytes: number
  start_offset: number
  flags: number
}

export interface SlabSegment {
  kind: 'mdu0' | 'witness' | 'user'
  start_index: number
  count: number
  size_bytes: number
}

export interface SlabLayoutData {
  manifest_root: string
  mdu_size_bytes: number
  blob_size_bytes: number
  total_mdus: number
  witness_mdus: number
  user_mdus: number
  file_records: number
  file_count: number
  total_size_bytes: number
  segments: SlabSegment[]
}


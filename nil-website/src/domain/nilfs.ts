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

export interface MduRootRecord {
  mdu_index: number
  kind: 'mdu0' | 'witness' | 'user'
  root_hex: string
  root_table_index?: number
}

export interface ManifestInfoData {
  manifest_root: string
  manifest_blob_hex: string
  total_mdus: number
  witness_mdus: number
  user_mdus: number
  roots: MduRootRecord[]
}

export interface MduKzgData {
  manifest_root: string
  mdu_index: number
  kind: 'mdu0' | 'witness' | 'user'
  root_hex: string
  blobs: string[]
}

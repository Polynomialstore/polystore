//! SHA-256 duplicate-last integrity tree for inactive retrieval v3.
use sha2::{Digest, Sha256};

pub const ENCODED_BLOB_BYTES: usize = 131_072;
pub const MAX_LEAVES: u64 = 65_536 * 96;
fn lp(h: &mut Sha256, value: &[u8]) {
    h.update((value.len() as u32).to_be_bytes());
    h.update(value)
}
pub fn leaf(mdu: u64, index: u32, blob: &[u8]) -> Result<[u8; 32], String> {
    if mdu == 0 || mdu > 65536 || index >= 96 || blob.len() != ENCODED_BLOB_BYTES {
        return Err("invalid v3 integrity coordinate or blob length".into());
    }
    let mut h = Sha256::new();
    lp(&mut h, b"polystore/integrity-leaf/v3");
    h.update(mdu.to_be_bytes());
    h.update(index.to_be_bytes());
    h.update((ENCODED_BLOB_BYTES as u32).to_be_bytes());
    h.update(blob);
    Ok(h.finalize().into())
}
fn parent(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    lp(&mut h, b"polystore/integrity-node/v3");
    h.update(left);
    h.update(right);
    h.finalize().into()
}
pub fn root(leaves: &[[u8; 32]]) -> Result<[u8; 32], String> {
    if leaves.is_empty() || leaves.len() as u64 > MAX_LEAVES {
        return Err("invalid v3 integrity leaf count".into());
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let mut write = 0;
        for read in (0..level.len()).step_by(2) {
            let right = if read + 1 < level.len() {
                level[read + 1]
            } else {
                level[read]
            };
            level[write] = parent(&level[read], &right);
            write += 1
        }
        level.truncate(write)
    }
    Ok(level[0])
}
pub fn verify_path(
    value: [u8; 32],
    mut position: u64,
    mut count: u64,
    siblings: &[[u8; 32]],
    expected: [u8; 32],
) -> bool {
    if count == 0 || count > MAX_LEAVES || position >= count {
        return false;
    }
    let mut current = value;
    let mut used = 0;
    while count > 1 {
        let Some(sibling) = siblings.get(used) else {
            return false;
        };
        if count % 2 == 1 && position == count - 1 && sibling != &current {
            return false;
        }
        current = if position % 2 == 1 {
            parent(sibling, &current)
        } else {
            parent(&current, sibling)
        };
        position /= 2;
        count = (count + 1) / 2;
        used += 1
    }
    used == siblings.len() && current == expected
}

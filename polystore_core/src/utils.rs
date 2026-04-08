use num_bigint::BigUint;
use num_integer::Integer;
use num_traits::Num;
use sha2::{Digest, Sha256};

pub const FR_MODULUS_HEX: &str = "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001";
pub const BYTES_PER_BLOB: usize = 4096 * 32;
pub const SYMBOLS_PER_BLOB: usize = 4096;
pub const SYMBOL_SIZE: usize = 131072; // 128KB (EIP-4844 aligned)
pub const GENERATOR: u64 = 7;

pub fn get_modulus() -> BigUint {
    BigUint::from_str_radix(FR_MODULUS_HEX, 16).unwrap()
}

pub fn get_root_of_unity_4096() -> BigUint {
    let modulus = get_modulus();
    let generator = BigUint::from(GENERATOR);
    let exponent = (&modulus - 1u32) / 4096u32;
    generator.modpow(&exponent, &modulus)
}

pub fn z_for_cell(idx: usize) -> [u8; 32] {
    let modulus = get_modulus();
    let omega = get_root_of_unity_4096();
    let idx_bn = BigUint::from(idx);
    let z = omega.modpow(&idx_bn, &modulus);
    fr_to_bytes_be(&z) // Changed to BE
}

pub fn sha256_to_fr(data: &[u8]) -> BigUint {
    let hash = Sha256::digest(data);
    let val = BigUint::from_bytes_be(&hash);
    val.mod_floor(&get_modulus())
}

pub fn fr_to_bytes_be(fr: &BigUint) -> [u8; 32] {
    let bytes = fr.to_bytes_be();
    let mut out = [0u8; 32];
    if bytes.len() > 32 {
        panic!("Fr too large");
    }
    // Pad with leading zeros (BE)
    // out is [0, 0, ..., bytes]
    let offset = 32 - bytes.len();
    out[offset..32].copy_from_slice(&bytes);
    out
}

pub fn bytes_to_fr_be(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_be(bytes)
}

// Kept for compatibility if needed, but not used for c-kzg
pub fn fr_to_bytes_le(fr: &BigUint) -> [u8; 32] {
    let bytes = fr.to_bytes_le();
    let mut out = [0u8; 32];
    if bytes.len() > 32 {
        panic!("Fr too large");
    }
    out[0..bytes.len()].copy_from_slice(&bytes);
    out
}

pub fn bytes_to_fr_le(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_le(bytes)
}

pub fn file_to_symbols(data: &[u8]) -> Vec<Vec<u8>> {
    if data.is_empty() {
        return vec![vec![0u8; SYMBOL_SIZE]];
    }

    let mut symbols = Vec::new();
    for chunk in data.chunks(SYMBOL_SIZE) {
        let mut symbol = chunk.to_vec();
        if symbol.len() < SYMBOL_SIZE {
            symbol.resize(SYMBOL_SIZE, 0);
        }
        symbols.push(symbol);
    }
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z_for_cell_zero_is_one() {
        let z = z_for_cell(0);
        let one = BigUint::from(1u32);
        assert_eq!(bytes_to_fr_be(&z), one);
    }

    #[test]
    fn frs_to_blobs_packs_scalars_in_order() {
        let frs: Vec<BigUint> = (0u32..8).map(|i| BigUint::from(i)).collect();

        let blobs = frs_to_blobs(&frs);
        assert_eq!(blobs.len(), 1, "expected single blob for 8 frs");

        let blob = &blobs[0];
        assert_eq!(
            blob.len(),
            BYTES_PER_BLOB,
            "blob size must match BYTES_PER_BLOB"
        );

        for (i, fr) in frs.iter().enumerate() {
            let offset = i * 32;
            let expected = fr_to_bytes_be(fr);
            assert_eq!(
                &blob[offset..offset + 32],
                &expected,
                "scalar at index {} must be encoded at correct position",
                i
            );
        }
    }
}

pub fn symbols_to_frs(symbols: &[Vec<u8>]) -> Vec<BigUint> {
    symbols.iter().map(|s| sha256_to_fr(s)).collect()
}

pub fn reverse_bits(mut n: usize, bits: u32) -> usize {
    let mut r = 0;

    for _ in 0..bits {
        r = (r << 1) | (n & 1);

        n >>= 1;
    }

    r
}

pub fn frs_to_blobs(frs: &[BigUint]) -> Vec<Vec<u8>> {
    let mut blobs = Vec::new();

    for chunk in frs.chunks(SYMBOLS_PER_BLOB) {
        // Initialize blob with zeros (4096 * 32 bytes)

        let mut blob = vec![0u8; BYTES_PER_BLOB];

        for (i, fr) in chunk.iter().enumerate() {
            // Natural Order: Place fr[i] at blob[i]
            let offset = i * 32;
            let bytes = fr_to_bytes_be(fr); // Changed to BE
            blob[offset..offset + 32].copy_from_slice(&bytes);
        }

        blobs.push(blob);
    }

    blobs
}

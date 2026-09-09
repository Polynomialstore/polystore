//! Canonical C2 byte contract shared with the chain's retrievalchallenge package.
//! Parsing authenticates no actor, setup, anchor or chain state. The caller must
//! obtain these bytes and the seed from authenticated committed chain state.
use crate::kzg::KzgError;
use bls12_381::Scalar;
use num_bigint::BigUint;
use num_traits::{One, ToPrimitive};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_SAMPLES: u64 = 4096;
const MAX_HEIGHT: u64 = i64::MAX as u64;
const ATTEMPTS: u32 = 256;

pub(crate) fn invalid() -> KzgError {
    KzgError::InvalidDataLength
}

/// Checked cursor shared by the two finite native byte contracts.
pub(crate) struct Reader<'a> {
    pub bytes: &'a [u8],
}
impl<'a> Reader<'a> {
    pub fn take(&mut self, count: usize) -> Result<&'a [u8], KzgError> {
        if count > self.bytes.len() {
            return Err(invalid());
        }
        let (head, tail) = self.bytes.split_at(count);
        self.bytes = tail;
        Ok(head)
    }
    pub fn array<const N: usize>(&mut self) -> Result<[u8; N], KzgError> {
        self.take(N)?.try_into().map_err(|_| invalid())
    }
    pub fn u8(&mut self) -> Result<u8, KzgError> {
        Ok(self.array::<1>()?[0])
    }
    pub fn u16(&mut self) -> Result<u16, KzgError> {
        Ok(u16::from_be_bytes(self.array()?))
    }
    pub fn u32(&mut self) -> Result<u32, KzgError> {
        Ok(u32::from_be_bytes(self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64, KzgError> {
        Ok(u64::from_be_bytes(self.array()?))
    }
    pub(crate) fn lp(&mut self) -> Result<&'a [u8], KzgError> {
        let n = self.u32()? as usize;
        self.take(n)
    }
}

#[derive(Debug)]
pub struct Context {
    hash: [u8; 32],
    kind: u8,
    rows: u64,
    population: u64,
    metadata: u64,
    slot: u32,
    start: u64,
    count: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Challenge {
    pub ordinal: u64,
    pub population_index: u64,
    pub mdu_index: u64,
    pub leaf_index: u32,
    pub z: [u8; 32],
}

impl Context {
    /// Decode exactly one canonical Go Context.Bytes() transcript, with no suffix.
    pub fn parse(bytes: &[u8]) -> Result<Self, KzgError> {
        if bytes.len() > 512 {
            return Err(invalid());
        }
        let mut r = Reader { bytes };
        if r.lp()? != b"polystore/challenge-context/v2" || r.u32()? != 2 {
            return Err(invalid());
        }
        let chain = r.lp()?;
        if chain.is_empty()
            || chain.len() > 50
            || chain.contains(&0)
            || std::str::from_utf8(chain).is_err()
        {
            return Err(invalid());
        }
        r.take(32)?; // Setup identity is authenticated by the caller, as in Go C2.
        let kind = r.u8()?;
        let id = r.array::<32>()?;
        r.u64()?;
        r.u64()?;
        r.take(32)?; // deal, generation, root
        let assigned = r.array::<20>()?;
        let payee = r.array::<20>()?;
        let layout = r.u8()?;
        let k = r.u32()?;
        let m = r.u32()?;
        let slot = r.u32()?;
        let rows = match layout {
            1 if k == 1 && m == 0 && slot == 0 => 64,
            2 if k > 0
                && k <= 64
                && 64 % k == 0
                && m > 0
                && u64::from(k) + u64::from(m) <= 256
                && u64::from(slot) < u64::from(k) + u64::from(m) =>
            {
                64 / u64::from(k)
            }
            _ => return Err(invalid()),
        };
        let metadata = r.u64()?;
        let users = r.u64()?;
        let start_mdu = r.u64()?;
        let start_leaf = r.u32()?;
        let blobs = r.u64()?;
        let epoch = r.u64()?;
        let length = r.u64()?;
        let samples = r.u64()?;
        let snapshot = r.u64()?;
        let anchor = r.u64()?;
        let first = r.u64()?;
        let deadline = r.u64()?;
        let deal_end = r.u64()?;
        if !r.bytes.is_empty() || metadata == 0 || metadata > 65537 || users > 65537 - metadata {
            return Err(invalid());
        }
        let population = users * rows; // Proven finite by the root-table bound.
        let (start, count) = match kind {
            1 => {
                if epoch != 0
                    || length != 0
                    || samples != 0
                    || snapshot == 0
                    || snapshot > MAX_HEIGHT - 2
                    || deal_end == 0
                    || deal_end > MAX_HEIGHT
                    || snapshot >= deal_end
                    || deadline > deal_end
                    || deadline < snapshot + 2
                    || anchor != snapshot + 1
                    || first != snapshot + 2
                    || start_mdu < metadata
                    || start_mdu - metadata >= users
                    || blobs == 0
                    || blobs > MAX_SAMPLES
                    || u64::from(start_leaf) < u64::from(slot) * rows
                    || u64::from(start_leaf) - u64::from(slot) * rows >= rows
                {
                    return Err(invalid());
                }
                let row = u64::from(start_leaf) - u64::from(slot) * rows;
                let start = (start_mdu - metadata) * rows + row;
                if blobs > population - start || blobs > rows - row {
                    return Err(invalid());
                }
                (start, blobs)
            }
            2 | 3 => {
                if id != [0; 32]
                    || assigned != payee
                    || start_mdu != 0
                    || start_leaf != 0
                    || blobs != 0
                    || epoch == 0
                    || length < 2
                    || length > MAX_HEIGHT
                    || epoch > MAX_HEIGHT / length
                    || deal_end == 0
                    || deal_end > MAX_HEIGHT
                    || samples == 0
                    || samples > population
                    || samples > MAX_SAMPLES
                {
                    return Err(invalid());
                }
                let end = epoch * length;
                let begin = end - length + 1;
                let expected_deadline = end.min(deal_end - 1);
                if expected_deadline < begin + 1
                    || snapshot != begin - 1
                    || anchor != begin
                    || first != begin + 1
                    || deadline != expected_deadline
                {
                    return Err(invalid());
                }
                (0, samples)
            }
            _ => return Err(invalid()),
        };
        Ok(Self {
            hash: Sha256::digest(bytes).into(),
            kind,
            rows,
            population,
            metadata,
            slot,
            start,
            count,
        })
    }
    pub fn hash(&self) -> [u8; 32] {
        self.hash
    }
    pub fn challenges(&self, seed: &[u8; 32]) -> Result<Vec<Challenge>, KzgError> {
        let positions = if self.kind == 1 {
            (self.start..self.start + self.count).collect()
        } else {
            sample(&self.hash, seed, self.population, self.count)?
        };
        positions
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let mdu = self.metadata + p / self.rows;
                let leaf = (u64::from(self.slot) * self.rows + p % self.rows) as u32;
                Ok(Challenge {
                    ordinal: i as u64,
                    population_index: p,
                    mdu_index: mdu,
                    leaf_index: leaf,
                    z: derive_z(&self.hash, seed, i as u64, mdu, leaf)?,
                })
            })
            .collect()
    }
    /// Fixed-width BE records: ordinal8, population8, MDU8, leaf4, z32.
    pub fn challenges_flat(&self, seed: &[u8; 32]) -> Result<Vec<u8>, KzgError> {
        let challenges = self.challenges(seed)?;
        let mut out = Vec::with_capacity(challenges.len() * 60);
        for c in challenges {
            out.extend(c.ordinal.to_be_bytes());
            out.extend(c.population_index.to_be_bytes());
            out.extend(c.mdu_index.to_be_bytes());
            out.extend(c.leaf_index.to_be_bytes());
            out.extend(c.z);
        }
        Ok(out)
    }
}

pub(crate) fn append_lp(out: &mut Vec<u8>, value: &[u8]) {
    out.extend((value.len() as u32).to_be_bytes());
    out.extend(value);
}

fn nonzero_scalar(bytes: [u8; 32]) -> Option<Scalar> {
    let mut le = bytes;
    le.reverse();
    Option::<Scalar>::from(Scalar::from_bytes(&le)).filter(|s| *s != Scalar::zero())
}
pub(crate) fn valid_point(bytes: [u8; 32]) -> bool {
    let Some(mut value) = nonzero_scalar(bytes) else {
        return false;
    };
    for _ in 0..12 {
        value = value.square();
    }
    value != Scalar::one()
}
pub fn derive_z(
    hash: &[u8; 32],
    seed: &[u8; 32],
    ordinal: u64,
    mdu: u64,
    leaf: u32,
) -> Result<[u8; 32], KzgError> {
    derive_z_with_domain(
        b"polystore/blob-challenge/v2",
        hash,
        seed,
        ordinal,
        None,
        mdu,
        leaf,
    )
}

pub(crate) fn derive_z_with_domain(
    domain: &[u8],
    hash: &[u8; 32],
    seed: &[u8; 32],
    ordinal: u64,
    t: Option<u64>,
    mdu: u64,
    leaf: u32,
) -> Result<[u8; 32], KzgError> {
    let mut transcript = Vec::with_capacity(128);
    append_lp(&mut transcript, domain);
    transcript.extend(hash);
    transcript.extend(seed);
    transcript.extend(ordinal.to_be_bytes());
    if let Some(t) = t {
        transcript.extend(t.to_be_bytes());
    }
    transcript.extend(mdu.to_be_bytes());
    transcript.extend(leaf.to_be_bytes());
    hash_to_point(|retry| {
        let mut h = Sha256::new();
        h.update(&transcript);
        h.update(retry.to_be_bytes());
        h.finalize().into()
    })
}

fn hash_to_point(mut digest: impl FnMut(u32) -> [u8; 32]) -> Result<[u8; 32], KzgError> {
    for retry in 0..ATTEMPTS {
        let candidate = digest(retry);
        if valid_point(candidate) {
            return Ok(candidate);
        }
    }
    Err(KzgError::Internal("C2 point rejection exhausted".into()))
}

pub fn sample(
    hash: &[u8; 32],
    seed: &[u8; 32],
    population: u64,
    count: u64,
) -> Result<Vec<u64>, KzgError> {
    sample_with_domain(
        b"polystore/audit-position/v2",
        hash,
        seed,
        population,
        count,
        MAX_SAMPLES,
    )
}

pub(crate) fn sample_with_domain(
    domain: &[u8],
    hash: &[u8; 32],
    seed: &[u8; 32],
    population: u64,
    count: u64,
    max_count: u64,
) -> Result<Vec<u64>, KzgError> {
    if count > population || count > max_count {
        return Err(invalid());
    }
    let mut positions = Vec::with_capacity(count as usize);
    let mut swaps = BTreeMap::new();
    let mut transcript = Vec::with_capacity(128);
    append_lp(&mut transcript, domain);
    transcript.extend(hash);
    transcript.extend(seed);
    for i in 0..count {
        let n = population - i;
        let draw = draw(n, |retry| {
            let mut h = Sha256::new();
            h.update(&transcript);
            h.update(i.to_be_bytes());
            h.update(retry.to_be_bytes());
            h.finalize().into()
        })?;
        let p = *swaps.get(&draw).unwrap_or(&draw);
        let tail = *swaps.get(&(n - 1)).unwrap_or(&(n - 1));
        positions.push(p);
        swaps.insert(draw, tail);
        swaps.remove(&(n - 1));
    }
    Ok(positions)
}

fn draw(n: u64, mut digest: impl FnMut(u32) -> [u8; 32]) -> Result<u64, KzgError> {
    if n == 0 {
        return Err(invalid());
    }
    if n == 1 {
        return Ok(0);
    }
    let space = BigUint::one() << 256usize;
    let limit = &space - &space % n;
    for retry in 0..ATTEMPTS {
        let x = BigUint::from_bytes_be(&digest(retry));
        if x < limit {
            return (&x % n).to_u64().ok_or_else(invalid);
        }
    }
    Err(KzgError::Internal("C2 position rejection exhausted".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejection_bounds_are_finite_and_never_weakened() {
        let mut calls = 0;
        assert!(
            hash_to_point(|retry| {
                assert_eq!(retry, calls);
                calls += 1;
                [0; 32]
            })
            .is_err()
        );
        assert_eq!(calls, 256);
        let mut two = [0; 32];
        two[31] = 2;
        assert_eq!(
            hash_to_point(|retry| if retry == 255 { two } else { [0xff; 32] }).unwrap(),
            two
        );
        calls = 0;
        assert!(
            draw(u64::MAX, |retry| {
                assert_eq!(retry, calls);
                calls += 1;
                [0xff; 32]
            })
            .is_err()
        );
        assert_eq!(calls, 256);
        assert_eq!(
            draw(u64::MAX, |retry| if retry == 255 {
                [0; 32]
            } else {
                [0xff; 32]
            })
            .unwrap(),
            0
        );
        assert_eq!(
            draw(1, |_| panic!("singleton must consume no hash")).unwrap(),
            0
        );
        assert!(draw(0, |_| panic!("empty range must consume no hash")).is_err());
    }
    #[test]
    fn reject_entire_evaluation_domain_and_zero() {
        assert!(!valid_point([0; 32]));
        for i in 0..4096 {
            assert!(!valid_point(crate::utils::z_for_cell(i)));
        }
        assert!(!valid_point([0xff; 32]));
    }
    #[test]
    fn samples_cover_population_once_and_bound_allocation() {
        for size in [0, 1, 7, 132, 1375, 4096] {
            let mut values = sample(&[1; 32], &[2; 32], size, size).unwrap();
            values.sort_unstable();
            assert_eq!(values, (0..size).collect::<Vec<_>>());
        }
        assert!(sample(&[0; 32], &[0; 32], u64::MAX, 4097).is_err());
        assert!(sample(&[0; 32], &[0; 32], 0, 1).is_err());
        assert_eq!(sample(&[0; 32], &[0; 32], u64::MAX, 2).unwrap().len(), 2);
    }
}

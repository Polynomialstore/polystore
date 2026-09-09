//! Inactive retrieval-v3 range, binding and challenge primitives.
//! Authorization, state mutation and proof verification remain keeper concerns.
use crate::kzg::KzgError;
use crate::retrieval_challenge::{
    Reader, append_lp, derive_z_with_domain, invalid, sample_with_domain,
};
use num_bigint::BigUint;
use sha2::{Digest, Sha256};

pub const VERSION: u32 = 3;
pub const DATA_BLOB_PAYLOAD_BYTES: u64 = 126_976;
pub const MAX_RANGE_BYTES: u64 = 1 << 30;
pub const MAX_SAMPLES: u64 = 132;
pub const MAX_CONTEXT_BYTES: usize = 734;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub first: u64,
    pub last: u64,
    pub population: u64,
}
impl Range {
    fn validate(&self) -> Result<(), KzgError> {
        let expected = self
            .last
            .checked_sub(self.first)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(invalid)?;
        if self.population == 0 || self.population != expected {
            return Err(invalid());
        }
        Ok(())
    }
}

pub fn checked_range(
    file_start: u64,
    file_length: u64,
    range_start: u64,
    range_length: u64,
    user_mdus: u64,
) -> Result<Range, KzgError> {
    if range_length == 0 || range_length > MAX_RANGE_BYTES || user_mdus == 0 {
        return Err(invalid());
    }
    if range_start.checked_add(range_length).ok_or_else(invalid)? > file_length {
        return Err(invalid());
    }
    let absolute = file_start.checked_add(range_start).ok_or_else(invalid)?;
    let end = absolute.checked_add(range_length - 1).ok_or_else(invalid)?;
    let first = absolute / DATA_BLOB_PAYLOAD_BYTES;
    let last = end / DATA_BLOB_PAYLOAD_BYTES;
    let capacity = user_mdus.checked_mul(64).ok_or_else(invalid)?;
    if last >= capacity {
        return Err(invalid());
    }
    Ok(Range {
        first,
        last,
        population: last - first + 1,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Obligation {
    pub slot: u32,
    pub assigned: [u8; 20],
    pub payee: [u8; 20],
    pub blob_count: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub range: Range,
    pub obligations: Vec<Obligation>,
}

fn residue_count(first: u64, last: u64, residue: u64) -> u64 {
    let delta = (residue + 8 - first % 8) % 8;
    if delta > last - first {
        0
    } else {
        1 + (last - first - delta) / 8
    }
}
impl Plan {
    pub fn build(range: Range, providers: [[u8; 20]; 8]) -> Result<Self, KzgError> {
        range.validate()?;
        let obligations = (0..8)
            .filter_map(|slot| {
                let n = residue_count(range.first, range.last, slot);
                (n > 0).then(|| Obligation {
                    slot: slot as u32,
                    assigned: providers[slot as usize],
                    payee: providers[slot as usize],
                    blob_count: n,
                })
            })
            .collect();
        Ok(Self { range, obligations })
    }
    pub fn bytes(&self) -> Result<Vec<u8>, KzgError> {
        self.range.validate()?;
        if self.obligations.is_empty() || self.obligations.len() > 8 {
            return Err(invalid());
        }
        let mut total = 0;
        let mut prior = None;
        for o in &self.obligations {
            if o.slot > 7
                || o.assigned != o.payee
                || o.blob_count != residue_count(self.range.first, self.range.last, o.slot as u64)
                || o.blob_count == 0
                || prior.is_some_and(|p| p >= o.slot)
            {
                return Err(invalid());
            }
            total += o.blob_count;
            prior = Some(o.slot)
        }
        if total != self.range.population {
            return Err(invalid());
        }
        let mut b = Vec::with_capacity(32 + 24 + self.obligations.len() * 52);
        append_lp(&mut b, b"polystore/retrieval-plan/v3");
        for v in [self.range.first, self.range.last, self.range.population] {
            b.extend(v.to_be_bytes())
        }
        b.extend((self.obligations.len() as u32).to_be_bytes());
        for o in &self.obligations {
            b.extend(o.slot.to_be_bytes());
            b.extend(o.assigned);
            b.extend(o.payee);
            b.extend(o.blob_count.to_be_bytes())
        }
        Ok(b)
    }
    pub fn hash(&self) -> Result<[u8; 32], KzgError> {
        Ok(Sha256::digest(self.bytes()?).into())
    }
}

pub fn session_id(
    chain: &str,
    owner: &[u8; 20],
    deal: u64,
    generation: u64,
    record: u32,
    range_start: u64,
    range_length: u64,
    plan_hash: &[u8; 32],
    nonce: u64,
) -> Result<[u8; 32], KzgError> {
    if !valid_chain(chain.as_bytes()) || range_length == 0 || range_length > MAX_RANGE_BYTES {
        return Err(invalid());
    }
    let mut b = Vec::new();
    append_lp(&mut b, b"polystore/retrieval-session/v3");
    b.extend(VERSION.to_be_bytes());
    append_lp(&mut b, chain.as_bytes());
    b.extend(owner);
    b.extend(deal.to_be_bytes());
    b.extend(generation.to_be_bytes());
    b.extend(record.to_be_bytes());
    b.extend(range_start.to_be_bytes());
    b.extend(range_length.to_be_bytes());
    b.extend(plan_hash);
    b.extend(nonce.to_be_bytes());
    Ok(Sha256::digest(b).into())
}

pub fn generation_acceptance(
    chain: &str,
    setup: &[u8; 32],
    deal: u64,
    generation: u64,
    polyfs: &[u8; 32],
    integrity: &[u8; 32],
    metadata: u64,
    users: u64,
    slot: u32,
    provider: &[u8; 20],
) -> Result<Vec<u8>, KzgError> {
    if !valid_chain(chain.as_bytes())
        || metadata == 0
        || metadata > 65537
        || users == 0
        || users > 65537 - metadata
        || slot >= 12
    {
        return Err(invalid());
    }
    let mut b = Vec::new();
    append_lp(&mut b, b"polystore/generation-acceptance/v3");
    append_lp(&mut b, chain.as_bytes());
    b.extend(setup);
    b.extend(deal.to_be_bytes());
    b.extend(generation.to_be_bytes());
    b.extend(polyfs);
    b.extend(integrity);
    b.push(2);
    b.extend(8u32.to_be_bytes());
    b.extend(4u32.to_be_bytes());
    b.extend(metadata.to_be_bytes());
    b.extend(users.to_be_bytes());
    b.extend(slot.to_be_bytes());
    b.extend(provider);
    Ok(b)
}

pub fn obligation_ack(
    chain: &str,
    session: &[u8; 32],
    context: &[u8; 32],
    plan: &[u8; 32],
    obligation: &Obligation,
    billed_encoded_bytes: u64,
    integrity: &[u8; 32],
) -> Result<Vec<u8>, KzgError> {
    if !valid_chain(chain.as_bytes())
        || obligation.slot >= 8
        || obligation.assigned != obligation.payee
        || obligation.blob_count == 0
        || obligation.blob_count.checked_mul(131072) != Some(billed_encoded_bytes)
    {
        return Err(invalid());
    }
    let mut b = Vec::new();
    append_lp(&mut b, b"polystore/retrieval-obligation-ack/v3");
    append_lp(&mut b, chain.as_bytes());
    b.extend(session);
    b.extend(context);
    b.extend(plan);
    b.extend(obligation.slot.to_be_bytes());
    b.extend(obligation.assigned);
    b.extend(obligation.payee);
    b.extend(obligation.blob_count.to_be_bytes());
    b.extend(billed_encoded_bytes.to_be_bytes());
    b.extend(integrity);
    Ok(b)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Challenge {
    pub ordinal: u64,
    pub position: u64,
    pub t: u64,
    pub mdu_index: u64,
    pub leaf_index: u32,
    pub slot: u32,
    pub z: [u8; 32],
}
#[derive(Debug)]
pub struct Context {
    hash: [u8; 32],
    first: u64,
    population: u64,
    samples: u64,
    metadata: u64,
}

fn valid_chain(v: &[u8]) -> bool {
    !v.is_empty() && v.len() <= 50 && !v.contains(&0) && std::str::from_utf8(v).is_ok()
}
fn valid_denom(v: &[u8]) -> bool {
    (3..=128).contains(&v.len())
        && v[0].is_ascii_alphabetic()
        && v[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"/:._-".contains(b))
}
fn valid_amount(v: &[u8]) -> bool {
    !v.is_empty()
        && v.len() <= 78
        && v.iter().all(u8::is_ascii_digit)
        && (v == b"0" || v[0] != b'0')
        && BigUint::parse_bytes(v, 10).is_some_and(|n| n.bits() <= 256)
}

impl Context {
    pub fn parse(bytes: &[u8]) -> Result<Self, KzgError> {
        if bytes.len() > MAX_CONTEXT_BYTES {
            return Err(invalid());
        }
        let mut r = Reader { bytes };
        if r.lp()? != b"polystore/challenge-context/v3" || r.u32()? != VERSION {
            return Err(invalid());
        }
        let chain = r.lp()?;
        if !valid_chain(chain) {
            return Err(invalid());
        }
        r.take(32)?;
        let sid = r.array::<32>()?;
        let owner = r.array::<20>()?;
        let deal = r.u64()?;
        let generation = r.u64()?;
        r.take(32)?;
        r.take(32)?;
        let record = r.u32()?;
        let file_start = r.u64()?;
        let file_length = r.u64()?;
        let range_start = r.u64()?;
        let range_length = r.u64()?;
        if r.u8()? != 2 || r.u32()? != 8 || r.u32()? != 4 {
            return Err(invalid());
        }
        let metadata = r.u64()?;
        let users = r.u64()?;
        let plan = r.array::<32>()?;
        let population = r.u64()?;
        let samples = r.u64()?;
        let nonce = r.u64()?;
        let denom = r.lp()?;
        let price = r.lp()?;
        let base = r.lp()?;
        let burn = r.u32()?;
        let funding = r.u8()?;
        let payer = r.array::<20>()?;
        let snapshot = r.u64()?;
        let anchor = r.u64()?;
        let first_response = r.u64()?;
        let deadline = r.u64()?;
        let deal_end = r.u64()?;
        if !r.bytes.is_empty()
            || metadata == 0
            || metadata > 65537
            || users == 0
            || users > 65537 - metadata
            || !valid_denom(denom)
            || !valid_amount(price)
            || !valid_amount(base)
            || burn > 10000
            || !(funding == 1 || funding == 2)
            || payer != owner
            || snapshot == 0
            || snapshot > i64::MAX as u64 - 2
            || deal_end == 0
            || deal_end > i64::MAX as u64
            || anchor != snapshot + 1
            || first_response != snapshot + 2
            || first_response > deadline
            || deadline > deal_end
            || snapshot >= deal_end
        {
            return Err(invalid());
        }
        let range = checked_range(file_start, file_length, range_start, range_length, users)?;
        if population != range.population
            || samples != population.min(MAX_SAMPLES)
            || sid
                != session_id(
                    std::str::from_utf8(chain).map_err(|_| invalid())?,
                    &owner,
                    deal,
                    generation,
                    record,
                    range_start,
                    range_length,
                    &plan,
                    nonce,
                )?
        {
            return Err(invalid());
        }
        Ok(Self {
            hash: Sha256::digest(bytes).into(),
            first: range.first,
            population,
            samples,
            metadata,
        })
    }
    pub fn hash(&self) -> [u8; 32] {
        self.hash
    }
    pub fn seed(&self, anchor: &[u8; 32]) -> [u8; 32] {
        let mut b = Vec::new();
        append_lp(&mut b, b"polystore/challenge-seed/v3");
        b.extend(self.hash);
        b.extend(anchor);
        Sha256::digest(b).into()
    }
    pub fn challenges(&self, seed: &[u8; 32]) -> Result<Vec<Challenge>, KzgError> {
        let positions = sample_with_domain(
            b"polystore/session-position/v3",
            &self.hash,
            seed,
            self.population,
            self.samples,
            MAX_SAMPLES,
        )?;
        positions
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let t = self.first + p;
                let d = t % 64;
                let slot = (d % 8) as u32;
                let leaf = slot * 8 + (d / 8) as u32;
                let mdu = self.metadata + t / 64;
                Ok(Challenge {
                    ordinal: i as u64,
                    position: p,
                    t,
                    mdu_index: mdu,
                    leaf_index: leaf,
                    slot,
                    z: derive_z_with_domain(
                        b"polystore/blob-challenge/v3",
                        &self.hash,
                        seed,
                        i as u64,
                        Some(t),
                        mdu,
                        leaf,
                    )?,
                })
            })
            .collect()
    }
}

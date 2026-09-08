//! Offline recovery/staging only. Source authority, generation activation and
//! retaining prior generations remain the owner's normal content workflow.
use anyhow::{Context, Result, ensure};
use polystore_core::builder::{MDU_SIZE, Mdu0Builder};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

fn read_original(path: &Path) -> Result<Vec<u8>> {
    // Reject obvious devices/directories/FIFOs before opening; the owner must
    // supply a quiescent original file, not a concurrently replaced pathname.
    let metadata = std::fs::metadata(path).context("Cannot inspect original metadata file")?;
    ensure!(
        metadata.is_file() && metadata.len() == MDU_SIZE as u64,
        "Original metadata must be a regular file of exactly 8 MiB"
    );
    let mut input = File::open(path).context("Cannot open original metadata file")?;
    let metadata = input
        .metadata()
        .context("Cannot inspect opened metadata file")?;
    ensure!(
        metadata.is_file() && metadata.len() == MDU_SIZE as u64,
        "Opened metadata must be a regular file of exactly 8 MiB"
    );
    let mut data = vec![0; MDU_SIZE];
    input
        .read_exact(&mut data)
        .context("Original metadata became truncated while reading")?;
    let mut extra = [0; 1];
    ensure!(
        input.read(&mut extra)? == 0,
        "Original metadata grew while reading"
    );
    Ok(data)
}

pub fn inspect(path: &Path) -> Result<()> {
    let data = read_original(path)?;
    // Hints do not affect FAT bytes and are not inferred as authenticated layout.
    let recovered = Mdu0Builder::load_legacy_recovery(&data, 0, 64).map_err(anyhow::Error::msg)?;
    println!(
        "{}",
        serde_json::json!({
            "format_version": 1,
            "record_count": recovered.record_count(),
            "read_only": true,
            "legacy_root_authenticates_raw_fat": false,
        })
    );
    Ok(())
}

pub fn stage(source: &Path, output: &Path, trusted_source: bool) -> Result<()> {
    ensure!(
        trusted_source,
        "Staging requires --trusted-source: a legacy KZG root cannot authenticate the original raw FAT"
    );
    let data = read_original(source)?;
    let staged =
        Mdu0Builder::stage_v2_from_trusted_legacy(&data, 0, 64).map_err(anyhow::Error::msg)?;
    // create_new atomically rejects any existing output, including input aliases
    // and symlinks. Validation/conversion finish before any output is created.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .context("Cannot create separate output; output must not already exist")?;
    file.write_all(staged.bytes()).context(
        "Cannot write staged metadata; any partial output remains inactive and must not be used",
    )?;
    file.sync_all()
        .context("Cannot sync staged metadata; output has not been activated")?;
    println!(
        "{}",
        serde_json::json!({
            "format_version": 2,
            "record_count": staged.record_count(),
            "activated": false,
            })
    );
    Ok(())
}

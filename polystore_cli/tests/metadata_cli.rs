use polystore_core::builder::{FILE_TABLE_START, MDU_SIZE, Mdu0Builder};
use polystore_core::layout::{FileRecordV1, FileTableHeader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "polystore-metadata-cli-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn run(args: &[&std::ffi::OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_polystore_cli"))
        .args(args)
        .env(
            "CKZG_TRUSTED_SETUP",
            "/missing-setup-metadata-commands-must-not-use",
        )
        .output()
        .unwrap()
}
fn raw_legacy() -> Vec<u8> {
    let mut raw = vec![0; MDU_SIZE];
    let header = FileTableHeader {
        version: 1,
        record_count: 1,
        ..Default::default()
    };
    raw[FILE_TABLE_START..FILE_TABLE_START + 128].copy_from_slice(&header.to_bytes());
    let rec = FileRecordV1::from_path("dir/é.txt", 31, 0, 0x81).unwrap();
    raw[FILE_TABLE_START + 128..FILE_TABLE_START + 384].copy_from_slice(&rec.to_bytes());
    raw[..32].fill(255);
    raw
}
fn stage(input: &Path, output: &Path, trusted: bool) -> Output {
    let mut args = vec![
        std::ffi::OsStr::new("stage-legacy-metadata"),
        input.as_os_str(),
        std::ffi::OsStr::new("--out"),
        output.as_os_str(),
    ];
    if trusted {
        args.push(std::ffi::OsStr::new("--trusted-source"));
    }
    run(&args)
}

#[test]
fn inspect_and_stage_require_no_setup_and_preserve_original() {
    let temp = Temp::new();
    let input = temp.path("legacy.bin");
    let output = temp.path("v2.bin");
    let raw = raw_legacy();
    std::fs::write(&input, &raw).unwrap();
    let inspected = run(&["inspect-legacy-metadata".as_ref(), input.as_os_str()]);
    assert!(
        inspected.status.success(),
        "{}",
        String::from_utf8_lossy(&inspected.stderr)
    );
    let inspected: serde_json::Value = serde_json::from_slice(&inspected.stdout).unwrap();
    assert_eq!(inspected["record_count"], 1);
    assert_eq!(inspected["read_only"], true);
    let staged = stage(&input, &output, true);
    assert!(
        staged.status.success(),
        "{}",
        String::from_utf8_lossy(&staged.stderr)
    );
    let summary: serde_json::Value = serde_json::from_slice(&staged.stdout).unwrap();
    assert_eq!(summary["activated"], false);
    assert_eq!(summary["format_version"], 2);
    let result = std::fs::read(&output).unwrap();
    let builder = Mdu0Builder::load(&result, 65536).unwrap();
    assert_eq!(builder.record_count(), 1);
    assert_eq!(
        &builder.get_file_record(0).unwrap().path[..10],
        "dir/é.txt".as_bytes()
    );
    assert!(std::fs::read(&input).unwrap() == raw);
}

#[test]
fn stage_never_overwrites_and_requires_explicit_trusted_source() {
    let temp = Temp::new();
    let input = temp.path("legacy.bin");
    let output = temp.path("v2.bin");
    let raw = raw_legacy();
    std::fs::write(&input, &raw).unwrap();
    assert!(!stage(&input, &output, false).status.success());
    assert!(!output.exists());
    std::fs::write(&output, b"existing").unwrap();
    assert!(!stage(&input, &output, true).status.success());
    assert_eq!(std::fs::read(&output).unwrap(), b"existing");
    assert!(!stage(&input, &input, true).status.success());
    assert!(std::fs::read(&input).unwrap() == raw);
    #[cfg(unix)]
    {
        let alias = temp.path("alias.bin");
        std::os::unix::fs::symlink(&input, &alias).unwrap();
        assert!(!stage(&input, &alias, true).status.success());
        assert!(std::fs::read(&input).unwrap() == raw);
    }
}

#[test]
fn malformed_or_over_capacity_source_creates_no_output() {
    let temp = Temp::new();
    let input = temp.path("legacy.bin");
    let output = temp.path("v2.bin");
    let mut cases = vec![
        vec![0; 128],
        vec![0; MDU_SIZE + 1],
        Mdu0Builder::new(65536).bytes().to_vec(),
    ];
    let mut reserved = raw_legacy();
    reserved[FILE_TABLE_START + 12] = 1;
    cases.push(reserved);
    let mut oversize = raw_legacy();
    oversize[FILE_TABLE_START + 8..FILE_TABLE_START + 12].copy_from_slice(&23808u32.to_le_bytes());
    cases.push(oversize);
    for raw in cases {
        std::fs::write(&input, &raw).unwrap();
        assert!(!stage(&input, &output, true).status.success());
        assert!(!output.exists());
        assert!(std::fs::read(&input).unwrap() == raw);
    }
    assert!(!stage(&temp.0, &output, true).status.success());
    assert!(!output.exists());
}

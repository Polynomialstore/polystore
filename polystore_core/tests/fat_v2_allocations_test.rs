//! Checks only Rust allocation requests on this test thread, not RSS or C heaps.
use polystore_core::builder::{MDU_SIZE, Mdu0Builder, validate_mdu0_v2};
use polystore_core::layout::FileRecordV1;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::hint::black_box;

struct Counter;
#[global_allocator]
static ALLOCATOR: Counter = Counter;
thread_local! {
    // enabled, total requested bytes, largest request, call count
    static COUNTS: Cell<(bool, usize, usize, usize)> = const { Cell::new((false, 0, 0, 0)) };
}
fn track(size: usize) {
    let _ = COUNTS.try_with(|counts| {
        let (enabled, total, max, calls) = counts.get();
        if enabled {
            counts.set((true, total + size, max.max(size), calls + 1));
        }
    });
}
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            track(layout.size());
        }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            track(layout.size());
        }
        ptr
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let ptr = unsafe { System.realloc(ptr, layout, size) };
        if !ptr.is_null() {
            track(size);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
    }
}
fn measure<T>(f: impl FnOnce() -> T) -> (T, (usize, usize, usize)) {
    COUNTS.with(|c| c.set((true, 0, 0, 0)));
    let result = black_box(f());
    let (_, total, max, calls) = COUNTS.with(|c| c.replace((false, 0, 0, 0)));
    (result, (total, max, calls))
}

#[test]
fn borrowed_validation_and_record_access_do_not_allocate_slabs() {
    let (control, control_stats) = measure(|| black_box(vec![0u8; black_box(4096)]));
    assert_eq!(control_stats, (4096, 4096, 1));
    drop(control);
    let mut builder = Mdu0Builder::new(65536);
    let record = FileRecordV1::from_path("dir/é.txt", 31, 0, 0).unwrap();
    let (result, append_stats) = measure(|| builder.append_file_record(black_box(record)));
    result.unwrap();
    assert_eq!(append_stats, (0, 0, 0));
    let (result, validate_stats) = measure(|| validate_mdu0_v2(black_box(builder.bytes())));
    result.unwrap();
    assert_eq!(validate_stats, (0, 0, 0));
    let (_, read_stats) = measure(|| {
        for _ in 0..1000 {
            black_box(builder.get_file_record(black_box(0)).unwrap());
            let mut range = [0; 256];
            builder.read_fat_range(black_box(128), &mut range).unwrap();
            black_box(range);
            black_box(builder.get_root(black_box(0)).unwrap());
            black_box(builder.bytes());
        }
    });
    assert_eq!(read_stats, (0, 0, 0));
    let (loaded, load_stats) = measure(|| Mdu0Builder::load(black_box(builder.bytes()), 65536));
    loaded.unwrap();
    assert_eq!(load_stats, (MDU_SIZE, MDU_SIZE, 1));
    let mut malformed = builder.bytes().to_vec();
    // Last physical byte belongs to required zero FAT tail: validation reaches
    // this after checking every earlier component, before an owned slab exists.
    malformed[MDU_SIZE - 1] = 1;
    let (invalid, reject_stats) = measure(|| Mdu0Builder::load(black_box(&malformed), 65536));
    assert!(invalid.is_err());
    assert!(
        reject_stats.1 < 256,
        "rejection allocated more than its error string"
    );
    eprintln!(
        "FAT allocations (bytes, largest, calls): append={append_stats:?} validate={validate_stats:?} reads1000={read_stats:?} load={load_stats:?} reject={reject_stats:?}"
    );
}

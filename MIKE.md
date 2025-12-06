todo: 

run testnet as PoA network

consider this note for go rust hygeine in comet:

```
Using a **CGo wrapper** to bridge Go (Ethermint/Cosmos) and Rust (Your logic) is a battle-tested strategy. This is exactly how the **CosmWasm** team works: they write the VM in Rust (`cosmwasm-vm`), compile it to a library (`libwasmvm.so`), and wrap it in Go using CGo.

Since you are running a **PoA Testnet**, this approach is safe and effective, provided you handle the "Memory Boundary" correctly.

### 1\. The Architecture: "The Sandwich"

Your node will look like a sandwich where Go is the bread and Rust is the meat.

  * **Top Layer (Go):** Cosmos SDK / Ethermint. It handles networking, consensus, and the KVStore.
  * **Middle Layer (CGo):** The bridge. It converts Go memory pointers to C pointers.
  * **Bottom Layer (Rust):** Your shared library (`.so` / `.dll` / `.dylib`). It contains your custom logic, cryptography, or heavy computation.

### 2\. How to Implement It (The Pattern)

You need three files to make this work.

#### Step A: The Rust Side (`lib.rs`)

You must expose your functions with the C ABI.

  * Use `#[no_mangle]` so the function name stays readable.
  * Use `extern "C"` to use the C calling convention.
  * **Crucial:** Never let a Rust `panic!` unwind across the FFI boundary. It will crash the Go binary immediately. Catch all panics.

<!-- end list -->

```rust
// src/lib.rs
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[no_mangle]
pub extern "C" fn process_logic(ptr: *const c_char) -> *mut c_char {
    // 1. Safety: Convert C pointer to Rust string
    let c_str = unsafe {
        assert!(!ptr.is_null());
        CStr::from_ptr(ptr)
    };
    let input = c_str.to_str().unwrap();

    // 2. Your Custom Logic
    let result = format!("Rust processed: {}", input);

    // 3. Return to Go (Allocating memory that Go must free!)
    CString::new(result).unwrap().into_raw()
}

// 4. Memory Management: Go needs a way to free Rust memory
#[no_mangle]
pub extern "C" fn free_rust_string(ptr: *mut c_char) {
    if ptr.is_null() { return; }
    unsafe {
        let _ = CString::from_raw(ptr); // This drops the string and frees memory
    }
}
```

#### Step B: The Header File (`api.h`)

CGo needs a header file to know what functions exist.

```c
// api.h
typedef char* (*process_logic_fn)(char*);
char* process_logic(char* input);
void free_rust_string(char* ptr);
```

#### Step C: The Go Wrapper (`wrapper.go`)

This is where you bridge the gap.

```go
package mymodule

/*
#cgo LDFLAGS: -L./rust_lib/target/release -lmy_rust_logic
#include "api.h"
#include <stdlib.h>
*/
import "C"
import (
	"unsafe"
	"fmt"
)

func CallRust(input string) string {
	// 1. Convert Go string to C string (Go allocates this)
	cInput := C.CString(input)
	defer C.free(unsafe.Pointer(cInput)) // Free the C string when done

	// 2. Call Rust
	cResult := C.process_logic(cInput)

	// 3. Convert C string back to Go string
	goResult := C.GoString(cResult)

	// 4. Tell Rust to free its own memory
	C.free_rust_string(cResult)

	return goResult
}
```

### 3\. Where to hook this into Ethermint?

Since you are using Ethermint, you likely want this Rust code to be accessible to the EVM. You have two main options:

1.  **Stateful Precompile (Recommended):**

      * You create a "Precompiled Contract" in Go (standard Ethermint feature).
      * Inside the `Run()` method of the precompile, you call your `CallRust()` function.
      * *Result:* Solidity contracts can call `MyRustLogic.run(data)` and it executes native Rust speed.

2.  **Cosmos Module:**

      * You build a standard Cosmos SDK module (`x/myrustmodule`).
      * In the `MsgServer`, you call `CallRust()`.
      * *Result:* Users send a Cosmos transaction (not EVM) to trigger the logic.

### 4\. Critical "Gotchas" for Testnets

Since you are in the PoA / Testnet phase, watch out for these specific issues:

  * **Determinism is King:** If your Rust code uses `HashMap` (random iteration) or `SystemTime`, your chain will **halt**.
      * *Fix:* Use `BTreeMap` in Rust. Pass the block timestamp from Go to Rust as an argument; never ask the OS for time in Rust.
  * **The "CGo Overhead" Myth:**
      * Calling CGo has an overhead (\~170ns).
      * *Advice:* Do not call Rust 1,000 times inside a loop for tiny additions. Call Rust **once** with a big payload, process it all, and return one result.
  * **Linking Issues:**
      * When you compile `ethermintd`, you must tell the linker where your Rust `.so` file is.
      * *Flag:* `LD_LIBRARY_PATH=/path/to/rust/target/release ./ethermintd start`

### Summary Recommendation

1.  **Keep the CGo Wrapper:** It is the correct architectural choice for integrating heavy Rust logic into Ethermint.
2.  **Use a Precompile:** Expose the Rust logic as a precompiled contract at a specific address (e.g., `0x000...99`). This allows your EVM contracts to access the Rust logic directly.
3.  **Mock it first:** For the very first day of the testnet, you can have the Go wrapper return "hardcoded" values to ensure the chain starts, then swap in the real Rust library linkage.
```

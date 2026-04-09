package main

// addUint64 returns a+b and whether the addition overflowed uint64.
func addUint64(a, b uint64) (uint64, bool) {
	c := a + b
	if c < a {
		return 0, true
	}
	return c, false
}

// mulUint64 returns a*b and whether the multiplication overflowed uint64.
func mulUint64(a, b uint64) (uint64, bool) {
	if a == 0 || b == 0 {
		return 0, false
	}
	c := a * b
	if c/b != a {
		return 0, true
	}
	return c, false
}

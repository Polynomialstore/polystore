#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SRC_DARK="${ROOT_DIR}/brand-src/logo-dark.png"
SRC_LIGHT="${ROOT_DIR}/brand-src/logo-light.png"
OUT_BRAND_DIR="${ROOT_DIR}/public/brand"

OUT_FAV_LIGHT="${ROOT_DIR}/public/favicon-light-32.png"
OUT_FAV_DARK="${ROOT_DIR}/public/favicon-dark-32.png"
OUT_FAV_ICO="${ROOT_DIR}/public/favicon.ico"
OUT_APPLE="${ROOT_DIR}/public/apple-touch-icon.png"

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' not found. Install ImageMagick or update this script to use an alternative tool." >&2
  exit 1
fi

if [[ ! -f "${SRC_DARK}" ]]; then
  echo "error: missing source asset: ${SRC_DARK}" >&2
  exit 1
fi

if [[ ! -f "${SRC_LIGHT}" ]]; then
  echo "error: missing source asset: ${SRC_LIGHT}" >&2
  exit 1
fi

mkdir -p "${OUT_BRAND_DIR}"

resize_square() {
  local src="$1"
  local size="$2"
  local out="$3"

  magick "${src}" \
    -filter Lanczos \
    -resize "${size}x${size}" \
    -strip \
    -define png:compression-level=9 \
    "${out}"
}

# Navbar (36px, 2x for retina)
resize_square "${SRC_DARK}" 36 "${OUT_BRAND_DIR}/logo-dark-36.png"
resize_square "${SRC_DARK}" 72 "${OUT_BRAND_DIR}/logo-dark-72.png"
resize_square "${SRC_LIGHT}" 36 "${OUT_BRAND_DIR}/logo-light-36.png"
resize_square "${SRC_LIGHT}" 72 "${OUT_BRAND_DIR}/logo-light-72.png"

# Homepage hero (256px, 2x for retina)
resize_square "${SRC_DARK}" 256 "${OUT_BRAND_DIR}/logo-dark-256.png"
resize_square "${SRC_DARK}" 512 "${OUT_BRAND_DIR}/logo-dark-512.png"
resize_square "${SRC_LIGHT}" 256 "${OUT_BRAND_DIR}/logo-light-256.png"
resize_square "${SRC_LIGHT}" 512 "${OUT_BRAND_DIR}/logo-light-512.png"

# Favicons (light/dark)
resize_square "${SRC_LIGHT}" 32 "${OUT_FAV_LIGHT}"
resize_square "${SRC_DARK}" 32 "${OUT_FAV_DARK}"

# Legacy favicon.ico (not theme-aware)
magick "${SRC_LIGHT}" -strip -define icon:auto-resize=16,32,48 "${OUT_FAV_ICO}"

# Apple touch icon (single, non-theme aware)
resize_square "${SRC_LIGHT}" 180 "${OUT_APPLE}"

echo "ok: generated brand assets in ${OUT_BRAND_DIR}"

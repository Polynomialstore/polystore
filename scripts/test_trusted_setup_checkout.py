"""Check setup byte identity after a Windows-style Git checkout; stdlib only."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile


def check():
    root = Path(__file__).resolve().parent.parent
    paths = ("polystorechain/trusted_setup.txt",
             "polystore-website/public/trusted_setup.txt", "demos/kzg/trusted_setup.txt")
    approved = "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7"
    with tempfile.TemporaryDirectory(prefix="polystore-setup-checkout-") as directory:
        repo = Path(directory)

        def git(*args):
            subprocess.run(["git", "-C", str(repo), *args], check=True, timeout=15)

        git("init", "-q")
        shutil.copyfile(root / ".gitattributes", repo / ".gitattributes")
        for path in paths:
            target = repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / path, target)
        git("-c", "core.autocrlf=false", "add", ".")
        git("-c", "core.autocrlf=true", "-c", "core.eol=crlf", "checkout-index",
            "--force", "--prefix=" + str(repo / "checkout") + "/", "--", *paths)
        for path in paths:
            digest = hashlib.sha256((repo / "checkout" / path).read_bytes()).hexdigest()
            assert digest == approved, (path, digest)
    print("PASS: all three approved setup copies survive core.autocrlf=true unchanged")


if __name__ == "__main__":
    check()

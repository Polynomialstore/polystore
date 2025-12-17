#!/bin/bash
echo "Committing build fixes (OpfsAdapter any fix)..."
git commit -am "fix(build): resolve ts errors in OpfsAdapter (any cast)"
echo "Pushing to remote..."
git push
echo "Done!"
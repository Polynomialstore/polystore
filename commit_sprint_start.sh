#!/bin/bash
echo "Committing sprint start and fixes..."
git commit -am "feat(ui): implement useDirectUpload/Commit hooks and integrate into FileSharder; feat(gateway): add direct MDU upload endpoint; fix(ui): wasm json parsing; docs: gamma-3 plan"
echo "Pushing to remote..."
git push
echo "Done!"

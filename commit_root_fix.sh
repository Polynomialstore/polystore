#!/bin/bash
echo "Committing root extraction fallback fix..."
git commit -am "fix(ui): add manifest root fallback to first commitment in FileSharder"
echo "Pushing to remote..."
git push
echo "Done!"
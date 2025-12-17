#!/bin/bash
echo "Committing gateway fix..."
git commit -am "fix(gateway): add /health endpoint with CORS"
echo "Pushing to remote..."
git push
echo "Done!"

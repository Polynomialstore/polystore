#!/bin/bash
echo "Committing fixes (CORS, UI, Tests)..."
git commit -am "fix(gateway): add CORS headers for direct upload; feat(ui): enforce linear upload/commit flow; test(e2e): add direct upload test"
echo "Pushing to remote..."
git push
echo "Done!"

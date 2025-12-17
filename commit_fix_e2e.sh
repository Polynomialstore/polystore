#!/bin/bash
echo "Committing E2E fix..."
git commit -am "fix(e2e): handle auto-connect in deal-id-zero test"
echo "Pushing to remote..."
git push
echo "Done!"

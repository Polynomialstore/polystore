#!/bin/bash
echo "Committing sprint completion..."
git commit -am "docs: mark gamma-3 as complete and activate gamma-4"
echo "Pushing to remote..."
git push
echo "Done!"

#!/bin/bash
echo "Committing UI polish for FileSharder..."
git commit -am "feat(ui): add explicit sharding/upload/commit status to FileSharder"
echo "Pushing to remote..."
git push
echo "Done!"

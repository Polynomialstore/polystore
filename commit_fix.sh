#!/bin/bash
echo "Committing fixes..."
git commit -am "fix(lint): resolve eslint errors and warnings"
echo "Pushing to remote..."
git push
echo "Done!"

#!/bin/bash
echo "Committing stack split and frontend config..."
git commit -am "chore(scripts): split local stack into SP (8082) and User (8080); feat(ui): point direct upload to SP port"
echo "Pushing to remote..."
git push
echo "Done!"
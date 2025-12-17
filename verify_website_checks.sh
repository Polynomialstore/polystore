#!/bin/bash
echo "Running website unit tests..."
npm run test:unit --prefix nil-website

echo "Running website lint checks..."
npm run lint --prefix nil-website

echo "Please review the output above to verify checks pass."

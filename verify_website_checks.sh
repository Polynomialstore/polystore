#!/bin/bash
echo "Running website unit tests..."
npm run test:unit --prefix polystore-website

echo "Running website lint checks..."
npm run lint --prefix polystore-website

echo "Please review the output above to verify checks pass."

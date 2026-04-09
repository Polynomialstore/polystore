#!/bin/bash
# S3 Adapter E2E Test

# 1. Start S3 Server
cd polystore_gateway
./polystore_gateway &
S3_PID=$!
echo "S3 Server started at PID $S3_PID"
sleep 2

# 2. Create a test file
echo "Hello PolyStore S3 World!" > test_obj.txt

# 3. Upload file
echo "Uploading file..."
curl -X PUT --data-binary @test_obj.txt http://localhost:8080/api/v1/object/test_obj.txt

# 4. Cleanup
kill $S3_PID
rm test_obj.txt

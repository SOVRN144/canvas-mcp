#!/bin/bash

# Simple smoke test for file extract/download functionality

echo "=== File Extract/Download Smoke Test ==="

# Check if dependencies are available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    exit 1
fi

# Check if the files module exists
if [ ! -f "src/files.ts" ]; then
    echo "❌ src/files.ts not found"
    exit 1
fi

# Check if the HTTP module has been updated
if ! grep -q "extract_file" src/http.ts; then
    echo "❌ extract_file tool not found in src/http.ts"
    exit 1
fi

if ! grep -q "extractFileContent" src/http.ts; then
    echo "❌ extractFileContent import not found in src/http.ts"
    exit 1
fi

# Check if test files exist
if [ ! -f "tests/files.extract.test.ts" ] || [ ! -f "tests/files.download.test.ts" ]; then
    echo "❌ Test files not found"
    exit 1
fi

# Check package.json for required dependencies
for dep in "pdf-parse" "mammoth" "jszip"; do
    if ! grep -q "\"$dep\"" package.json; then
        echo "❌ Missing dependency: $dep"
        exit 1
    fi
done

echo "✅ Files structure check passed"
echo "✅ Dependencies check passed"
echo "✅ Tool registration check passed"
echo ""
echo "📝 Manual verification needed:"
echo "   - Run the server and check tools/list includes 'extract_file' and 'download_file'"
echo "   - Test extract_file with a real Canvas file ID"
echo "   - Test download_file with a small Canvas file ID"
echo ""
echo "🎉 Smoke test completed successfully"
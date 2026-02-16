#!/bin/bash
# Test that dashboard can find config when ao start is run from project directory

set -e

# Find the repo root (where this script is located) BEFORE changing directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

echo "🧪 Testing config discovery fix..."
echo ""

# Setup
TEST_DIR="/tmp/ao-config-test-$$"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo "📁 Test directory: $TEST_DIR"
echo "📦 Repo root: $REPO_ROOT"
echo ""

# Create a config file in the test directory
cat > agent-orchestrator.yaml << 'EOF'
dataDir: ~/.agent-orchestrator-config-test
worktreeDir: ~/.worktrees-config-test
port: 4567

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  test-project:
    repo: test/test-repo
    path: /tmp/test-path
    defaultBranch: main
EOF

echo "✅ Created agent-orchestrator.yaml in $TEST_DIR"
echo ""

# Test 1: Verify findConfigFile works
echo "Test 1: findConfigFile should find config in current directory"
node -e "
  const { findConfigFile } = require('$REPO_ROOT/packages/core/dist/index.js');
  process.chdir('$TEST_DIR');
  const found = findConfigFile();
  if (!found) {
    console.error('❌ FAIL: findConfigFile returned null');
    process.exit(1);
  }
  if (!found.endsWith('agent-orchestrator.yaml')) {
    console.error('❌ FAIL: Wrong config found:', found);
    process.exit(1);
  }
  console.log('✅ PASS: Config found at', found);
"
echo ""

# Test 2: Verify AO_CONFIG_PATH env var works
echo "Test 2: AO_CONFIG_PATH environment variable should override default search"
AO_CONFIG_PATH="$TEST_DIR/agent-orchestrator.yaml" node -e "
  const { findConfigFile } = require('$REPO_ROOT/packages/core/dist/index.js');
  const found = findConfigFile();
  if (!found) {
    console.error('❌ FAIL: findConfigFile returned null');
    process.exit(1);
  }
  if (found !== process.env.AO_CONFIG_PATH) {
    console.error('❌ FAIL: Did not use AO_CONFIG_PATH. Got:', found);
    process.exit(1);
  }
  console.log('✅ PASS: Used AO_CONFIG_PATH:', found);
"
echo ""

# Test 3: Verify loadConfig uses AO_CONFIG_PATH
echo "Test 3: loadConfig should load from AO_CONFIG_PATH"
AO_CONFIG_PATH="$TEST_DIR/agent-orchestrator.yaml" node -e "
  const { loadConfig } = require('$REPO_ROOT/packages/core/dist/index.js');
  const config = loadConfig();
  if (config.port !== 4567) {
    console.error('❌ FAIL: Wrong config loaded. Port:', config.port);
    process.exit(1);
  }
  console.log('✅ PASS: Loaded correct config. Port:', config.port);
"
echo ""

# Cleanup
cd /
rm -rf "$TEST_DIR"
echo "🧹 Cleaned up test directory"
echo ""
echo "🎉 All tests passed! Config discovery fix works correctly."

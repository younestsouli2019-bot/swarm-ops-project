#!/bin/bash
# Start the Next.js dev server in a fully detached background process.
# Designed to survive across bash tool calls in the sandbox.
#
# Usage: bash /home/z/my-project/scripts/start_dev_server.sh
# Check: curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/

cd /home/z/my-project

# Kill any existing dev server
pkill -f "next dev" 2>/dev/null
sleep 2

# Clear any stale lock
rm -f .next/dev/lock 2>/dev/null

# Start the dev server with full detachment:
# - setsid: new session, no controlling terminal
# - nohup: ignore SIGHUP
# - </dev/null: no stdin
# - &>: redirect all output
# - disown: remove from shell's job table
nohup setsid node /home/z/my-project/node_modules/next/dist/bin/next dev -p 3000 \
  </dev/null \
  >/home/z/my-project/dev.log 2>&1 &
DEV_PID=$!
disown $DEV_PID 2>/dev/null || true

echo "Dev server PID: $DEV_PID"
echo "$DEV_PID" > /home/z/my-project/.zscripts/dev.pid

# Wait for it to be ready
for i in $(seq 1 30); do
  if curl -s -m 2 -o /dev/null http://localhost:3000/ 2>/dev/null; then
    echo "Dev server is ready on port 3000 (after ${i}s)"
    exit 0
  fi
  sleep 1
done

echo "ERROR: Dev server did not become ready in 30s"
echo "--- dev.log ---"
cat /home/z/my-project/dev.log
exit 1

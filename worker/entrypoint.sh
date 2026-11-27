#!/bin/sh
# On the GPU cloud (RunPod sets RUNPOD_ENDPOINT_ID) answer requests; anywhere else, poll for jobs.
set -e
cd /opt/intus/worker
if [ -n "$RUNPOD_ENDPOINT_ID" ]; then exec python3 -u handler.py; fi
exec python3 -u worker.py "${@:-poll}"

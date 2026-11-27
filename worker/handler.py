"""GPU-cloud entry point (RunPod serverless): each request names one job, which this container processes.

Intus admin starts a request with {"input": {"job": "<job id>"}} when a version has a GPU endpoint.
The endpoint's environment holds INTUS_WORKER_KEY and INTUS_API; SPIRULA_VERSION is baked into the image.
"""
import runpod

import worker


def handler(event):
    job = (event or {}).get("input", {}).get("job")
    return {"status": worker.run_job(job)}


if __name__ == "__main__":
    worker.WORK.mkdir(parents=True, exist_ok=True)
    runpod.serverless.start({"handler": handler})

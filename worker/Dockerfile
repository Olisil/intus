# Intus GPU worker: one image per Spirula version.
#   docker build -f worker/Dockerfile --build-arg SPIRULA_VERSION=v2026.11.12 -t ghcr.io/olisil/intus-worker:spirula-v2026.11.12 .
# Needs an NVIDIA GPU with the container toolkit (Vulkan through the NVIDIA driver).
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

ARG SPIRULA_VERSION=v2026.11.12
ARG SPIRULA_REPO=harry7557558/spirula-studio
ENV SPIRULA_VERSION=${SPIRULA_VERSION} \
    SPIRULA=/opt/spirula/spirula \
    XDG_CACHE_HOME=/opt/cache \
    WORK_DIR=/work \
    NVIDIA_DRIVER_CAPABILITIES=all \
    DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Vulkan loader, the libraries the Spirula binary links (GL/X/Wayland for its window, unused here), ffmpeg, Python, Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip ffmpeg python3 python3-pip \
      libvulkan1 libopengl0 libgomp1 libgl1 libegl1 libx11-6 libxrandr2 libxinerama1 libxcursor1 libxi6 libxext6 libxkbcommon0 libxkbcommon-x11-0 libwayland-client0 libwayland-cursor0 libwayland-egl1 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Vulkan finds the NVIDIA driver through this file; the container toolkit mounts the driver itself.
RUN mkdir -p /etc/vulkan/icd.d && printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}\n' > /etc/vulkan/icd.d/nvidia_icd.json

# Spirula: the release's Linux build
RUN mkdir -p /opt/spirula && cd /opt/spirula \
    && curl -fsSL -o spirula.zip "https://github.com/${SPIRULA_REPO}/releases/download/${SPIRULA_VERSION}/spirula-${SPIRULA_VERSION#v}-ubuntu-vulkan-x86_64.zip" \
    && unzip spirula.zip && rm spirula.zip && chmod +x spirula && ./spirula train --help > /dev/null

# Masking weights in Spirula's own cache: SAM 2.1 Base+ (Apache-2.0) and Grounding DINO Tiny (Apache-2.0)
RUN M=/opt/cache/spirula-studio/models && mkdir -p $M && cd $M \
    && curl -fsSL -o sam2.1_hiera_base_plus_f16.ggml https://huggingface.co/PABannier/sam3.cpp/resolve/main/sam2.1_hiera_base_plus_f16.ggml \
    && curl -fsSL -o grounding-dino-tiny.safetensors https://huggingface.co/IDEA-Research/grounding-dino-tiny/resolve/main/model.safetensors \
    && curl -fsSL -o bert-base-uncased-vocab.txt https://huggingface.co/IDEA-Research/grounding-dino-tiny/resolve/main/vocab.txt

# splat-transform for SOG compression and the collision mesh (publish_tour.py prefers an installed one)
RUN npm install -g @playcanvas/splat-transform@3

COPY tools /opt/intus/tools
COPY worker /opt/intus/worker
RUN pip3 install --no-cache-dir -r /opt/intus/tools/requirements.txt -r /opt/intus/worker/requirements.txt

WORKDIR /opt/intus/worker
ENTRYPOINT ["/opt/intus/worker/entrypoint.sh"]

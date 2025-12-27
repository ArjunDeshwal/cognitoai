#!/bin/bash

# This script bundles the Python backend into a standalone executable using PyInstaller.
# It should be run from the backend directory.

# Install dependencies if not already done
pip install -r requirements.txt

# Run PyInstaller
# --onefile: Create a single executable
# --name api: Name the output 'api' (or 'api.exe' on Windows)
# --collect-all: Ensure all files for these libraries are included
# --hidden-import: uvicorn needs these to find its own modules when bundled

pyinstaller --onefile --noconfirm \
    --name api \
    --add-data "../tools:tools" \
    --collect-all llama_cpp \
    --collect-all sentence_transformers \
    --collect-all faiss \
    --collect-all langchain_text_splitters \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan \
    --hidden-import uvicorn.lifespan.on \
    server.py

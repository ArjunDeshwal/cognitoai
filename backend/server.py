import os
import sys
import httpx
import json
import re
import uuid
from fastapi import FastAPI, HTTPException, Body, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
from llama_cpp import Llama
import asyncio

# Handle PyInstaller bundle path for imports
if getattr(sys, 'frozen', False):
    # If the app is running as a bundle (PyInstaller)
    bundle_dir = sys._MEIPASS
    sys.path.append(bundle_dir)
else:
    # If running normally (dev mode)
    bundle_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.append(os.path.join(bundle_dir, '..'))

# Import document RAG module
try:
    from document_rag import document_store, extract_text_from_pdf, chunk_text
    RAG_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import document_rag: {e}. Document RAG will be disabled.")
    RAG_AVAILABLE = False

# Try importing the tool
try:
    from tools.info.web_search import search_web_standalone
    TOOLS_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import tools: {e}. Web search will be disabled.")
    TOOLS_AVAILABLE = False

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

llm = None
current_model_name = None

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    messages: List[ChatMessage]
    model_path: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096
    stream: bool = False
    deep_search: bool = False  # Deep search flag
    use_documents: bool = False  # RAG mode flag

@app.get("/health")
def health_check():
    doc_count = len(document_store.get_documents()) if RAG_AVAILABLE else 0
    return {
        "status": "ok", 
        "tools_available": TOOLS_AVAILABLE,
        "rag_available": RAG_AVAILABLE,
        "model_loaded": llm is not None,
        "model_name": current_model_name,
        "documents_count": doc_count
    }

@app.post("/v1/load_model")
def load_model(path: str = Body(..., embed=True)):
    global llm, current_model_name
    if not os.path.exists(path):
        raise HTTPException(status_code=400, detail="Model file not found")
    
    try:
        llm = Llama(model_path=path, n_gpu_layers=-1, verbose=True, n_ctx=8192)
        current_model_name = os.path.basename(path)
        return {"status": "success", "message": f"Loaded model: {path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def get_tool_system_prompt() -> str:
    """
    System prompt that tells the model it can request a web search.
    The model decides when to search - it outputs [SEARCH: query] to trigger search.
    """
    return """# INSTRUCTION: Agentic Search Capability

You are an AI assistant with access to a REAL-TIME WEB SEARCH tool. 

## WHEN TO SEARCH
- If the user asks for news, current events, or recent developments (today, this week, 2024, 2025 etc).
- If you need to verify facts, dates, or technical data of which you are unsure.
- If the user explicitly asks you to search.
- When asked about a specific person, product, or company that might have recent updates.

## HOW TO SEARCH
To trigger a search, you MUST output a specific command at the VERY BEGINNING of your response. 
Format: [SEARCH: your search query here]

Example:
User: "What is the price of Bitcoin right now?"
Assistant: [SEARCH: current price of Bitcoin in USD]

## IMPORTANT
1. You MUST use the exact format: [SEARCH: ...]
2. Once you output the search command, the system will provide the search results.
3. Your search query should be concise and optimized for a search engine.
4. If a search is needed, do NOT attempt to answer until you have search results.
"""


def parse_search_request(text: str) -> tuple[bool, str]:
    """Parse model output to see if it's requesting a search."""
    import re
    match = re.search(r'\[SEARCH:\s*(.+?)\]', text, re.IGNORECASE)
    if match:
        return True, match.group(1).strip()
    return False, ""


def decompose_query(query: str) -> List[str]:
    """
    Decompose a complex query into multiple sub-queries for deep search.
    Uses simple keyword extraction and reformulation.
    """
    sub_queries = [query]  # Always include original
    
    # Extract key phrases
    query_lower = query.lower()
    
    # Common question patterns to decompose
    if "what are" in query_lower or "what is" in query_lower:
        # Add definition-focused query
        sub_queries.append(f"{query} definition explanation")
    
    if "how" in query_lower:
        sub_queries.append(f"{query} guide tutorial")
    
    if "why" in query_lower:
        sub_queries.append(f"{query} reasons analysis")
    
    # Extract year references and search with current context
    year_match = re.search(r'20\d{2}', query)
    if year_match:
        year = year_match.group()
        # Add recent news query
        sub_queries.append(f"{query} latest news {year}")
    else:
        # Add current year context
        sub_queries.append(f"{query} 2024 2025 latest")
    
    # Add industry/impact perspective
    keywords = ["regulation", "policy", "law", "act", "impact", "effect", "implication"]
    if any(kw in query_lower for kw in keywords):
        sub_queries.append(f"{query} industry response companies")
        sub_queries.append(f"{query} expert analysis opinion")
    
    # Extract named entities and search specifically
    # Look for capitalized words that might be entities
    words = query.split()
    entities = [w for w in words if w[0].isupper() and len(w) > 2]
    if entities:
        entity_query = " ".join(entities) + " latest news"
        sub_queries.append(entity_query)
    
    # Limit to 4 sub-queries max
    return list(set(sub_queries))[:4]


async def deep_search(client: httpx.AsyncClient, query: str, on_status) -> str:
    """
    Perform deep search by decomposing query into sub-queries and combining results.
    """
    sub_queries = decompose_query(query)
    all_results = []
    
    print(f"[Deep Search] Decomposed into {len(sub_queries)} sub-queries: {sub_queries}")
    
    for i, sub_query in enumerate(sub_queries):
        try:
            on_status(f"Deep searching ({i+1}/{len(sub_queries)}): {sub_query[:50]}...")
            result = await search_web_standalone(client, sub_query)
            if result and "No results" not in result and "Search failed" not in result:
                all_results.append(f"### Search: {sub_query}\n{result}")
        except Exception as e:
            print(f"[Deep Search] Sub-query failed: {sub_query} - {e}")
    
    if all_results:
        combined = "\n\n---\n\n".join(all_results)
        return f"[DEEP SEARCH - {len(sub_queries)} queries performed]\n\n{combined}"
    else:
        return "Deep search found no results."


async def generate_stream_with_search(
    messages_payload: list, 
    temperature: float, 
    max_tokens: int,
    needs_search: bool,  # ignored now - model decides
    search_query: str,   # ignored now - model decides
    deep_search_enabled: bool = False,
    use_documents: bool = False
):
    """
    Async generator for streaming responses.
    MODEL decides whether to search by outputting [SEARCH: query].
    """
    global llm
    
    # Inject document context if RAG is enabled
    if use_documents and RAG_AVAILABLE:
        user_query = messages_payload[-1]['content'] if messages_payload else ""
        doc_context = document_store.get_context_for_query(user_query)
        if doc_context:
            yield f"data: {json.dumps({'status': 'retrieving_docs'})}\n\n"
            doc_instruction = f"[DOCUMENT CONTEXT]:\n{doc_context}\n\n[INSTRUCTION]: Use the above document excerpts to answer the user's question."
            messages_payload.insert(-1, {"role": "system", "content": doc_instruction})
    
    # Add tool system prompt if tools available
    if TOOLS_AVAILABLE:
        tool_prompt = get_tool_system_prompt()
        # Find index of last system message to insert after it, or insert at 0
        insert_idx = 0
        for i, msg in enumerate(messages_payload):
            if msg['role'] == 'system':
                insert_idx = i + 1
            else:
                break # Stop at first non-system message
        messages_payload.insert(insert_idx, {"role": "system", "content": tool_prompt})
    
    yield f"data: {json.dumps({'status': 'generating'})}\n\n"
    
    try:
        # First pass - let model respond (may request search)
        def run_stream():
            return llm.create_chat_completion(
                messages=messages_payload,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True
            )
        
        stream = await asyncio.to_thread(run_stream)
        
        collected_response = ""
        search_requested = False
        search_query_from_model = ""
        
        for chunk in stream:
            if 'choices' in chunk and len(chunk['choices']) > 0:
                delta = chunk['choices'][0].get('delta', {})
                content = delta.get('content', '')
                if content:
                    collected_response += content
                    
                    # Check if model is requesting search
                    needs_search, query = parse_search_request(collected_response)
                    if needs_search and not search_requested:
                        search_requested = True
                        search_query_from_model = query
                        # Don't yield the search request to user
                        break
                    
                    yield f"data: {json.dumps({'content': content})}\n\n"
        
        # If model requested search, do it and continue
        if search_requested and TOOLS_AVAILABLE:
            print(f"[Search] Model requested search: {search_query_from_model}")
            yield f"data: {json.dumps({'status': 'searching', 'query': search_query_from_model})}\n\n"
            
            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    if deep_search_enabled:
                        async def send_status(msg): print(f"[Search] {msg}")
                        search_result = await deep_search(client, search_query_from_model, send_status)
                    else:
                        search_result = await search_web_standalone(client, search_query_from_model)
                
                yield f"data: {json.dumps({'status': 'search_complete'})}\n\n"
                
                # Add search results and continue generation
                messages_payload.append({"role": "assistant", "content": f"[SEARCH: {search_query_from_model}]"})
                messages_payload.append({"role": "system", "content": f"[SEARCH RESULTS]:\n{search_result}\n\nNow answer based on these results:"})
                
                yield f"data: {json.dumps({'status': 'generating'})}\n\n"
                
                # Second pass with search results
                stream2 = await asyncio.to_thread(run_stream)
                for chunk in stream2:
                    if 'choices' in chunk and len(chunk['choices']) > 0:
                        delta = chunk['choices'][0].get('delta', {})
                        content = delta.get('content', '')
                        if content and '[SEARCH:' not in content:
                            yield f"data: {json.dumps({'content': content})}\n\n"
                
            except Exception as e:
                print(f"[Search] Failed: {e}")
                yield f"data: {json.dumps({'status': 'search_failed', 'error': str(e)})}\n\n"
        
        yield "data: [DONE]\n\n"
        
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    global llm
    if not llm:
        raise HTTPException(status_code=400, detail="No model loaded. Call /v1/load_model first.")

    messages_payload = [{"role": m.role, "content": m.content} for m in request.messages]
    
    # Model decides whether to search via [SEARCH:] pattern - no hardcoded check

    if request.stream:
        return StreamingResponse(
            generate_stream_with_search(
                messages_payload, 
                request.temperature, 
                request.max_tokens,
                False,  # ignored - model decides
                "",     # ignored - model decides
                request.deep_search,
                request.use_documents
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        )
    else:
        # Non-streaming: Add tool prompt and let model decide
        if TOOLS_AVAILABLE:
            tool_prompt = get_tool_system_prompt()
            insert_idx = 0
            for i, msg in enumerate(messages_payload):
                if msg['role'] == 'system':
                    insert_idx = i + 1
                else:
                    break
            messages_payload.insert(insert_idx, {"role": "system", "content": tool_prompt})
        
        try:
            output = await asyncio.to_thread(
                llm.create_chat_completion,
                messages=messages_payload,
                temperature=request.temperature,
                max_tokens=request.max_tokens
            )
            
            # Check if model requested search
            if output and 'choices' in output and len(output['choices']) > 0:
                assistant_msg = output['choices'][0].get('message', {}).get('content', '')
                needs_search, search_query = parse_search_request(assistant_msg)
                
                if needs_search and TOOLS_AVAILABLE:
                    # Perform search and regenerate
                    async with httpx.AsyncClient(timeout=30) as client:
                        if request.deep_search:
                            search_result = await deep_search(client, search_query, lambda x: None)
                        else:
                            search_result = await search_web_standalone(client, search_query)
                    
                    messages_payload.append({"role": "assistant", "content": f"[SEARCH: {search_query}]"})
                    messages_payload.append({"role": "system", "content": f"[SEARCH RESULTS]:\n{search_result}\n\nNow answer:"})
                    
                    output = await asyncio.to_thread(
                        llm.create_chat_completion,
                        messages=messages_payload,
                        temperature=request.temperature,
                        max_tokens=request.max_tokens
                    )
            
            return output
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# MODEL DOWNLOAD FEATURE
# =============================================================================

# Default models directory
MODELS_DIR = os.path.expanduser("~/cognito-models")
os.makedirs(MODELS_DIR, exist_ok=True)

class ModelDownloadRequest(BaseModel):
    repo_id: str  # e.g., "TheBloke/Mistral-7B-Instruct-v0.2-GGUF"
    filename: str  # e.g., "mistral-7b-instruct-v0.2.Q4_K_M.gguf"


@app.get("/v1/models/search")
async def search_models(q: str = "", limit: int = 20):
    """Search Hugging Face for GGUF models."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            # Search HF API for GGUF models
            search_url = "https://huggingface.co/api/models"
            params = {
                "search": q,
                "filter": "gguf",
                "sort": "downloads",
                "direction": -1,
                "limit": limit
            }
            response = await client.get(search_url, params=params)
            response.raise_for_status()
            models = response.json()
            
            # Format results
            results = []
            for model in models:
                results.append({
                    "id": model.get("id", ""),
                    "author": model.get("author", ""),
                    "downloads": model.get("downloads", 0),
                    "likes": model.get("likes", 0),
                    "lastModified": model.get("lastModified", ""),
                    "tags": model.get("tags", [])[:5]  # Limit tags
                })
            
            return {"models": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@app.get("/v1/models/files/{repo_id:path}")
async def get_model_files(repo_id: str):
    """Get list of GGUF files in a repository."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
            response = await client.get(url)
            response.raise_for_status()
            files = response.json()
            
            # Filter for GGUF files only
            gguf_files = []
            for f in files:
                if f.get("path", "").endswith(".gguf"):
                    gguf_files.append({
                        "name": f.get("path", ""),
                        "size": f.get("size", 0),
                        "sizeFormatted": format_size(f.get("size", 0))
                    })
            
            return {"files": gguf_files}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get files: {str(e)}")


def format_size(size_bytes):
    """Format bytes to human readable."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


@app.post("/v1/models/download")
async def download_model(request: ModelDownloadRequest):
    """Download a model from Hugging Face with progress streaming."""
    repo_id = request.repo_id
    filename = request.filename
    
    async def download_stream():
        try:
            download_url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
            local_path = os.path.join(MODELS_DIR, filename)
            
            yield f"data: {json.dumps({'status': 'starting', 'filename': filename})}\n\n"
            
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
                async with client.stream("GET", download_url) as response:
                    response.raise_for_status()
                    total_size = int(response.headers.get("content-length", 0))
                    downloaded = 0
                    
                    yield f"data: {json.dumps({'status': 'downloading', 'total': total_size, 'totalFormatted': format_size(total_size)})}\n\n"
                    
                    with open(local_path, "wb") as f:
                        last_progress = 0
                        async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):  # 1MB chunks
                            f.write(chunk)
                            downloaded += len(chunk)
                            
                            # Send progress every 5%
                            progress = int((downloaded / total_size) * 100) if total_size else 0
                            if progress >= last_progress + 5:
                                last_progress = progress
                                yield f"data: {json.dumps({'status': 'progress', 'downloaded': downloaded, 'total': total_size, 'percent': progress})}\n\n"
                    
                    yield f"data: {json.dumps({'status': 'complete', 'path': local_path, 'filename': filename})}\n\n"
                    
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'error': str(e)})}\n\n"
    
    return StreamingResponse(
        download_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


@app.get("/v1/models/local")
async def list_local_models():
    """List locally downloaded models."""
    try:
        models = []
        for filename in os.listdir(MODELS_DIR):
            if filename.endswith(".gguf"):
                filepath = os.path.join(MODELS_DIR, filename)
                size = os.path.getsize(filepath)
                models.append({
                    "name": filename,
                    "path": filepath,
                    "size": size,
                    "sizeFormatted": format_size(size)
                })
        
        return {"models": models, "directory": MODELS_DIR}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list models: {str(e)}")


@app.delete("/v1/models/local/{filename}")
async def delete_local_model(filename: str):
    """Delete a locally downloaded model."""
    try:
        filepath = os.path.join(MODELS_DIR, filename)
        if os.path.exists(filepath):
            os.remove(filepath)
            return {"status": "deleted", "filename": filename}
        else:
            raise HTTPException(status_code=404, detail="Model not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete: {str(e)}")


# =============================================================================
# DOCUMENT RAG FEATURE
# =============================================================================

@app.post("/v1/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    """Upload a document for RAG processing."""
    if not RAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="Document RAG is not available")
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    # Check file type
    allowed_extensions = ['.pdf', '.txt']
    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400, 
            detail=f"Unsupported file type. Allowed: {', '.join(allowed_extensions)}"
        )
    
    try:
        # Read file content
        file_bytes = await file.read()
        
        # Extract text based on file type
        if file_ext == '.pdf':
            text = extract_text_from_pdf(file_bytes)
        elif file_ext == '.txt':
            text = file_bytes.decode('utf-8')
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type")
        
        if not text.strip():
            raise HTTPException(status_code=400, detail="Could not extract text from document")
        
        # Chunk the text
        chunks = chunk_text(text, chunk_size=400, overlap=50)
        
        # Generate document ID and store
        doc_id = str(uuid.uuid4())[:8]
        result = document_store.add_document(doc_id, file.filename, text, chunks)
        
        return {
            "status": "success",
            "document": result,
            "message": f"Document processed: {len(chunks)} chunks created"
        }
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process document: {str(e)}")


@app.get("/v1/documents")
async def list_documents():
    """List all uploaded documents."""
    if not RAG_AVAILABLE:
        return {"documents": [], "rag_available": False}
    
    return {
        "documents": document_store.get_documents(),
        "rag_available": True
    }


@app.delete("/v1/documents/{doc_id}")
async def delete_document(doc_id: str):
    """Delete an uploaded document."""
    if not RAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="Document RAG is not available")
    
    if document_store.remove_document(doc_id):
        return {"status": "deleted", "doc_id": doc_id}
    else:
        raise HTTPException(status_code=404, detail="Document not found")


@app.delete("/v1/documents")
async def clear_all_documents():
    """Clear all uploaded documents."""
    if not RAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="Document RAG is not available")
    
    docs = document_store.get_documents()
    for doc in docs:
        document_store.remove_document(doc["id"])
    
    return {"status": "cleared", "documents_removed": len(docs)}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="127.0.0.1", port=port)


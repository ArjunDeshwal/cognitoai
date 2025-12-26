import re
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
from langchain_text_splitters import RecursiveCharacterTextSplitter
import asyncio
import aiohttp
from bs4 import BeautifulSoup
import random
from urllib.parse import quote_plus

# Optional import for pydantic_ai compatibility
try:
    from pydantic_ai import RunContext
    from tools.deps import Deps
    PYDANTIC_AI_AVAILABLE = True
except ImportError:
    PYDANTIC_AI_AVAILABLE = False

# Initialize embedding model once (lazy load to speed up startup)
_embed_model = None

def get_embed_model():
    global _embed_model
    if _embed_model is None:
        print("[Search] Loading embedding model...")
        _embed_model = SentenceTransformer("BAAI/bge-small-en-v1.5")
        print("[Search] Embedding model loaded.")
    return _embed_model

# Text splitter for chunking web content
text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=60)

# User agents for requests
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

def get_headers():
    return {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
    }


async def duckduckgo_search(query: str, num_results: int = 8) -> list:
    """
    Performs a DuckDuckGo search and returns a list of results.
    Each result is a dict with 'title', 'url', 'snippet'.
    """
    results = []
    search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(search_url, headers=get_headers(), timeout=15) as response:
                if response.status != 200:
                    print(f"[DDG Search] Got status {response.status}")
                    return []
                
                html = await response.text()
                soup = BeautifulSoup(html, 'html.parser')
                
                # DuckDuckGo HTML results are in .result class
                for result in soup.select('.result')[:num_results]:
                    title_elem = result.select_one('.result__title a')
                    snippet_elem = result.select_one('.result__snippet')
                    
                    if title_elem:
                        # DDG uses redirects, extract actual URL
                        href = title_elem.get('href', '')
                        # Parse the uddg parameter for actual URL
                        if 'uddg=' in href:
                            import urllib.parse
                            parsed = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
                            url = parsed.get('uddg', [''])[0]
                        else:
                            url = href
                        
                        results.append({
                            'title': title_elem.get_text(strip=True),
                            'url': url,
                            'snippet': snippet_elem.get_text(strip=True) if snippet_elem else ''
                        })
                
                print(f"[DDG Search] Found {len(results)} results for: {query}")
                
    except Exception as e:
        print(f"[DDG Search] Error: {e}")
    
    return results


async def fetch_page_content(session: aiohttp.ClientSession, url: str) -> str:
    """Fetches and cleans HTML content from a URL."""
    try:
        # Small delay to be polite
        await asyncio.sleep(random.uniform(0.5, 1.5))
        
        async with session.get(url, headers=get_headers(), timeout=10, allow_redirects=True) as response:
            if response.status != 200:
                return ""
            
            html_content = await response.text()
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Remove non-content elements
            for element in soup(["header", "footer", "nav", "aside", "form", "script", "style", "noscript", "iframe"]):
                element.decompose()
            
            content = soup.get_text(separator=' ')
            content = re.sub(r'\s+', ' ', content).strip()
            
            return content[:15000]  # Limit content size

    except Exception as e:
        print(f"[Fetch] Error fetching {url}: {e}")
        return ""


async def search_web_standalone(client, query: str) -> str:
    """
    Standalone web search using DuckDuckGo.
    Fetches pages, chunks content, and uses semantic search to find relevant info.
    
    Args:
        client: httpx AsyncClient (not used, kept for API compatibility)
        query: Search query string
    
    Returns:
        Formatted search results string
    """
    try:
        # Step 1: Get search results from DuckDuckGo
        search_results = await duckduckgo_search(query, num_results=6)
        
        if not search_results:
            return "No search results found. Please try a different query."
        
        # Step 2: Fetch content from result URLs
        urls = [r['url'] for r in search_results if r['url']]
        
        async with aiohttp.ClientSession() as session:
            tasks = [fetch_page_content(session, url) for url in urls[:5]]
            page_contents = await asyncio.gather(*tasks)
        
        # Step 3: Chunk and index content
        all_chunks = []
        metadata = []
        
        for i, content in enumerate(page_contents):
            if content and len(content) > 100:
                result = search_results[i]
                chunks = text_splitter.split_text(content)
                for chunk in chunks[:20]:  # Limit chunks per page
                    all_chunks.append(chunk)
                    metadata.append({
                        "title": result['title'], 
                        "url": result['url'], 
                        "text": chunk
                    })
        
        if not all_chunks:
            # Fall back to just returning snippets
            fallback_results = []
            for r in search_results[:5]:
                fallback_results.append(f"**{r['title']}**\n{r['url']}\n{r['snippet']}")
            return "\n\n---\n\n".join(fallback_results)
        
        # Step 4: Semantic search with embeddings
        embed_model = get_embed_model()
        embeddings = embed_model.encode(all_chunks, normalize_embeddings=True)
        embeddings = np.array(embeddings, dtype="float32")
        
        dimension = embeddings.shape[1]
        index = faiss.IndexFlatIP(dimension)
        index.add(embeddings)
        
        query_embedding = embed_model.encode([query], normalize_embeddings=True).astype("float32")
        
        _, indices = index.search(query_embedding, min(5, len(all_chunks)))
        
        # Step 5: Format results
        results = []
        seen_urls = set()
        
        for idx in indices[0]:
            if idx < len(metadata):
                chunk_info = metadata[idx]
                url = chunk_info['url']
                
                # Avoid duplicate URLs
                if url not in seen_urls:
                    seen_urls.add(url)
                    results.append(
                        f"**{chunk_info['title']}**\n"
                        f"URL: {url}\n"
                        f"Content: {chunk_info['text'][:600]}..."
                    )
        
        return "\n\n---\n\n".join(results) if results else "No relevant content found."

    except Exception as e:
        import traceback
        traceback.print_exc()
        return f"Search failed: {str(e)}"


# Compatibility wrapper for pydantic_ai agents
if PYDANTIC_AI_AVAILABLE:
    async def search_web(ctx: 'RunContext[Deps]', query: str) -> str:
        """
        Performs a semantic search over web results.
        This version is for pydantic_ai agents.
        """
        return await search_web_standalone(ctx.deps.client, query)
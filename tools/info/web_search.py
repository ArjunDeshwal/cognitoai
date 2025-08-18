import re
import random
import asyncio
import numpy as np
import faiss
from bs4 import BeautifulSoup
from sentence_transformers import SentenceTransformer
from langchain.text_splitter import RecursiveCharacterTextSplitter
from pydantic import BaseModel
from pydantic_ai import RunContext
from tools.deps import Deps

# Initialize embedding model once
embed_model = SentenceTransformer("BAAI/bge-small-en-v1.5")
text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=60)


class SearchResult(BaseModel):
    """Structured search result with metadata and chunk text."""
    title: str
    url: str
    text: str


async def _fetch_page_content(ctx: RunContext[Deps], url: str) -> str:
    """Fetch and clean HTML content for a given URL."""
    USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ]

    headers = {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }

    # Small randomized delay to reduce suspicion
    await asyncio.sleep(random.uniform(1, 3))

    r = await ctx.deps.client.get(url, headers=headers, timeout=10)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')

    # Remove unwanted tags
    for element in soup(["header", "footer", "nav", "aside", "form", "script", "style"]):
        element.decompose()

    content = soup.get_text()
    return re.sub(r'\s+', ' ', content).strip()


async def search_web(ctx: RunContext[Deps], query: str) -> str:
    """
    Perform a semantic search using SearxNG, fetch pages, embed chunks, and return top results.
    
    Args:
        query: A search query string.
    
    Returns:
        A formatted string with relevant search results.
    
    Raises:
        ValueError: If no results are found or no content can be extracted.
    """
    # Step 1: Query SearxNG
    r = await ctx.deps.client.get(
        "http://localhost:8888/search",
        params={"q": query, "format": "json"},
        timeout=5,
    )
    r.raise_for_status()
    data = r.json()
    results = data.get("results", [])

    urls = [item.get("url") for item in results if item.get("url")]
    if not urls:
        raise ValueError(f"No results found for query: '{query}'")

    # Step 2: Fetch contents concurrently
    tasks = [_fetch_page_content(ctx, url) for url in urls[:20]]
    contents = await asyncio.gather(*tasks, return_exceptions=True)

    all_chunks, metadata = [], []
    for i, content in enumerate(contents):
        if isinstance(content, Exception) or not content:
            continue
        url = urls[i]
        title = next((item['title'] for item in results if item.get('url') == url), "Untitled")
        chunks = text_splitter.split_text(content)
        for chunk in chunks:
            all_chunks.append(chunk)
            metadata.append(SearchResult(title=title, url=url, text=chunk))

    if not all_chunks:
        raise ValueError("No content could be extracted from the search results.")

    # Step 3: Embedding + FAISS search
    embeddings = embed_model.encode(all_chunks, normalize_embeddings=True)
    embeddings = np.array(embeddings, dtype="float32")

    dim = embeddings.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)

    query_emb = embed_model.encode([query], normalize_embeddings=True).astype("float32")
    D, I = index.search(query_emb, 10)

    # Step 4: Format results
    results_out = []
    for idx in I[0]:
        chunk = metadata[idx]
        results_out.append(
            f"Title: {chunk.title}\nURL: {chunk.url}\nContent: {chunk.text[:1000]}..."
        )

    return "\n\n---\n\n".join(results_out)
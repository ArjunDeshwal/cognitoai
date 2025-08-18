import requests
import re
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
from langchain.text_splitter import RecursiveCharacterTextSplitter
import asyncio
import aiohttp
from bs4 import BeautifulSoup
import random
from pydantic_ai import RunContext
from tools.deps import Deps

# Initialize embedding model once
embed_model = SentenceTransformer("BAAI/bge-small-en-v1.5")

# Text splitter for chunking web content
text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=60)

async def fetch_page_content(session: aiohttp.ClientSession, url: str) -> str:
    """Fetches and cleans HTML content with more robust headers."""
    USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    ]
    try:
        headers = {
            'User-Agent': random.choice(USER_AGENTS),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Platform': '"Windows"',
        }
        
        await asyncio.sleep(random.uniform(1, 5))

        async with session.get(url, headers=headers, timeout=10) as response:
            response.raise_for_status()
            html_content = await response.text()
            
            soup = BeautifulSoup(html_content, 'html.parser')
            for element in soup(["header", "footer", "nav", "aside", "form", "script", "style"]):
                element.decompose()
            
            content = soup.get_text()
            content = re.sub(r'\s+', ' ', content).strip()
            
            return content

    except aiohttp.ClientResponseError as e:
        # Catch and report specific HTTP status codes
        print(f"HTTP Error fetching content from {url}: {e.status}, message='{e.message}'")
        return ""
    except aiohttp.ClientError as e:
        print(f"Network Error fetching content from {url}: {e}")
        return ""
    except Exception as e:
        print(f"An unexpected error occurred for {url}: {e}")
        return ""

async def search_web(ctx:RunContext[Deps], query: str) -> str:
    """
    Performs a semantic search over web results with improved efficiency and robustness.
    """
    try:
        response =await ctx.deps.client.get(
            "http://localhost:8888/search",
            params={"q": query, "format": "json"},
            timeout=5
        )
        response.raise_for_status()
        data = response.json()
        
        results_urls = [item.get("url") for item in data.get("results", []) if item.get("url")]
        
        if not results_urls:
            return "No results found from the initial search."
        
        #Async fetch and clean content from all URLs
        async with aiohttp.ClientSession() as session:
            tasks = [fetch_page_content(session, url) for url in results_urls[:20]]
            page_contents = await asyncio.gather(*tasks)

        all_chunks = []
        metadata = []
        for i, content in enumerate(page_contents):
            if content:
                url = results_urls[i]
                title = [item['title'] for item in data['results'] if item.get('url') == url][0]
                chunks = text_splitter.split_text(content)
                for chunk in chunks:
                    all_chunks.append(chunk)
                    metadata.append({"title": title, "url": url, "text": chunk})

        if not all_chunks:
            return "No content could be extracted from the search results."

        #embeding chunks
        embeddings = embed_model.encode(all_chunks, normalize_embeddings=True)
        embeddings = np.array(embeddings, dtype="float32")
        
        #faiss indexing and searching
        dimension = embeddings.shape[1]
        index = faiss.IndexFlatIP(dimension)
        index.add(embeddings)
        
        query_embedding = embed_model.encode([query], normalize_embeddings=True).astype("float32")
        
        D, I = index.search(query_embedding, 10)
        results = []
        for idx in I[0]:
            chunk_info = metadata[idx]
            results.append(f"Title: {chunk_info['title']}\nURL: {chunk_info['url']}\nContent: {chunk_info['text'][:1000]}...")
        
        return "\n\n---\n\n".join(results)

    except requests.exceptions.RequestException as e:
        return f"SearxNG connection failed: {str(e)}. Please check if searxng is running."
    except Exception as e:
        return f"Search Failed: {str(e)}. An unexpected error occurred."
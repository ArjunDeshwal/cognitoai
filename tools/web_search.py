import requests
def search_web(query: str) -> str:
    """Search the web using SearxNG. Input should be a search query."""
    try:
        response = requests.get(
            "http://localhost:8888/search",
            params={"q": query, "format": "json"},
            timeout=5
        )
        data = response.json()
        
        results = []
        for item in data.get("results", [])[:5]:
            title = item.get("title", "No title")
            content = item.get("content", "")[:600]
            results.append(f"- {content}...")
        
        return "\n".join(results) if results else "No results found."
    except:
        return "Search failed. Is SearxNG running?"
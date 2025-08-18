from tools.deps import Deps
from pydantic_ai import RunContext

async def medi(ctx:RunContext[Deps], query:str)->str:
    """
    Search PubMed for information about a medicine and return summaries/abstracts.
    Args:
        medicine_name: The common or generic name of the medicine. 
                       Example: "paracetamol", "ibuprofen", "amoxicillin".
    Returns:
        A string containing abstracts or summaries of relevant PubMed articles.
    Raises:
        ValueError: If no PubMed entries are found for the given medicine name.
    """
    esearch_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    params = {"db": "pubmed", "term": query, "retmax": 5, "retmode": "json"}
    resp = await ctx.deps.client.get(esearch_url, params=params)
    data = resp.json()
    ids = data["esearchresult"]["idlist"]

    if not ids:
        return f"No results for {query}"

    # fetch abstracts
    efetch_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    fetch_params = {"db": "pubmed", "id": ",".join(ids), "rettype": "abstract", "retmode": "text"}
    resp2 = await ctx.deps.client.get(efetch_url, params=fetch_params)
    abstracts = resp2.text

    return abstracts

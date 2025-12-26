"""
Document RAG Module
Handles PDF text extraction and retrieval for chat context.
"""

import fitz  # PyMuPDF
import re
from typing import List, Dict, Tuple
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np


class DocumentStore:
    """In-memory document store for RAG functionality."""
    
    def __init__(self):
        self.documents: Dict[str, Dict] = {}
        self.vectorizer = None
        self.chunk_vectors = None
        self.all_chunks: List[Tuple[str, str, int]] = []  # (doc_id, chunk_text, chunk_idx)
    
    def add_document(self, doc_id: str, filename: str, text: str, chunks: List[str]) -> Dict:
        """Add a document to the store."""
        doc = {
            "id": doc_id,
            "filename": filename,
            "text": text,
            "chunks": chunks,
            "chunk_count": len(chunks)
        }
        self.documents[doc_id] = doc
        
        # Update chunk index
        self._rebuild_index()
        
        return {
            "id": doc_id,
            "filename": filename,
            "chunk_count": len(chunks)
        }
    
    def remove_document(self, doc_id: str) -> bool:
        """Remove a document from the store."""
        if doc_id in self.documents:
            del self.documents[doc_id]
            self._rebuild_index()
            return True
        return False
    
    def get_documents(self) -> List[Dict]:
        """Get list of all documents."""
        return [
            {
                "id": doc["id"],
                "filename": doc["filename"],
                "chunk_count": doc["chunk_count"]
            }
            for doc in self.documents.values()
        ]
    
    def _rebuild_index(self):
        """Rebuild the TF-IDF index for all chunks."""
        self.all_chunks = []
        for doc_id, doc in self.documents.items():
            for idx, chunk in enumerate(doc["chunks"]):
                self.all_chunks.append((doc_id, chunk, idx))
        
        if self.all_chunks:
            chunk_texts = [c[1] for c in self.all_chunks]
            self.vectorizer = TfidfVectorizer(stop_words='english', max_features=5000)
            self.chunk_vectors = self.vectorizer.fit_transform(chunk_texts)
        else:
            self.vectorizer = None
            self.chunk_vectors = None
    
    def find_relevant_chunks(self, query: str, top_k: int = 5) -> List[Dict]:
        """Find the most relevant chunks for a query."""
        if not self.all_chunks or self.vectorizer is None:
            return []
        
        # Vectorize the query
        query_vector = self.vectorizer.transform([query])
        
        # Calculate similarity
        similarities = cosine_similarity(query_vector, self.chunk_vectors).flatten()
        
        # Get top-k indices
        top_indices = np.argsort(similarities)[::-1][:top_k]
        
        results = []
        for idx in top_indices:
            if similarities[idx] > 0.05:  # Minimum similarity threshold
                doc_id, chunk_text, chunk_idx = self.all_chunks[idx]
                doc = self.documents[doc_id]
                results.append({
                    "doc_id": doc_id,
                    "filename": doc["filename"],
                    "chunk_index": chunk_idx,
                    "text": chunk_text,
                    "similarity": float(similarities[idx])
                })
        
        return results
    
    def get_context_for_query(self, query: str, top_k: int = 5) -> str:
        """Get formatted context string for a query."""
        relevant_chunks = self.find_relevant_chunks(query, top_k)
        
        if not relevant_chunks:
            return ""
        
        context_parts = []
        for i, chunk in enumerate(relevant_chunks):
            context_parts.append(
                f"[From: {chunk['filename']}]\n{chunk['text']}"
            )
        
        return "\n\n---\n\n".join(context_parts)


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from a PDF file using PyMuPDF."""
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        text_parts = []
        
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text()
            if text.strip():
                text_parts.append(f"[Page {page_num + 1}]\n{text}")
        
        doc.close()
        return "\n\n".join(text_parts)
    except Exception as e:
        raise ValueError(f"Failed to extract text from PDF: {str(e)}")


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> List[str]:
    """
    Split text into overlapping chunks.
    
    Args:
        text: The text to chunk
        chunk_size: Target number of words per chunk
        overlap: Number of words to overlap between chunks
    
    Returns:
        List of text chunks
    """
    # Clean and normalize the text
    text = re.sub(r'\s+', ' ', text).strip()
    
    # Split into words
    words = text.split()
    
    if len(words) <= chunk_size:
        return [text] if text else []
    
    chunks = []
    start = 0
    
    while start < len(words):
        end = start + chunk_size
        chunk_words = words[start:end]
        chunk = ' '.join(chunk_words)
        chunks.append(chunk)
        
        # Move start with overlap
        start = end - overlap
        if start >= len(words):
            break
    
    return chunks


# Global document store instance
document_store = DocumentStore()

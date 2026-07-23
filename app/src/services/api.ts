export type ApiConfig = { baseUrl: string; token: string };

let apiConfig: ApiConfig | null = null;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function configureApi(config: ApiConfig) {
    apiConfig = config;
}

function apiFetch(path: string, init: RequestInit = {}) {
    if (!apiConfig) {
        throw new Error("Cognito's local service is not configured");
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiConfig.token}`);
    return fetch(`${apiConfig.baseUrl}${path}`, { ...init, headers });
}

export type HealthStatus = {
    status: 'ok' | 'error';
    model_loaded: boolean;
    tools_available: boolean;
    model_name?: string;
};

export type StreamStatus = 'searching' | 'deep_searching' | 'search_complete' | 'search_failed' | 'generating' | 'done' | 'error' | 'retrieving_docs';

export type StreamEvent = {
    status?: StreamStatus;
    query?: string;
    content?: string;
    error?: string;
};

export async function checkBackendHealth(): Promise<HealthStatus | null> {
    try {
        const res = await apiFetch('/health');
        if (res.ok) {
            return await res.json();
        }
        return null;
    } catch {
        return null;
    }
}

export async function loadModel(modelPath: string, contextWindow: number = 8192) {
    const res = await apiFetch('/v1/load_model', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: modelPath, n_ctx: contextWindow }),
    });
    if (!res.ok) {
        throw new Error(await res.text());
    }
    return res.json();
}

/**
 * Streaming chat completion using Server-Sent Events
 */
export async function chatCompletionStream(
    messages: { role: string; content: string }[],
    onStatus: (status: StreamStatus, query?: string) => void,
    onChunk: (content: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    webSearch: boolean = false,
    deepSearch: boolean = false,
    useDocuments: boolean = false,
    signal?: AbortSignal
): Promise<void> {
    try {
        const res = await apiFetch('/v1/chat/completions', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages, stream: true, web_search: webSearch, deep_search: deepSearch, use_documents: useDocuments }),
            signal
        });

        if (!res.ok) {
            const errorText = await res.text();
            onError(errorText);
            return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
            onError("No response body");
            return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                onDone();
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();

                    if (data === '[DONE]') {
                        onDone();
                        return;
                    }

                    try {
                        const parsed: StreamEvent = JSON.parse(data);

                        if (parsed.status) {
                            onStatus(parsed.status, parsed.query);
                        }
                        if (parsed.content) {
                            onChunk(parsed.content);
                        }
                        if (parsed.error) {
                            onError(parsed.error);
                            return;
                        }
                    } catch {
                        // Ignore parse errors
                    }
                }
            }
        }
    } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            onDone(); // Silence error on abort
            return;
        }
        onError(errorMessage(error));
    }
}

// =============================================================================
// MODEL MANAGEMENT APIs
// =============================================================================

export type HFModel = {
    id: string;
    author: string;
    downloads: number;
    likes: number;
    lastModified: string;
    tags: string[];
};

export type ModelFile = {
    name: string;
    size: number;
    sizeFormatted: string;
};

export type LocalModel = {
    name: string;
    path: string;
    size: number;
    sizeFormatted: string;
};

export type DownloadStatus = 'starting' | 'downloading' | 'progress' | 'complete' | 'error';

export type DownloadEvent = {
    status: DownloadStatus;
    filename?: string;
    total?: number;
    totalFormatted?: string;
    downloaded?: number;
    percent?: number;
    path?: string;
    error?: string;
};

export async function searchModels(query: string): Promise<HFModel[]> {
    try {
        const res = await apiFetch(`/v1/models/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.models || [];
    } catch (e) {
        console.error("Search failed:", e);
        return [];
    }
}

export async function getModelFiles(repoId: string): Promise<ModelFile[]> {
    try {
        const res = await apiFetch(`/v1/models/files/${encodeURIComponent(repoId)}`);
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.files || [];
    } catch (e) {
        console.error("Get files failed:", e);
        return [];
    }
}

export async function downloadModel(
    repoId: string,
    filename: string,
    onProgress: (event: DownloadEvent) => void
): Promise<void> {
    try {
        const res = await apiFetch('/v1/models/download', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo_id: repoId, filename }),
        });

        if (!res.ok) {
            onProgress({ status: 'error', error: await res.text() });
            return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event: DownloadEvent = JSON.parse(line.slice(6));
                        onProgress(event);
                    } catch { /* ignore malformed progress events */ }
                }
            }
        }
    } catch (error: unknown) {
        onProgress({ status: 'error', error: errorMessage(error) });
    }
}

export async function listLocalModels(): Promise<{ models: LocalModel[]; directory: string }> {
    try {
        const res = await apiFetch('/v1/models/local');
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    } catch (error: unknown) {
        console.error("List models failed:", error);
        return { models: [], directory: "" };
    }
}

export async function deleteLocalModel(filename: string): Promise<boolean> {
    try {
        const res = await apiFetch(`/v1/models/local/${encodeURIComponent(filename)}`, {
            method: "DELETE"
        });
        return res.ok;
    } catch {
        return false;
    }
}

// =============================================================================
// DOCUMENT RAG APIs
// =============================================================================

export type UploadedDocument = {
    id: string;
    filename: string;
    chunk_count: number;
};

export type DocumentUploadResponse = {
    status: string;
    document: UploadedDocument;
    message: string;
};

export async function uploadDocument(file: File): Promise<DocumentUploadResponse | null> {
    try {
        const formData = new FormData();
        formData.append('file', file);

        const res = await apiFetch('/v1/documents/upload', {
            method: "POST",
            body: formData
        });

        if (!res.ok) {
            const error = await res.text();
            throw new Error(error);
        }

        return await res.json();
    } catch (error: unknown) {
        console.error("Document upload failed:", error);
        throw error;
    }
}

export async function listDocuments(): Promise<UploadedDocument[]> {
    try {
        const res = await apiFetch('/v1/documents');
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return data.documents || [];
    } catch (error: unknown) {
        console.error("List documents failed:", error);
        return [];
    }
}

export async function deleteDocument(docId: string): Promise<boolean> {
    try {
        const res = await apiFetch(`/v1/documents/${encodeURIComponent(docId)}`, {
            method: "DELETE"
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function clearAllDocuments(): Promise<boolean> {
    try {
        const res = await apiFetch('/v1/documents', {
            method: "DELETE"
        });
        return res.ok;
    } catch {
        return false;
    }
}

import { useState, useEffect } from 'react';
import { searchModels, getModelFiles, downloadModel, listLocalModels, loadModel } from '../services/api';
import type { HFModel, ModelFile, LocalModel, DownloadEvent } from '../services/api';
import './ModelBrowser.css';

type Props = {
    onClose: () => void;
    onModelLoaded: () => void;
    contextWindow: number;
};

export default function ModelBrowser({ onClose, onModelLoaded, contextWindow }: Props) {
    const [activeTab, setActiveTab] = useState<'search' | 'local'>('local');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<HFModel[]>([]);
    const [searching, setSearching] = useState(false);

    const [selectedModel, setSelectedModel] = useState<HFModel | null>(null);
    const [modelFiles, setModelFiles] = useState<ModelFile[]>([]);
    const [loadingFiles, setLoadingFiles] = useState(false);

    const [downloadProgress, setDownloadProgress] = useState<DownloadEvent | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [localModels, setLocalModels] = useState<LocalModel[]>([]);
    const [localDirectory, setLocalDirectory] = useState('');

    useEffect(() => {
        let active = true;
        void listLocalModels().then((result) => {
            if (!active) return;
            setLocalModels(result.models);
            setLocalDirectory(result.directory);
        });
        return () => {
            active = false;
        };
    }, []);

    const loadLocalModels = async () => {
        const result = await listLocalModels();
        setLocalModels(result.models);
        setLocalDirectory(result.directory);
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setSearching(true);
        setSelectedModel(null);
        const results = await searchModels(searchQuery);
        setSearchResults(results);
        setSearching(false);
    };

    const handleSelectModel = async (model: HFModel) => {
        setSelectedModel(model);
        setLoadingFiles(true);
        const files = await getModelFiles(model.id);
        setModelFiles(files);
        setLoadingFiles(false);
    };

    const handleDownload = async (file: ModelFile) => {
        if (!selectedModel) return;
        setError(null);
        setDownloading(true);
        setDownloadProgress({ status: 'starting' });

        await downloadModel(selectedModel.id, file.name, (event) => {
            setDownloadProgress(event);
            if (event.status === 'complete') {
                setDownloading(false);
                loadLocalModels();
            } else if (event.status === 'error') {
                setDownloading(false);
                setError(`Download failed: ${event.error ?? 'Unknown error'}`);
            }
        });
    };

    const handleLoadModel = async (model: LocalModel) => {
        try {
            setError(null);
            await loadModel(model.path, contextWindow);
            onModelLoaded();
            onClose();
        } catch (error: unknown) {
            setError('Failed to load model: ' + (error instanceof Error ? error.message : String(error)));
        }
    };

    return (
        <div className="model-browser-overlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
        }}>
            <div className="model-browser" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
                <header className="browser-header">
                    <div>
                        <span className="browser-eyebrow">LOCAL MODEL LIBRARY</span>
                        <h2 id="model-manager-title">Model Manager</h2>
                    </div>
                    <button className="close-btn" onClick={onClose} aria-label="Close model manager">×</button>
                </header>

                {error && (
                    <div className="browser-error" role="alert">
                        <span>{error}</span>
                        <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
                    </div>
                )}

                <div className="browser-tabs">
                    <button
                        className={activeTab === 'local' ? 'active' : ''}
                        onClick={() => setActiveTab('local')}
                    >
                        My Models
                    </button>
                    <button
                        className={activeTab === 'search' ? 'active' : ''}
                        onClick={() => setActiveTab('search')}
                    >
                        Download New
                    </button>
                </div>

                <div className="browser-content">
                    {activeTab === 'local' && (
                        <div className="local-models">
                            <p className="directory-hint">Models in: {localDirectory}</p>
                            {localModels.length === 0 ? (
                                <div className="empty-state">
                                    <p>No models downloaded yet</p>
                                    <button onClick={() => setActiveTab('search')}>Download a Model</button>
                                </div>
                            ) : (
                                <div className="model-list">
                                    {localModels.map(model => (
                                        <div key={model.name} className="model-item local">
                                            <div className="model-info">
                                                <span className="model-name">{model.name}</span>
                                                <span className="model-size">{model.sizeFormatted}</span>
                                            </div>
                                            <button
                                                className="load-btn"
                                                onClick={() => handleLoadModel(model)}
                                            >
                                                Load
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'search' && (
                        <div className="search-models">
                            <div className="search-bar">
                                <input
                                    type="text"
                                    placeholder="Search Hugging Face for models (e.g., Qwen, Mistral, Llama)..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                />
                                <button onClick={handleSearch} disabled={searching}>
                                    {searching ? 'Searching...' : 'Search'}
                                </button>
                            </div>

                            {downloading && downloadProgress && (
                                <div className="download-progress">
                                    <div className="progress-info">
                                        <span>Downloading: {downloadProgress.filename}</span>
                                        <span>{downloadProgress.percent || 0}%</span>
                                    </div>
                                    <div className="progress-bar">
                                        <div
                                            className="progress-fill"
                                            style={{ width: `${downloadProgress.percent || 0}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {selectedModel ? (
                                <div className="file-browser">
                                    <button className="back-btn" onClick={() => setSelectedModel(null)}>
                                        ← Back to Search
                                    </button>
                                    <h3>{selectedModel.id}</h3>
                                    {loadingFiles ? (
                                        <p>Loading files...</p>
                                    ) : modelFiles.length === 0 ? (
                                        <p>No GGUF files found in this repository</p>
                                    ) : (
                                        <div className="file-list">
                                            {modelFiles.map(file => (
                                                <div key={file.name} className="file-item">
                                                    <div className="file-info">
                                                        <span className="file-name">{file.name}</span>
                                                        <span className="file-size">{file.sizeFormatted}</span>
                                                    </div>
                                                    <button
                                                        onClick={() => handleDownload(file)}
                                                        disabled={downloading}
                                                    >
                                                        {downloading ? 'Downloading...' : 'Download'}
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="search-results">
                                    {searchResults.map(model => (
                                        <div
                                            key={model.id}
                                            className="model-item"
                                            onClick={() => handleSelectModel(model)}
                                        >
                                            <div className="model-info">
                                                <span className="model-name">{model.id}</span>
                                                <div className="model-meta">
                                                    <span>⬇️ {model.downloads.toLocaleString()}</span>
                                                    <span>❤️ {model.likes}</span>
                                                </div>
                                            </div>
                                            <span className="view-files">View Files →</span>
                                        </div>
                                    ))}
                                    {searchResults.length === 0 && searchQuery && !searching && (
                                        <p className="no-results">No models found. Try a different search term.</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

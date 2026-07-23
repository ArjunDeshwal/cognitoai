import { useState, useEffect, useRef } from 'react';
import './App.css';
import { checkBackendHealth, loadModel, chatCompletionStream, uploadDocument, deleteDocument, clearAllDocuments, listDocuments } from './services/api';
import type { StreamStatus, UploadedDocument } from './services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ModelBrowser from './components/ModelBrowser';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

type Session = {
  id: string;
  name: string;
  messages: Message[];
  timestamp: number;
};

type SearchMode = 'offline' | 'web' | 'deep';

const generateId = () => crypto.randomUUID();

function loadSessions(): Session[] {
  try {
    const saved = localStorage.getItem('cognito_sessions');
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed as Session[] : [];
  } catch {
    localStorage.removeItem('cognito_sessions');
    return [];
  }
}

// Component to render message with think tags and markdown
function MessageContent({ content }: { content: string }) {
  const [thinkExpanded, setThinkExpanded] = useState(false);

  // Parse think tags
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  const thinkContent = thinkMatch ? thinkMatch[1].trim() : null;
  const mainContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return (
    <div className="message-content">
      {thinkContent && (
        <div className="think-block">
          <button
            className="think-toggle"
            onClick={() => setThinkExpanded(!thinkExpanded)}
          >
            {thinkExpanded ? '▼' : '▶'} Thinking...
          </button>
          {thinkExpanded && (
            <div className="think-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {thinkContent}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
      {mainContent && (
        <div className="main-content-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {mainContent}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<'offline' | 'online' | 'loading'>('loading');
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [loadedModelName, setLoadedModelName] = useState<string | null>(null);

  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>('offline');
  const [showModelBrowser, setShowModelBrowser] = useState(false);
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  // New: stream status for search/generating indication
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);

  // Document upload state
  const [uploadedDocuments, setUploadedDocuments] = useState<UploadedDocument[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // System prompt state
  const [systemPrompt, setSystemPrompt] = useState<string>(() => {
    return localStorage.getItem('cognito_system_prompt') || '';
  });
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);

  // Context window (memory) state
  const [contextWindow, setContextWindow] = useState<number>(() => {
    const saved = localStorage.getItem('cognito_context_window');
    return saved ? parseInt(saved, 10) : 8192;
  });
  const [showContextSettings, setShowContextSettings] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const startupAttemptsRef = useRef(0);

  useEffect(() => {
    let active = true;
    const refreshHealth = async () => {
      const health = await checkBackendHealth();
      if (!active) return;
      if (health && health.status === 'ok') {
        startupAttemptsRef.current = 0;
        setStatus('online');
        setIsModelLoaded(health.model_loaded);
        setLoadedModelName(health.model_loaded ? health.model_name ?? null : null);
      } else {
        startupAttemptsRef.current += 1;
        setStatus(startupAttemptsRef.current < 8 ? 'loading' : 'offline');
        setIsModelLoaded(false);
        setLoadedModelName(null);
      }
    };
    void refreshHealth();
    const interval = setInterval(refreshHealth, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (status === 'online') {
      void listDocuments().then(setUploadedDocuments);
    }
  }, [status]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem('cognito_sessions', JSON.stringify(sessions));
      } catch {
        setNotice({ type: 'error', message: 'Chat history is full. Export or remove older chats.' });
      }
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [sessions]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(scrollToBottom, [messages, streamStatus]);

  useEffect(() => {
    if (!currentSessionId) return;
    setSessions(prev => prev.map(s => {
      if (s.id === currentSessionId) {
        let name = s.name;
        if (s.name === 'New Chat' && messages.length > 0) {
          name = messages[0].content.slice(0, 30) + (messages[0].content.length > 30 ? '...' : '');
        }
        return { ...s, messages, name };
      }
      return s;
    }));
  }, [messages, currentSessionId]);

  const handleNewChat = () => {
    const newId = generateId();
    const newSession: Session = {
      id: newId,
      name: 'New Chat',
      messages: [],
      timestamp: Date.now()
    };
    setSessions(previous => [newSession, ...previous]);
    setCurrentSessionId(newId);
    setMessages([]);
    return newId;
  };

  const handleSelectSession = (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session) {
      setCurrentSessionId(id);
      setMessages(session.messages);
    }
  };

  const handleDeleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat?')) return;

    const newSessions = sessions.filter(s => s.id !== id);
    setSessions(newSessions);

    if (currentSessionId === id) {
      if (newSessions.length > 0) {
        handleSelectSession(newSessions[0].id);
      } else {
        setCurrentSessionId(null);
        setMessages([]);
      }
    }
  };

  const handleChangeModel = async () => {
    if (!window.electronAPI) {
      setNotice({ type: 'error', message: 'File selection is only available in the desktop app.' });
      return;
    }
    try {
      const path = await window.electronAPI.selectFile();
      if (path) {
        setLoading(true);
        await loadModel(path, contextWindow);
        setIsModelLoaded(true);
        if (!currentSessionId) {
          handleNewChat();
        }
      }
    } catch (e) {
      setNotice({ type: 'error', message: `Failed to change model: ${String(e)}` });
    } finally {
      setLoading(false);
    }
  };

  // Document upload handlers
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    setIsUploading(true);
    try {
      const result = await uploadDocument(file);
      if (result?.document) {
        setUploadedDocuments(prev => [...prev, result.document]);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setNotice({ type: 'error', message: `Failed to upload document: ${message}` });
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveDocument = async (docId: string) => {
    const success = await deleteDocument(docId);
    if (success) {
      setUploadedDocuments(prev => prev.filter(d => d.id !== docId));
    }
  };

  const handleClearAllDocuments = async () => {
    const success = await clearAllDocuments();
    if (success) {
      setUploadedDocuments([]);
    }
  };

  // System prompt handler
  const handleSaveSystemPrompt = (prompt: string) => {
    setSystemPrompt(prompt);
    localStorage.setItem('cognito_system_prompt', prompt);
    setShowSystemPrompt(false);
  };

  // Context window handler
  const handleSaveContextWindow = (size: number) => {
    setContextWindow(size);
    localStorage.setItem('cognito_context_window', size.toString());
    setShowContextSettings(false);
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setLoading(false);
      setStreamStatus(null);
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    if (!isModelLoaded) {
      setNotice({ type: 'error', message: 'Load a model before sending a message.' });
      return;
    }

    if (!currentSessionId) handleNewChat();

    const newUserMsg: Message = { role: 'user', content: input };

    // Build messages with optional system prompt
    let messagesToSend: { role: string; content: string }[] = [];
    if (systemPrompt.trim()) {
      messagesToSend.push({ role: 'system', content: systemPrompt });
    }
    messagesToSend = [...messagesToSend, ...messages, newUserMsg];

    const newMessages = [...messages, newUserMsg];

    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setStreamStatus(null);

    // Add placeholder for assistant response
    const assistantPlaceholder: Message = { role: 'assistant', content: '' };
    setMessages([...newMessages, assistantPlaceholder]);

    // Determine if we should use document context
    const useDocuments = uploadedDocuments.length > 0;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await chatCompletionStream(
        messagesToSend,
        // onStatus
        (status) => {
          setStreamStatus(status);
        },
        // onChunk
        (chunk) => {
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: updated[lastIdx].content + chunk
              };
            }
            return updated;
          });
        },
        // onDone
        () => {
          setLoading(false);
          setStreamStatus(null);
          abortControllerRef.current = null;
        },
        // onError
        (error) => {
          if (error.includes("No model loaded")) {
            setIsModelLoaded(false);
            setNotice({ type: 'error', message: 'The model is no longer loaded. Select a model to continue.' });
          } else {
            setNotice({ type: 'error', message: `Generation failed: ${error}` });
          }
          setLoading(false);
          setStreamStatus(null);
          abortControllerRef.current = null;
        },
        searchMode !== 'offline',
        searchMode === 'deep',
        useDocuments,  // Pass document RAG flag
        controller.signal
      );
    } catch (e: unknown) {
      setNotice({ type: 'error', message: `Generation failed: ${String(e)}` });
      setLoading(false);
      setStreamStatus(null);
    }
  };

  // Render status indicator
  const renderStatusIndicator = () => {
    if (!loading) return null;

    const lastMessage = messages[messages.length - 1];
    const hasContent = lastMessage?.role === 'assistant' && lastMessage.content.length > 0;

    // Don't show if we're already streaming content
    if (hasContent) return null;

    // Determine status message
    let statusContent;
    if (streamStatus === 'searching' || streamStatus === 'deep_searching') {
      statusContent = (
        <div className="search-status">
          <div className="search-spinner"></div>
          <span>Searching the web...</span>
        </div>
      );
    } else if (streamStatus === 'retrieving_docs') {
      statusContent = (
        <div className="search-status">
          <div className="search-spinner" style={{ borderTopColor: '#4ade80' }}></div>
          <span>Retrieving from documents...</span>
        </div>
      );
    } else {
      statusContent = (
        <div className="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      );
    }

    return (
      <div className="message assistant">
        <div className="avatar">AI</div>
        <div className="bubble status-bubble">
          {statusContent}
        </div>
      </div>
    );
  };

  // Keep startup failures distinct from ordinary model state.
  if (status !== 'online') {
    return (
      <div className="app-container">
        <div className="startup-screen">
          <div className="startup-logo">
            <h1>COGNITO</h1>
            <div className="startup-subtitle">Local intelligence, under your control.</div>
          </div>
          {status === 'loading' ? (
            <>
              <div className="startup-loader" aria-label="Starting local engine">
                <div className="loader-ring"></div>
                <div className="loader-ring"></div>
                <div className="loader-ring"></div>
              </div>
              <div className="startup-status">Starting the private local engine…</div>
            </>
          ) : (
            <div className="startup-failure" role="alert">
              <strong>Local engine unavailable</strong>
              <span>Cognito is retrying automatically. Check the application log if this continues.</span>
              <button onClick={() => window.location.reload()}>Restart Cognito</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header">
        <div className="brand-lockup">
          <div className="brand-mark">C</div>
          <div>
            <h1 className="logo">COGNITO</h1>
            <span className="brand-caption">LOCAL WORKSPACE</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {status === 'online' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className={`status-badge ${loadedModelName ? 'online' : ''}`}>
                <span className="status-dot" />
                {loadedModelName ? loadedModelName : 'Engine ready'}
              </div>
              <button
                onClick={handleChangeModel}
                disabled={loading}
                className="icon-btn"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#cbd5e1',
                  fontSize: '0.8rem',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties}
                title={loadedModelName ? "Change Model" : "Select Model"}
              >
                {loadedModelName ? 'Change' : 'Select'}
              </button>
              <button
                onClick={() => setShowModelBrowser(true)}
                className="icon-btn"
                style={{
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.15))',
                  border: '1px solid rgba(139,92,246,0.3)',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#a78bfa',
                  fontSize: '0.8rem',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties}
                title="Download new models"
              >
                ⬇️ Models
              </button>
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                  className="icon-btn"
                  style={{
                    background: showOptionsMenu ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    color: '#cbd5e1',
                    fontSize: '0.9rem',
                    WebkitAppRegion: 'no-drag'
                  } as React.CSSProperties}
                  title="Options"
                >
                  ⚙️
                </button>
                {showOptionsMenu && (
                  <div className="options-dropdown">
                    <button
                      className="options-item"
                      onClick={() => {
                        setShowSystemPrompt(true);
                        setShowOptionsMenu(false);
                      }}
                    >
                      <span>📝</span> System Prompt
                      {systemPrompt.trim() && <span className="options-badge">Set</span>}
                    </button>
                    <button
                      className="options-item"
                      onClick={() => {
                        setShowContextSettings(true);
                        setShowOptionsMenu(false);
                      }}
                    >
                      <span>🧠</span> Context Window
                      <span className="options-badge">{contextWindow >= 1024 ? `${contextWindow / 1024}k` : contextWindow}</span>
                    </button>
                    <button
                      className="options-item danger"
                      onClick={() => {
                        if (window.confirm('This will delete ALL chats and settings. Are you sure?')) {
                          localStorage.clear();
                          window.location.reload();
                        }
                      }}
                    >
                      <span>🗑️</span> Reset App
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice-banner ${notice.type}`} role="status">
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button>
        </div>
      )}

      <div className="layout-body">
        <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          >
            {sidebarCollapsed ? '→' : '←'}
          </button>
          {!sidebarCollapsed && (
            <>
              <button className="new-chat-btn" onClick={handleNewChat}>
                <span>+</span> New Chat
              </button>
              <div className="history-list">
                {sessions.map(session => (
                  <div
                    key={session.id}
                    className={`history-item ${session.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => handleSelectSession(session.id)}
                  >
                    <span className="session-name">{session.name}</span>
                    <button
                      className="delete-session-btn"
                      onClick={(e) => handleDeleteSession(e, session.id)}
                      title="Delete chat"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <main className="main-content">
          {!isModelLoaded ? (
            <div className="setup-card setup-modern">
              <div className="setup-eyebrow">PRIVATE BY DEFAULT</div>
              <h2>Bring your own intelligence.</h2>
              <p className="setup-lead">Run a GGUF model entirely on this device. Start from your library or choose a model from Hugging Face.</p>
              <div className="setup-actions">
                <button className="setup-primary" onClick={() => setShowModelBrowser(true)} disabled={loading}>
                  Open model library
                </button>
                <button className="setup-secondary" onClick={handleChangeModel} disabled={loading}>
                  Choose a GGUF file
                </button>
              </div>
              <div className="privacy-strip">
                <span><strong>Local inference</strong>No prompt telemetry</span>
                <span><strong>Network gated</strong>Search starts off</span>
                <span><strong>Your files</strong>Processed on device</span>
              </div>
            </div>
          ) : (
            <div className="chat-interface">
              <div className="chat-history">
                {messages.length === 0 && (
                  <div className="empty-chat">
                    <div className="empty-chat-mark">C</div>
                    <h3>What are we working on?</h3>
                    <p>{searchMode === 'offline' ? 'Everything stays local unless you enable web research.' : 'Web research is enabled for this conversation.'}</p>
                    <div className="starter-prompts">
                      {['Summarize an attached document', 'Help me reason through a decision', 'Draft and refine an idea'].map(prompt => (
                        <button key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((m, i) => {
                  // Skip empty assistant message when loading (status indicator shows instead)
                  if (m.role === 'assistant' && m.content === '' && loading) {
                    return null;
                  }
                  return (
                    <div key={i} className={`message ${m.role}`}>
                      <div className="avatar">{m.role === 'user' ? 'You' : 'AI'}</div>
                      <div className="bubble">
                        {m.role === 'assistant' ? (
                          <MessageContent content={m.content} />
                        ) : (
                          m.content
                        )}
                        <button
                          className="copy-btn"
                          onClick={() => {
                            navigator.clipboard.writeText(m.content);
                          }}
                          title="Copy message"
                        >
                          📋
                        </button>
                      </div>
                    </div>
                  );
                })}
                {renderStatusIndicator()}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-area">
                {/* Document badges */}
                {uploadedDocuments.length > 0 && (
                  <div className="document-badges">
                    {uploadedDocuments.map(doc => (
                      <div key={doc.id} className="document-badge">
                        <span className="doc-icon">📄</span>
                        <span className="doc-name">{doc.filename}</span>
                        <button
                          className="doc-remove"
                          onClick={() => handleRemoveDocument(doc.id)}
                          title="Remove document"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {uploadedDocuments.length > 1 && (
                      <button
                        className="clear-all-docs"
                        onClick={handleClearAllDocuments}
                        title="Clear all documents"
                      >
                        Clear All
                      </button>
                    )}
                  </div>
                )}

                <div className="input-container">
                  {/* Document upload button */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    accept=".pdf,.txt"
                    style={{ display: 'none' }}
                  />
                  <button
                    className={`upload-btn ${isUploading ? 'uploading' : ''} ${uploadedDocuments.length > 0 ? 'has-docs' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    title={uploadedDocuments.length > 0 ? `${uploadedDocuments.length} document(s) attached` : 'Upload document (PDF, TXT)'}
                  >
                    {isUploading ? '⏳' : '+'}
                  </button>

                  <button
                    className={`deep-search-btn search-${searchMode}`}
                    onClick={() => setSearchMode(current => current === 'offline' ? 'web' : current === 'web' ? 'deep' : 'offline')}
                    title={`Research mode: ${searchMode}. Click to change.`}
                  >
                    <span className="search-mode-icon">⌕</span>
                    <span className="search-mode-label">{searchMode === 'offline' ? 'Local' : searchMode === 'web' ? 'Web' : 'Deep'}</span>
                  </button>
                  <input
                    type="text"
                    placeholder={uploadedDocuments.length > 0 ? "Ask about your documents…" : (searchMode === 'deep' ? "Research a topic deeply…" : "Message your local model…")}
                    value={input}
                    onKeyDown={(e) => e.key === 'Enter' && !loading && handleSend()}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  {loading ? (
                    <button
                      className="send-btn stopping"
                      onClick={handleStop}
                      title="Stop generating"
                    >
                      <span className="stop-icon">■</span>
                    </button>
                  ) : (
                    <button
                      className="send-btn"
                      onClick={handleSend}
                      disabled={!input.trim()}
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Model Browser Modal */}
      {showModelBrowser && (
        <ModelBrowser
          onClose={() => setShowModelBrowser(false)}
          onModelLoaded={() => {
            setIsModelLoaded(true);
            if (!currentSessionId) handleNewChat();
          }}
          contextWindow={contextWindow}
        />
      )}

      {/* System Prompt Modal */}
      {showSystemPrompt && (
        <div className="modal-overlay" onClick={() => setShowSystemPrompt(false)}>
          <div className="system-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="system-prompt-header">
              <span>System Prompt</span>
              <button
                className="close-panel-btn"
                onClick={() => setShowSystemPrompt(false)}
              >
                ×
              </button>
            </div>
            <textarea
              className="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Enter a system prompt to customize the AI's behavior... (e.g., 'You are a helpful coding expert.')"
              rows={6}
            />
            <div className="system-prompt-actions">
              <button
                className="clear-prompt-btn"
                onClick={() => handleSaveSystemPrompt('')}
              >
                Clear
              </button>
              <button
                className="save-prompt-btn"
                onClick={() => handleSaveSystemPrompt(systemPrompt)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context Window Settings Modal */}
      {showContextSettings && (
        <div className="modal-overlay" onClick={() => setShowContextSettings(false)}>
          <div className="system-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="system-prompt-header">
              <span>🧠 Context Window (Memory)</span>
              <button
                className="close-panel-btn"
                onClick={() => setShowContextSettings(false)}
              >
                ×
              </button>
            </div>
            <div className="context-window-content">
              <p className="context-description">
                Set the context window size (how much conversation history the AI can remember).
                Larger values use more memory but retain more context.
              </p>
              <div className="context-options">
                {[
                  { value: 2048, label: '2K' },
                  { value: 4096, label: '4K' },
                  { value: 8192, label: '8K' },
                  { value: 16384, label: '16K' },
                  { value: 32768, label: '32K' },
                ].map(option => (
                  <button
                    key={option.value}
                    className={`context-option ${contextWindow === option.value ? 'active' : ''}`}
                    onClick={() => setContextWindow(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="context-note">
                ⚠️ Changes take effect when you reload or change the model.
              </p>
            </div>
            <div className="system-prompt-actions">
              <button
                className="save-prompt-btn"
                onClick={() => handleSaveContextWindow(contextWindow)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

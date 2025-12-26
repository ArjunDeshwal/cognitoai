import { useState, useEffect, useRef } from 'react';
import './App.css';
import { checkBackendHealth, loadModel, chatCompletionStream, uploadDocument, deleteDocument, clearAllDocuments } from './services/api';
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

const generateId = () => Math.random().toString(36).substr(2, 9);

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>;
    };
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
  const [status, setStatus] = useState<'offline' | 'online' | 'loading'>('offline');
  const [modelPath, setModelPath] = useState('');
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [loadedModelName, setLoadedModelName] = useState<string | null>(null);

  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem('cognito_sessions');
    return saved ? JSON.parse(saved) : [];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [deepSearchEnabled, setDeepSearchEnabled] = useState(false);
  const [showModelBrowser, setShowModelBrowser] = useState(false);

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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      const health = await checkBackendHealth();
      if (health && health.status === 'ok') {
        setStatus('online');
        if (health.model_name) {
          setLoadedModelName(health.model_name);
        }
        if (!health.model_loaded && isModelLoaded) {
          setIsModelLoaded(false);
          setLoadedModelName(null);
        }
        if (health.model_loaded && !isModelLoaded) {
          setIsModelLoaded(true);
        }
      } else {
        setStatus('offline');
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [isModelLoaded]);

  useEffect(() => {
    localStorage.setItem('cognito_sessions', JSON.stringify(sessions));
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
    setSessions([newSession, ...sessions]);
    setCurrentSessionId(newId);
    setMessages([]);
    setIsModelLoaded(true);
  };

  const handleSelectSession = (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session) {
      setCurrentSessionId(id);
      setMessages(session.messages);
      setIsModelLoaded(true);
    }
  };

  const handleLoadModel = async () => {
    try {
      setLoading(true);
      await loadModel(modelPath);
      setIsModelLoaded(true);
      if (!currentSessionId) {
        handleNewChat();
      }
    } catch (e) {
      alert('Failed to load model: ' + e);
    } finally {
      setLoading(false);
    }
  };

  const handleChangeModel = async () => {
    if (!window.electronAPI) {
      alert("Electron API not available");
      return;
    }
    try {
      const path = await window.electronAPI.selectFile();
      if (path) {
        setModelPath(path);
        setLoading(true);
        await loadModel(path);
        setIsModelLoaded(true);
        if (!currentSessionId) {
          handleNewChat();
        }
      }
    } catch (e) {
      alert('Failed to change model: ' + e);
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
    } catch (e: any) {
      alert('Failed to upload document: ' + (e.message || e.toString()));
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

    if (!currentSessionId) {
      handleNewChat();
    }

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
            alert("Session expired. Please reload the model.");
          } else {
            alert('Error generating reply: ' + error);
          }
          setLoading(false);
          setStreamStatus(null);
          abortControllerRef.current = null;
        },
        deepSearchEnabled,  // Pass deep search flag
        useDocuments,  // Pass document RAG flag
        controller.signal
      );
    } catch (e: any) {
      alert('Error: ' + e.toString());
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

  // Show loading screen while engine is starting
  if (status === 'offline') {
    return (
      <div className="app-container">
        <div className="startup-screen">
          <div className="startup-logo">
            <h1>COGNITO</h1>
            <div className="startup-subtitle">Private. Local. Fast.</div>
          </div>
          <div className="startup-loader">
            <div className="loader-ring"></div>
            <div className="loader-ring"></div>
            <div className="loader-ring"></div>
          </div>
          <div className="startup-status">Starting Engine...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="logo">COGNITO</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {status === 'online' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="status-badge" style={{ color: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)' }}>
                {loadedModelName ? `Running: ${loadedModelName}` : 'No Model Loaded'}
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
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

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
                    {session.name}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <main className="main-content">
          {!isModelLoaded && sessions.length === 0 ? (
            <div className="setup-card">
              <h2>Load Your Model</h2>
              <p>Enter the absolute path to a .gguf file to begin.</p>
              <div className="input-group">
                <input
                  type="text"
                  placeholder="/Users/name/models/mistral.gguf"
                  value={modelPath}
                  onChange={(e) => setModelPath(e.target.value)}
                />
                <button onClick={handleLoadModel} disabled={status !== 'online' || loading}>
                  {loading ? 'Loading...' : 'Load Model'}
                </button>
              </div>
            </div>
          ) : (
            <div className="chat-interface">
              <div className="chat-history">
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', marginTop: '20%', opacity: 0.5 }}>
                    <h3 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: '1.5rem', fontWeight: 600 }}>COGNITO</h3>
                    <p>Ready to assist.</p>
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
                    className={`deep-search-btn ${deepSearchEnabled ? 'active' : ''}`}
                    onClick={() => setDeepSearchEnabled(!deepSearchEnabled)}
                    title={deepSearchEnabled ? 'Deep Search ON' : 'Deep Search OFF'}
                  >
                    🔍
                  </button>
                  <input
                    type="text"
                    placeholder={uploadedDocuments.length > 0 ? "Ask about your document..." : (deepSearchEnabled ? "Deep search enabled..." : "Type a message...")}
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
    </div>
  );
}

export default App;

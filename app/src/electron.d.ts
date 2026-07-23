export {};

declare global {
  interface Window {
    electronAPI?: {
      selectFile: () => Promise<string | null>;
      getBackendConfig: () => Promise<{ baseUrl: string; token: string }>;
    };
  }
}

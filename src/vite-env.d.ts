/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    vyraDesktop?: {
      checkForUpdates: () => void;
      installUpdate: () => void;
    };
  }
}

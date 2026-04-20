/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL (no trailing slash). Set on Vercel when the API lives on
   *  a separate origin; leave unset for same-origin single-host deploys or the
   *  local Vite dev proxy. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

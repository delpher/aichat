// Types of files.mjs for the TypeScript adapters (the module itself stays plain JS: see its header).
export declare const MIME_TYPES: Readonly<Record<string, string>>;
export declare function mimeFor(name: string): string;
export declare function nameFromDisposition(header: string | null | undefined): string;
export declare function safeFileName(name: unknown, fallback: string): string;
export declare function within(root: string, file: string): boolean;
export declare const MAX_UPLOAD_BYTES: number;
export declare function looksPrivate(file: string): boolean;
export declare function expandPath(value: string, base?: string): string;
export declare function readUpload(opts: {
  path: unknown;
  base?: string;
  roots: string[];
  blocked?: (string | undefined)[];
}): { bytes: Buffer; name: string; mime: string };
export declare function saveDownload(opts: {
  dir: string;
  id: string;
  disposition: string | null | undefined;
  fallback?: string;
  bytes: Buffer | Uint8Array;
}): { path: string; name: string };

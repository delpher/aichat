// Types of instructions.mjs for the TypeScript adapters (the module itself stays plain JS: see its header).
export interface Rules {
  text: string;
  by: string;
  ts: string;
  draft?: true;
}
export interface Fetched {
  rules: Rules;
  self: { name: string; description?: string };
}
export interface Part {
  source: "broker" | "fallback" | "adapter" | "local";
  version?: string;
}
export declare function fetchInstructions(opts: { httpBase: string; token: string; timeoutMs?: number }): Promise<Fetched | null>;
export declare function parseInstructions(data: unknown): Fetched | null;
export declare function rulesVersion(rules: Rules): string;
export declare function selfText(self: Fetched["self"]): string;
export declare const RUNTIME_HEADING: string;
export declare const LOCAL_HEADING: string;
export declare function composeInstructions(opts: {
  fetched: Fetched | null;
  runtime?: string;
  notices?: string[];
  local?: string;
  fallback?: string;
}): { text: string; parts: Part[] };

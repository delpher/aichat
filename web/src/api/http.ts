import type { FileInfo } from "./types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** The token was rejected (401): the session is over. */
export class AuthError extends HttpError {}

export async function request<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  const msg = (body as { error?: string } | null)?.error || `HTTP ${res.status}`;
  if (res.status === 401) throw new AuthError(401, msg);
  if (!res.ok) throw new HttpError(res.status, msg);
  return body as T;
}

/** A small client bound to one token. */
export function makeApi(token: string) {
  return {
    get: <T>(path: string) => request<T>(path, token),
    send: <T>(method: string, path: string, body?: unknown) =>
      request<T>(path, token, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    /** Uploads one file; `path` is /api/files or /admin/api/files?as=<person>. */
    upload: async (path: string, file: File): Promise<FileInfo> => {
      const data = await request<{ file: FileInfo }>(path, token, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
      });
      return data.file;
    },
    /** Downloads a file with the token (browsers can't put headers on <img src>), as a Blob. */
    blob: async (path: string): Promise<Blob> => {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) throw new AuthError(401, "invalid token");
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
      return res.blob();
    },
  };
}
export type Api = ReturnType<typeof makeApi>;

/** Tries the token as an admin first, then as a person's own token. */
export async function detectSession(token: string) {
  try {
    const data = await request<{ me?: { name: string; root: boolean } } & Record<string, unknown>>("/admin/api/overview", token);
    return { mode: "admin" as const, admin: data.me ?? { name: "owner", root: true }, data };
  } catch (err) {
    if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 403)) throw err;
  }
  const data = await request<{ me: { name: string; kind: string } } & Record<string, unknown>>("/api/overview", token);
  return { mode: "user" as const, me: data.me, data };
}

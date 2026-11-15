import { useEffect, useState } from "react";
import type { Api } from "../api/http";

// Files need the bearer token, so they are fetched once and shown through blob: URLs.
const cache = new Map<string, Promise<string>>();

export const filePath = (admin: boolean, id: string) => `${admin ? "/admin/api" : "/api"}/files/${encodeURIComponent(id)}`;

export function fileUrl(api: Api, path: string): Promise<string> {
  let p = cache.get(path);
  if (!p) {
    p = api.blob(path).then((b) => URL.createObjectURL(b));
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

/** Object URL of an image attachment, or null while loading; `error` when it failed. */
export function useFileUrl(api: Api, path: string | null) {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });
  useEffect(() => {
    if (!path) return;
    let live = true;
    fileUrl(api, path).then(
      (url) => live && setState({ url, error: false }),
      () => live && setState({ url: null, error: true }),
    );
    return () => {
      live = false;
    };
  }, [api, path]);
  return state;
}

/** Saves an attachment to disk. The blob is re-typed so the browser never renders it as a page. */
export async function downloadFile(api: Api, path: string, name: string) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

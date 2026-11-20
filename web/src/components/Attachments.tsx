import { Download, FileText, ImageOff, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { INLINE_IMAGE_TYPES, type FileInfo } from "../api/types";
import { useChat } from "../context";
import { downloadFile, filePath, useFileUrl } from "../hooks/useFileUrl";
import { fmtSize } from "../lib/format";

export const isImage = (f: { mime: string }) => INLINE_IMAGE_TYPES.includes(f.mime);

function ImageTile({ file, onOpen }: { file: FileInfo; onOpen: (url: string) => void }) {
  const { api, session } = useChat();
  const { url, error } = useFileUrl(api, filePath(session.mode === "admin", file.id));
  const [broken, setBroken] = useState(false);
  if (error || broken)
    return (
      <div className="att-image att-missing" title={file.name}>
        <ImageOff size={20} />
        <span>{file.name}</span>
      </div>
    );
  return (
    <button type="button" className="att-image" onClick={() => url && onOpen(url)} title={`${file.name} · ${fmtSize(file.size)}`}>
      {url ? <img src={url} alt={file.name} loading="lazy" onError={() => setBroken(true)} /> :<LoaderCircle className="spin" size={20} />}
    </button>
  );
}

function FileCard({ file }: { file: FileInfo }) {
  const { api, session, fail } = useChat();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await downloadFile(api, filePath(session.mode === "admin", file.id), file.name);
    } catch (err) {
      fail(err, `Не вдалося завантажити ${file.name}`);
    } finally {
      setBusy(false);
    }
  };
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.slice(0, 4).toUpperCase() : "";
  return (
    <button type="button" className="att-file" onClick={save} disabled={busy} title={`Завантажити ${file.name}`}>
      <span className="att-file-icon">{ext ? <span>{ext}</span> : <FileText size={18} />}</span>
      <span className="att-file-meta">
        <span className="att-file-name">{file.name}</span>
        <span className="att-file-size">{fmtSize(file.size)}</span>
      </span>
      {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
    </button>
  );
}

export function Lightbox({ url, file, onClose }: { url: string; file: FileInfo; onClose: () => void }) {
  const { api, session, fail } = useChat();
  const name = file.name;
  // saved through a download link, like other files: the blob: shown here is not one a download manager can read
  const save = () =>
    downloadFile(api, filePath(session.mode === "admin", file.id), name).catch((err) => fail(err, `Не вдалося завантажити ${name}`));
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{name}</span>
        <button type="button" className="icon-btn" onClick={() => void save()} title="Зберегти" aria-label="Зберегти">
          <Download size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} title="Закрити" aria-label="Закрити">
          <X size={18} />
        </button>
      </div>
    </div>
  );
}

export function Attachments({ files }: { files: FileInfo[] }) {
  const [open, setOpen] = useState<{ url: string; file: FileInfo } | null>(null);
  const images = files.filter(isImage);
  const others = files.filter((f) => !isImage(f));
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={`att-images n${Math.min(images.length, 3)}`}>
          {images.map((f) => (
            <ImageTile key={f.id} file={f} onOpen={(url) => setOpen({ url, file: f })} />
          ))}
        </div>
      )}
      {others.map((f) => (
        <FileCard key={f.id} file={f} />
      ))}
      {open && <Lightbox url={open.url} file={open.file} onClose={() => setOpen(null)} />}
    </div>
  );
}

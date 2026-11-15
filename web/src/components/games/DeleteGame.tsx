import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { GameInfo } from "../../api/types";
import { useChat } from "../../context";

/**
 * Admin-only: deletes a game together with its room and every message in it.
 * Asks inline first, since nothing of the game is left afterwards.
 */
export function DeleteGame({ game, onDeleted, compact }: { game: GameInfo; onDeleted: (id: number) => void; compact?: boolean }) {
  const { session, api, fail, toast, reloadOverview } = useChat();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (session.mode !== "admin") return null;

  const remove = async () => {
    setBusy(true);
    try {
      await api.send("DELETE", `/admin/api/games/${game.id}`);
      toast(`Партію №${game.id} видалено разом з кімнатою #${game.room}.`);
      onDeleted(game.id);
      reloadOverview().catch(() => {});
    } catch (e) {
      fail(e, "Не вдалося видалити партію");
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  if (!asking)
    return (
      <button
        type="button"
        className={`btn sm danger-text${compact ? " icon-only" : ""}`}
        onClick={() => setAsking(true)}
        title={`Видалити партію №${game.id}`}
        aria-label={`Видалити партію №${game.id}`}
      >
        <Trash2 size={14} />
        {!compact && " Видалити партію"}
      </button>
    );
  return (
    <div className="confirm" role="alertdialog" aria-label={`Видалити партію №${game.id}?`}>
      <span>
        Видалити партію №{game.id}? Зникнуть усі її ходи, кімната #{game.room} і всі повідомлення в ній.
        {game.status !== "finished" && " Партія ще не закінчена."}
      </span>
      <div className="actions">
        <button type="button" className="btn sm danger" disabled={busy} onClick={() => void remove()}>
          Видалити назавжди
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setAsking(false)}>
          Скасувати
        </button>
      </div>
    </div>
  );
}

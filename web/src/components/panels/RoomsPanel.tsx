import { Hash, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import { ROOM_RE, type Agent, type RoomInfo } from "../../api/types";
import { useChat } from "../../context";
import { fmtShort, kindLabel } from "../../lib/format";
import { hashFor, isGameRoom } from "../../lib/views";
import { ListSkeleton } from "../Skeleton";
import { Status, type StatusValue } from "./Status";

const enc = encodeURIComponent;

function RoomCard({
  room,
  agents,
  busy,
  run,
}: {
  room: RoomInfo;
  agents: Agent[];
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok: string) => void;
}) {
  const { api } = useChat();
  const [confirm, setConfirm] = useState(false);
  const notIn = agents
    .map((a) => a.name)
    .filter((n) => !room.members.includes(n))
    .sort();
  const [pick, setPick] = useState("");
  const kind = (n: string) => kindLabel(agents.find((a) => a.name === n)?.kind ?? "");
  const members = (n?: string) => `/admin/api/rooms/${enc(room.name)}/members${n ? `/${enc(n)}` : ""}`;
  return (
    <div className="card room-card">
      <div className="card-head">
        <a href={hashFor({ kind: "room", room: room.name })} className="room-link">
          <Hash size={16} />
          {room.name}
        </a>
        <span className="muted small num">
          {room.count} повідомл.{room.last_ts ? ` · ${fmtShort(room.last_ts)}` : ""}
        </span>
      </div>
      <div className="chips">
        {[...room.members].sort().map((m) => (
          <span key={m} className="chip">
            {m}
            <span className="muted">{kind(m)}</span>
            <button
              type="button"
              disabled={busy}
              title={`Прибрати ${m} з #${room.name}`}
              aria-label={`Прибрати ${m} з #${room.name}`}
              onClick={() => run(() => api.send("DELETE", members(m)), `${m} прибрано з #${room.name}.`)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {!room.members.length && <span className="muted small">Учасників немає</span>}
      </div>
      {notIn.length > 0 && (
        <div className="inline-form">
          <select value={pick || notIn[0]} onChange={(e) => setPick(e.target.value)} aria-label={`Додати до #${room.name}`}>
            {notIn.map((n) => (
              <option key={n} value={n}>
                {n} ({kind(n)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => {
              const n = pick && notIn.includes(pick) ? pick : notIn[0];
              run(() => api.send("POST", members(), { name: n }), `${n} додано до #${room.name}.`);
            }}
          >
            Додати
          </button>
        </div>
      )}
      {confirm ? (
        <div className="confirm">
          <span>Що зробити з #{room.name}?</span>
          <div className="actions">
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.send("DELETE", `/admin/api/rooms/${enc(room.name)}`),
                  `З #${room.name} прибрано всіх учасників, історія лишилась.`,
                )
              }
            >
              Прибрати всіх учасників (історія лишиться)
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.send("DELETE", `/admin/api/rooms/${enc(room.name)}?messages=1`),
                  `Кімнату #${room.name} видалено разом з повідомленнями.`,
                )
              }
            >
              Видалити разом з повідомленнями
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirm(false)}>
              Скасувати
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn sm danger-text" disabled={busy} onClick={() => setConfirm(true)}>
            Видалити кімнату…
          </button>
        </div>
      )}
    </div>
  );
}

export function RoomsPanel() {
  const { api, overview, fail, reloadOverview } = useChat();
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusValue>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        api.get<{ rooms: RoomInfo[] }>("/admin/api/rooms"),
        api.get<{ agents: Agent[] }>("/admin/api/agents"),
      ]);
      // Game rooms belong to their game: they go away when the game is deleted (games tab).
      setRooms((r.rooms ?? []).filter((x) => !isGameRoom(x.name)));
      setAgents(a.agents ?? []);
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setRooms((cur) => cur ?? []);
      setStatus({ text: `Не вдалося завантажити кімнати: ${(err as Error).message}`, error: true });
    }
  }, [api, fail]);
  useEffect(() => {
    void load();
  }, [load, overview.rooms]);

  const run = (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    fn()
      .then(() => setStatus({ text: ok, ok: true }))
      .catch((err) => (err instanceof AuthError ? fail(err, "") : setStatus({ text: `Помилка: ${(err as Error).message}`, error: true })))
      .finally(async () => {
        setBusy(false);
        await load();
        reloadOverview().catch(() => {});
      });
  };

  const create = () => {
    const n = name.trim().replace(/^#/, "");
    if (!ROOM_RE.test(n)) return setStatus({ text: "Назва: латиниця, цифри, - і _ (до 64 символів).", error: true });
    if (isGameRoom(n)) return setStatus({ text: "Назви game-<число> зайняті кімнатами партій.", error: true });
    const members = [...picked];
    run(
      async () => {
        await api.send("POST", "/admin/api/rooms", members.length ? { name: n, members } : { name: n });
        setName("");
        setPicked(new Set());
      },
      `Кімнату #${n} створено${members.length ? ` з учасниками: ${members.join(", ")}` : ""}.`,
    );
  };

  return (
    <div className="panel">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <h2>Нова кімната</h2>
        <div className="inline-form">
          <label className="field grow">
            <span>Назва</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="team" maxLength={64} required disabled={busy} />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={16} />} Створити
          </button>
        </div>
        <fieldset className="pick">
          <legend>Учасники</legend>
          {[...agents]
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((a) => (
              <label key={a.name} className={`pick-item${picked.has(a.name) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={picked.has(a.name)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(a.name);
                    else next.delete(a.name);
                    setPicked(next);
                  }}
                />
                {a.name} <span className="muted">{kindLabel(a.kind)}</span>
              </label>
            ))}
        </fieldset>
        <Status value={status} />
      </form>
      <section className="section">
        <div className="section-head">
          <h2>Кімнати{rooms && <span className="count">{rooms.length}</span>}</h2>
        </div>
        {!rooms ? (
          <ListSkeleton avatar={false} label="Завантаження кімнат" />
        ) : rooms.length ? (
          <div className="room-grid">
            {[...rooms]
              .sort((x, y) => x.name.localeCompare(y.name))
              .map((r) => (
                <RoomCard key={r.name} room={r} agents={agents} busy={busy} run={run} />
              ))}
          </div>
        ) : (
          <p className="muted">Кімнат ще немає. Створіть першу вище.</p>
        )}
      </section>
    </div>
  );
}

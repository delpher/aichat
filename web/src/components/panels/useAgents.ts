import { useCallback, useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import type { Agent } from "../../api/types";
import { useChat } from "../../context";

/** Everyone in agents.json as the admin API shows them, and whether that file can be changed. */
export function useAgents() {
  const { api, overview, fail } = useChat();
  const [list, setList] = useState<Agent[] | null>(null);
  const [editable, setEditable] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        api.get<{ agents: Agent[] }>("/admin/api/agents"),
        api.get<{ editable: boolean }>("/admin/api/settings"),
      ]);
      setList(a.agents ?? []);
      setEditable(s.editable !== false);
      setError("");
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setList((cur) => cur ?? []);
      setError(`Не вдалося завантажити список: ${(err as Error).message}`);
    }
  }, [api, fail]);
  useEffect(() => {
    void load();
  }, [load, overview.agents.length, overview.rooms]);

  return { list, editable, error, load };
}

/** People first, then agents, each by name. */
export const byKindAndName = (x: Agent, y: Agent) =>
  (x.kind === "human") === (y.kind === "human") ? x.name.localeCompare(y.name) : x.kind === "human" ? -1 : 1;

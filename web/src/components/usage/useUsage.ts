import { useCallback, useEffect, useState } from "react";
import { AuthError } from "../../api/http";
import type { UsageReport } from "../../api/types";
import { useChat } from "../../context";

/**
 * The usage reports this person may see (GET /api/usage), kept current by the live "usage" frames:
 * an admin gets every agent's, a person those of agents on their accounts. `accounts` are the hashes of
 * the person's own accounts, to tell their agents from the others.
 */
export function useUsage() {
  const { api, fail, subscribeUsage } = useChat();
  const [reports, setReports] = useState<UsageReport[] | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ usage?: UsageReport[]; accounts?: string[] }>("/api/usage");
      setReports(d.usage ?? []);
      setAccounts(d.accounts ?? []);
      setError("");
    } catch (err) {
      if (err instanceof AuthError) return fail(err, "");
      setReports((cur) => cur ?? []);
      setError(`Не вдалося завантажити використання: ${(err as Error).message}`);
    }
  }, [api, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => subscribeUsage((u) => setReports((cur) => (cur ? [...cur.filter((r) => r.agent !== u.agent), u] : cur))),
    [subscribeUsage],
  );

  return { reports, accounts, error, load };
}

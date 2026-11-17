import { Broker } from "../broker/broker.js";
import { validate, type AgentConfig } from "../broker/config.js";
import { Store } from "../broker/store.js";
import { BrokerClient } from "../client/broker-client.js";
import type { ChatMessage } from "../protocol.js";

export const tok = (name: string) => `token-for-${name}-xxxxxxxxxxxx`;

export async function startBroker(
  agents: Partial<AgentConfig>[],
  extra: Record<string, unknown> = {},
  opts: { webDir?: string; bundleDir?: string; games?: import("../games/game.js").GameDefinition[]; random?: () => number; now?: () => number } = {},
) {
  let cfg = validate({
    ...extra,
    agents: agents.map((a) => ({ kind: "test", token: tok(a.name!), ...a }) as AgentConfig),
  });
  const broker = new Broker({
    config: () => cfg,
    editConfig: (fn) => {
      const raw = structuredClone(cfg);
      fn(raw);
      return (cfg = validate(raw));
    },
    store: new Store(":memory:"),
    log: () => {},
    ...opts,
  });
  const port = await broker.listen(0, "127.0.0.1");
  /** Changes the config the way an edit of agents.json on disk would: the broker is not told. */
  const replaceConfig = (fn: (raw: ReturnType<typeof validate>) => void) => {
    const raw = structuredClone(cfg);
    fn(raw);
    cfg = validate(raw);
  };
  return { broker, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, cfg: () => cfg, replaceConfig };
}

export async function connect(url: string, name: string) {
  const c = new BrokerClient({ url, token: tok(name), reconnect: false, log: () => {} });
  await c.connect();
  return c;
}

export function nextMessage(c: BrokerClient, timeoutMs = 3000): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no message")), timeoutMs);
    c.once("message", (m: ChatMessage) => (clearTimeout(t), resolve(m)));
  });
}

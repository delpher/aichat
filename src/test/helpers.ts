import { Broker } from "../broker/broker.js";
import { validate, type AgentConfig } from "../broker/config.js";
import { Store } from "../broker/store.js";
import { BrokerClient } from "../client/broker-client.js";
import type { ChatMessage } from "../protocol.js";

export const tok = (name: string) => `token-for-${name}-xxxxxxxxxxxx`;

export async function startBroker(agents: Partial<AgentConfig>[], extra: Record<string, unknown> = {}) {
  const cfg = validate({
    ...extra,
    agents: agents.map((a) => ({ kind: "test", token: tok(a.name!), ...a }) as AgentConfig),
  });
  const broker = new Broker({ config: () => cfg, store: new Store(":memory:"), log: () => {} });
  const port = await broker.listen(0, "127.0.0.1");
  return { broker, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, cfg };
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

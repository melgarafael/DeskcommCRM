// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/leads/agent-activity", () => ({ emitAgentActivityForContact: vi.fn() }));
import { runVoiceCallsBridgeLoop } from "./events-bridge";
import { loadEnv } from "../agent-engine/env";

it("a validação do worker preserva a credencial de voz configurada", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    SUPABASE_DB_URL: "postgres://postgres:postgres@127.0.0.1:54322/postgres",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    WACALLS_API_BASE_URL: "http://voz.invalid",
    WACALLS_API_TOKEN: "token-de-teste",
  });
  expect(env.WACALLS_API_TOKEN).toBe("token-de-teste");
});

it("a ponte conecta ao servidor que exige Bearer e encerra a conexão no shutdown", async () => {
  const servidor = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer token-de-teste") {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": conectado\n\n");
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const porta = (servidor.address() as AddressInfo).port;
  const controle = new AbortController();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configuracao = {
    baseUrl: `http://127.0.0.1:${porta}`,
    apiToken: "token-de-teste",
    maxBackoffMs: 1000,
  };
  const loop = runVoiceCallsBridgeLoop({} as pg.Pool, configuracao, log as never, controle.signal);
  try {
    await vi.waitFor(
      () => expect(log.info).toHaveBeenCalledWith("wacalls: conectado ao stream de eventos", {}),
      { timeout: 1800 },
    );
    expect(log.error).not.toHaveBeenCalled();
  } finally {
    controle.abort();
    await loop;
    servidor.closeAllConnections();
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  }
});

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCurrentServiceBoundary,
  type CurrentServiceBoundary,
} from "@/lib/atendimento/fronteira";
import { guardServiceTools, withServiceJob } from "@/lib/atendimento/fronteira-server";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";

const boundary: CurrentServiceBoundary = {
  organization_id: "org",
  contact_id: "contact",
  conversation_id: "conversation",
  service_revision: 1,
  demanda_id: "demand",
  demanda_revision: 1,
  status: "open",
  demanda_fechada_em: null,
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
describe("fronteira imutável de atendimento", () => {
  it("reabrir não ressuscita job, demanda encerrada e tenant diferente também vetam", () => {
    expect(() => assertCurrentServiceBoundary(boundary, boundary)).not.toThrow();
    for (const changed of [
      { service_revision: 3 },
      { demanda_revision: 2 },
      { status: "closed" },
      { organization_id: "other" },
      { demanda_id: "new" },
      { demanda_fechada_em: "2026-01-01" },
    ]) {
      expect(() => assertCurrentServiceBoundary(boundary, { ...boundary, ...changed })).toThrow(
        "service_boundary_stale",
      );
    }
    expect(() => assertCurrentServiceBoundary(null, boundary)).toThrow("service_boundary_stale");
  });
  it("a resposta do lead abre a 1ª demanda e NÃO vence o acompanhamento; fechar, trocar ou virar revisão vencem", () => {
    // O gatilho de silêncio captura a fronteira de um contato CALADO, que por
    // definição não tem demanda aberta. A resposta dele abre a primeira demanda
    // e a 0222 mantém `service_revision` de propósito — é o mesmo atendimento.
    // Enquanto o predicado comparava `null !== uuid`, essa resposta vencia o
    // acompanhamento que ela mesma acordou, e o nó `ai_classify` (que existe
    // para consumi-la) ficava morto por construção.
    const semDemanda = { ...boundary, demanda_id: null, demanda_revision: null };
    expect(() => assertCurrentServiceBoundary(semDemanda, boundary)).not.toThrow();
    // O afrouxamento é só para o `null` de partida: tudo que indica atendimento
    // OUTRO continua vetando.
    for (const changed of [
      { demanda_fechada_em: "2026-01-01" },
      { service_revision: 2 },
      { status: "closed" },
    ]) {
      expect(() => assertCurrentServiceBoundary(semDemanda, { ...boundary, ...changed })).toThrow(
        "service_boundary_stale",
      );
    }
  });
  it("fechamento entre geração e tool impede o transporte HTTP real; reabertura também", async () => {
    let received = 0;
    const server = createServer((_req, res) => {
      received++;
      res.writeHead(204).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("receiver");
    let current = { ...boundary };
    const db = { query: async () => ({ rows: [current] }) } as unknown as Queryable;
    const job = {
      organization_id: "org",
      contact_id: "contact",
      kind: "inbound_turn",
      payload: { service_boundary: boundary },
    } as unknown as JobRow;
    await withServiceJob(db, job, async () => {
      const tools = guardServiceTools({
        send_message: {
          inputSchema: {} as never,
          execute: async () => {
            await fetch(`http://127.0.0.1:${address.port}`);
            return { ok: true };
          },
        },
      });
      const execute = tools?.send_message?.execute;
      if (!execute) throw new Error("missing execute");
      current = { ...current, status: "closed", service_revision: 2 };
      await expect(execute({}, {} as never)).rejects.toThrow("service_boundary_stale");
      current = { ...current, status: "open", service_revision: 3 };
      await expect(execute({}, {} as never)).rejects.toThrow("service_boundary_stale");
    });
    expect(received).toBe(0);
  });
  it("trabalho legado não ganha validade no claim", async () => {
    const db = { query: async () => ({ rows: [boundary] }) } as unknown as Queryable;
    let operated = false;
    await expect(
      withServiceJob(db, { kind: "operator_turn", payload: {} } as JobRow, async () => {
        operated = true;
      }),
    ).rejects.toThrow("service_boundary_stale");
    expect(operated).toBe(false);
  });
});

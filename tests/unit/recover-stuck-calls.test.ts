/**
 * A REGRA do cron `recover-stuck-calls`.
 *
 * Ligação SIP recebida que caía antes de o AudioSocket conectar ficava
 * `voice_calls.status='ringing'` para sempre, e o painel de voz a adotava no
 * boot como "ligação chegando" (medido numa VPS em 2026-11-04). Cada propriedade
 * abaixo existe porque errar nela recria um defeito:
 *
 *   1. só mexe em `starting`/`ringing` mais velha que o prazo, medida por
 *      `created_at` — encerrar cedo derruba toque de verdade;
 *   2. o UPDATE repete o filtro de status — sem esse claim, uma ligação
 *      atendida entre o SELECT e o UPDATE seria encerrada no meio da conversa;
 *   3. o UPDATE filtra `organization_id` — é service role, sem RLS;
 *   4. rodada que a corrida esvaziou não conta como encerramento.
 */
import { describe, expect, it } from "vitest";

import {
  STATUS_DE_TOQUE,
  STUCK_CALL_AFTER_MS,
  recoverStuckCalls,
} from "@/app/api/v1/cron/recover-stuck-calls/route";

interface Chamada {
  op: string;
  tabela: string;
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

/**
 * Dublê mínimo: registra o que foi pedido e devolve o que a rodada encontraria.
 * Método não previsto estoura, para o teste não passar por um caminho que ele
 * não modela.
 */
function clientDuble(presas: { id: string; organization_id: string }[], atualizadas?: { id: string }[]) {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let valores: Record<string, unknown> | undefined;
      let op = "select";
      const cadeia = {
        select: () => cadeia,
        update(v: Record<string, unknown>) {
          op = "update";
          valores = v;
          return cadeia;
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          return cadeia;
        },
        in(col: string, val: unknown) {
          filtros[`in:${col}`] = val;
          return cadeia;
        },
        lt(col: string, val: unknown) {
          filtros[`lt:${col}`] = val;
          return cadeia;
        },
        limit: () => cadeia,
        then(resolve: (r: unknown) => void) {
          chamadas.push({ op, tabela, filtros, valores });
          if (op === "select") return resolve({ data: presas, error: null });
          const ids = (filtros["in:id"] as string[]) ?? [];
          return resolve({ data: atualizadas ?? ids.map((id) => ({ id })), error: null });
        },
      };
      return cadeia;
    },
  };
  return { client: client as never, chamadas };
}

const AGORA = new Date("2026-11-04T12:00:00.000Z");
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

describe("recover-stuck-calls", () => {
  it("procura só ligações em toque mais velhas que o prazo, por created_at", async () => {
    const { client, chamadas } = clientDuble([]);
    const r = await recoverStuckCalls(client, AGORA, "req");

    expect(r).toEqual({ scanned: 0, ended: 0, organizations: 0 });
    expect(chamadas).toHaveLength(1);
    const [busca] = chamadas;
    expect(busca!.tabela).toBe("voice_calls");
    expect(busca!.filtros["in:status"]).toEqual(["starting", "ringing"]);
    expect(busca!.filtros["lt:created_at"]).toBe(new Date(AGORA.getTime() - STUCK_CALL_AFTER_MS).toISOString());
  });

  it("não considera `connected` presa: ligação longa não tem prazo", () => {
    expect(STATUS_DE_TOQUE).not.toContain("connected");
    expect(STATUS_DE_TOQUE).not.toContain("ended");
  });

  it("encerra como timeout, por organização, repetindo o filtro de status no UPDATE", async () => {
    const { client, chamadas } = clientDuble([
      { id: "c1", organization_id: ORG_A },
      { id: "c2", organization_id: ORG_A },
      { id: "c3", organization_id: ORG_B },
    ]);
    const r = await recoverStuckCalls(client, AGORA, "req");

    expect(r).toEqual({ scanned: 3, ended: 3, organizations: 2 });
    const updates = chamadas.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.tabela).toBe("voice_calls");
      expect(u.valores).toEqual({ status: "ended", end_reason: "timeout", ended_at: AGORA.toISOString() });
      expect(u.filtros["in:status"]).toEqual(["starting", "ringing"]);
    }
    expect(updates.map((u) => [u.filtros["eq:organization_id"], u.filtros["in:id"]])).toEqual([
      [ORG_A, ["c1", "c2"]],
      [ORG_B, ["c3"]],
    ]);
  });

  it("a ligação que a corrida levou (atendida no meio) não conta como encerrada", async () => {
    const { client } = clientDuble([{ id: "c1", organization_id: ORG_A }], []);
    const r = await recoverStuckCalls(client, AGORA, "req");
    expect(r).toEqual({ scanned: 1, ended: 0, organizations: 0 });
  });
});

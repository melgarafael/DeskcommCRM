/**
 * O DESPACHO DA IA QUE MORRE AVISA A CENTRAL.
 *
 * `lib/event-log/drain.ts` passou a abrir `event_dead` quando desiste de um
 * evento (#871). O outro dreno que marca `dead` em `event_log` —
 * `lib/agent-engine/edge/crm/drain.ts`, dono do `ai_agent.dispatch_requested` —
 * seguia calado depois disso, e é o evento cujo efeito perdido é a RESPOSTA ao
 * cliente. Conserto por instância deixava a classe de pé.
 *
 * Entra por `drainTick`, o ponto de uso que o worker chama, com um `pg.Pool`
 * dublê que registra o SQL e os parâmetros. O dedupe de verdade (o `where not
 * exists` contra a tabela real) não se prova com dublê: ele é medido contra
 * Postgres em `tests/invariants/evento-morto-nao-inunda-a-central.test.ts`.
 *
 *     npx vitest run tests/unit/despacho-da-ia-que-morre-avisa-a-central.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";

const KNOBS = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60_000 };
const ORG = "abcd0000-0000-4000-8000-000000000001";
const MOTIVO = "insert or update on table job_queue violates foreign key constraint";

interface Chamada {
  sql: string;
  params: unknown[];
}

function evento(attempts: number) {
  return {
    id: "ev-1",
    organization_id: ORG,
    attempts,
    created_at: new Date().toISOString(),
    payload: {
      conversation_id: "11111111-1111-4111-8111-111111111111",
      contact_id: "22222222-2222-4222-8222-222222222222",
      channel_session_id: "33333333-3333-4333-8333-333333333333",
      inbound_message_id: "44444444-4444-4444-8444-444444444444",
    },
  };
}

/**
 * O processamento do evento falha na primeira consulta dele — o motivo exato não
 * importa para o dreno, que só conta tentativas. `avisoFalha` faz o INSERT do
 * aviso lançar, como faria uma conexão caída.
 */
function poolQueFalha(attempts: number, opts: { avisoFalha?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes("returning e.id")) return { rows: [evento(attempts)] };
    if (sql.includes("ai_dispatch_mode")) throw new Error(MOTIVO);
    if (sql.includes("insert into agent_inbox_items")) {
      if (opts.avisoFalha) throw new Error("Connection terminated unexpectedly");
      return { rows: [{ id: "aviso-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas };
}

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const avisos = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.sql.includes("insert into agent_inbox_items"));

describe("drainTick — o despacho que morre abre `event_dead` na Central", () => {
  it("na 5ª tentativa, marca dead E abre o aviso, com a organização da LINHA e o motivo", async () => {
    const { pool, chamadas } = poolQueFalha(5);

    await drainTick(pool, KNOBS, log() as never);

    const morte = chamadas.find((c) => c.sql.includes("last_error = $3"));
    expect(morte?.params[1], "o evento não foi dado como morto").toBe("dead");

    const [aviso] = avisos(chamadas);
    expect(aviso, "o despacho da IA morreu e ninguém ficou sabendo").toBeDefined();
    const [organizacao, kind, severidade, titulo, corpo] = aviso!.params as string[];
    expect({ organizacao, kind, severidade }).toEqual({
      organizacao: ORG,
      kind: "event_dead",
      severidade: "critical",
    });
    expect(titulo).toBe("A IA deixou de responder uma mensagem de cliente");
    expect(corpo).toContain(MOTIVO);
    expect(corpo).toContain("Inbox");
    // O corpo só pede o que a tela oferece: não há tela de eventos nem botão de
    // reprocessar.
    expect(corpo).not.toMatch(/reprocess/i);
  });

  it("o aviso usa o dedupe por KIND E TÍTULO — um aberto por organização, que outro event_dead não cala", async () => {
    const { pool, chamadas } = poolQueFalha(5);

    await drainTick(pool, KNOBS, log() as never);

    const [aviso] = avisos(chamadas);
    // `insertInboxItem(..., 'kind_e_titulo')`: o `where not exists` casa
    // organização + kind + título + aberto. Com `kind` sozinho, um `event_dead`
    // de mídia aberto engolia este; com `kind_e_ref`, ou sem dedupe nenhum, cada
    // despacho morto abriria um aviso próprio. O que isso faz contra a tabela
    // real é medido em
    // tests/invariants/aviso-da-ia-nao-some-atras-de-outro-evento-morto.test.ts.
    expect(aviso!.sql).toMatch(/where not exists/);
    expect(aviso!.params[7], "dedupe por kind+ref: cada morte abriria um aviso").toBe(false);
    expect(aviso!.params[8], "dedupe só por kind: o aviso de mídia aberto cala este").toBe(true);
  });

  it("falha que ainda VAI tentar de novo não avisa (controle)", async () => {
    const { pool, chamadas } = poolQueFalha(2);

    await drainTick(pool, KNOBS, log() as never);

    const reagendado = chamadas.find((c) => c.sql.includes("last_error = $3"));
    expect(reagendado?.params[1]).toBe("pending");
    expect(avisos(chamadas), "avisou antes de o evento morrer — cinco avisos por despacho").toHaveLength(0);
  });

  it("aviso que falha não derruba o tick — e fica no log", async () => {
    const { pool } = poolQueFalha(5, { avisoFalha: true });
    const l = log();

    await expect(drainTick(pool, KNOBS, l as never)).resolves.toBe(1);
    expect(l.error).toHaveBeenCalledWith(
      "drain: aviso de despacho morto falhou",
      expect.objectContaining({ event_id: "ev-1" }),
    );
  });
});

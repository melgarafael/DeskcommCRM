import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OPERADOR SILENCIOSO — a fala HUMANA de saída (`fromMe`, não-eco) acorda o Operador.
 *
 * Em organizações 100% humanas e depois do handoff, quem conversa é uma pessoa pelo
 * celular. Sem isto o funil só andava quando o Conversador falava.
 *
 * Regras travadas aqui:
 *   - fala humana NÃO-eco → enfileira UM `operator_turn`, com +60 s de atraso (debounce);
 *   - já existe `operator_turn` pendente do contato → NÃO enfileira outro (a fala entra de carona);
 *   - ECO de envio do próprio CRM → NÃO enfileira (não é fala humana);
 *   - papel do Operador desligado / sem agente → NÃO enfileira;
 *   - falha ao enfileirar NUNCA derruba a ingestão: a mensagem continua gravada.
 *
 * O teste entra pelo caminho de produção (`dispatchWahaEvent`), como `ingest-celular.test.ts`,
 * de onde vem o dublê de banco.
 */

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(), query: vi.fn(), agente: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/agent-engine/queue/queue", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueJob: mocks.enqueue,
}));
vi.mock("@/lib/agent-engine/agent/agent-config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConversationAgentConfig: mocks.agente,
}));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

interface LinhaMessage {
  id: string;
  organization_id: string;
  external_id: string | null;
  direction?: string;
  body?: string | null;
  sent_via?: string;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

/** Admin de mentira com um "banco" em memória só de `messages`. */
function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = []): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    external_id: null,
    ...m,
  }));
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const consulta = () => {
    let org: string | null = null;
    let externos: string[] = [];
    const filtrosExtras: Array<[string, unknown]> = [];
    // `.neq()` APLICADO, não decorativo: a re-checagem pós-insert da ingestão
    // (corrida com o envio, lib/waha/ingest.ts) exclui a própria linha recém-
    // inserida por `neq("id")`. Um elo que ignorasse o filtro acharia o eco nele
    // mesmo e mediria o caminho errado.
    const diferentes: Array<[string, unknown]> = [];
    const q = {
      neq(coluna: string, valor: unknown) {
        diferentes.push([coluna, valor]);
        return q;
      },
      eq(coluna: string, valor: string) {
        if (coluna === "organization_id") org = valor;
        else filtrosExtras.push([coluna, valor]);
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        else filtrosExtras.push([coluna, valores]);
        return q;
      },
      is(coluna: string, valor: unknown) {
        // `.is(col, null)` = `col IS NULL`. A checagem de eco do próprio envio
        // (`ehEcoDeEnvioNosso`, ver `lib/waha/ingest.ts`) pergunta por linhas
        // ainda SEM `external_id`; sem este elo o dublê estoura em
        // "is is not a function" e nove casos deste arquivo caem por um motivo
        // que nada tem a ver com o que eles medem.
        filtrosExtras.push([coluna, valor]);
        return q;
      },
      gte() {
        return q;
      },
      order() {
        return q;
      },
      then(ok: (v: unknown) => unknown) {
        // A checagem de eco lê uma LISTA (sem `.maybeSingle()`). Este arquivo
        // não mede o silêncio — quem mede é
        // `tests/unit/eco-do-envio-nao-silencia-o-bot.test.ts` —, então aqui
        // basta responder no formato certo.
        const casadas = messages.filter(
          (m) =>
            (org === null || m.organization_id === org) &&
            filtrosExtras.every(([c, v]) => (Array.isArray(v) ? v.includes(m[c]) : (m[c] ?? null) === v)) &&
            diferentes.every(([c, v]) => m[c] !== v),
        );
        return Promise.resolve(ok({ data: casadas, error: null }));
      },
      limit() {
        return q;
      },
      async maybeSingle() {
        const achou = messages.find(
          (m) =>
            m.organization_id === org &&
            m.external_id !== null &&
            externos.includes(m.external_id) &&
            diferentes.every(([c, v]) => m[c] !== v),
        );
        return { data: achou ? { id: achou.id } : null, error: null };
      },
    };
    return q;
  };

  const tabela = (nome: string) => ({
    select: () => consulta(),
    insert: (linha: Record<string, unknown>) => ({
      select: () => ({
        async maybeSingle() {
          if (nome !== "messages") return { data: { id: "x" }, error: null };
          const externo = linha.external_id as string | null;
          const colide =
            externo !== null &&
            messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo);
          if (colide) {
            return {
              data: null,
              error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' },
            };
          }
          const nova = { id: `msg-${messages.length + 1}`, ...linha } as LinhaMessage;
          messages.push(nova);
          return { data: { id: nova.id }, error: null };
        },
      }),
    }),
    // Encadeável em qualquer profundidade/ordem (.eq().in(), .eq().eq(), ...) — o
    // `pausarIaPorAtendimentoManual` (ver `lib/escalacao/atendimento-manual.ts`) faz `.update(...).eq("id",
    // ...).eq("organization_id", ...)`, dois `.eq()` seguidos, diferente do `.eq().in()`
    // que os demais updates deste arquivo já usavam. `await` num objeto plano (não-thenable)
    // simplesmente devolve o objeto — por isso resolver como `{ error: null }` direto
    // funciona em qualquer ponto da cadeia.
    update: () => {
      const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
        error: null,
        eq: () => encadeavel,
        in: () => encadeavel,
      };
      return encadeavel;
    },
  });

  const admin = {
    from: (nome: string) => tabela(nome),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      // Sem os ids de retorno o ingest desiste antes do insert e o teste
      // passaria por não ter exercitado nada.
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, messages, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };

function envelope(payload: WahaPayload): WahaEnvelope {
  return { event: "message.any", session: "default", payload };
}

const CELULAR: WahaPayload = {
  id: "true_990000000000001@lid_2A1B890FB8AA87730CBC",
  from: "990000000000001@lid",
  fromMe: true,
  body: "respondi por aqui mesmo",
  timestamp: 1_760_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agente.mockResolvedValue({ agentId: "agente-1", operatorEnabled: true });
  mocks.query.mockResolvedValue({ rows: [] }); // nenhum operator_turn pendente
  mocks.enqueue.mockResolvedValue({ job: { id: "op-1" }, deduped: false });
});

describe("fala humana de saída (fromMe, não-eco)", () => {
  it("enfileira UM operator_turn do contato, com +60 s de debounce e sem nada de envio", async () => {
    const { admin, messages } = bancoDeMentira();
    const antes = Date.now();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");

    expect(messages).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const [, org, entrada] = mocks.enqueue.mock.calls[0]!;
    expect(org).toBe("org-1");
    expect(entrada).toMatchObject({
      kind: "operator_turn",
      leadId: "contato-1",
      // dedup pela MENSAGEM: a mesma fala reentregue pelo webhook não gera segundo Operador
      sourceEventId: messages[0]!.id,
      payload: { conversation_id: "conversa-1", origin_job_id: messages[0]!.id, agent_id: "agente-1", trigger: "fala_humana" },
    });
    const atraso = (entrada.runAfter as Date).getTime() - antes;
    expect(atraso).toBeGreaterThanOrEqual(59_000);
    expect(atraso).toBeLessThanOrEqual(62_000);
  });

  it("DEBOUNCE: já há operator_turn pendente deste contato → não enfileira outro", async () => {
    mocks.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");

    expect(messages, "a mensagem tem de ser gravada de qualquer jeito").toHaveLength(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // a pergunta é POR CONTATO e só sobre operator_turn pendente
    const [sql, params] = mocks.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/kind = 'operator_turn'/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual(["org-1", "contato-1"]);
  });

  it("duas falas seguidas: a 1ª enfileira, a 2ª (com a 1ª pendente) entra de carona", async () => {
    const { admin } = bancoDeMentira();
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");
    expect(mocks.enqueue).toHaveBeenCalledOnce();

    mocks.query.mockResolvedValue({ rows: [{ "?column?": 1 }] }); // a 1ª agora está pendente
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...CELULAR, id: "true_990000000000001@lid_OUTRAMSG", body: "e mais uma coisa" }),
      "req-2",
    );
    expect(mocks.enqueue, "o debounce não segurou a rajada").toHaveBeenCalledOnce();
  });

  it("papel do Operador desligado → não enfileira", async () => {
    mocks.agente.mockResolvedValue({ agentId: "agente-1", operatorEnabled: false });
    const { admin } = bancoDeMentira();
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("sem agente na conversa → não enfileira", async () => {
    mocks.agente.mockResolvedValue(null);
    const { admin } = bancoDeMentira();
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("falha ao enfileirar NÃO derruba a ingestão — a mensagem fica gravada", async () => {
    mocks.enqueue.mockRejectedValue(new Error("connection terminated"));
    const { admin, messages } = bancoDeMentira();
    await expect(
      dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1"),
    ).resolves.not.toThrow();
    expect(messages).toHaveLength(1);
  });
});

describe("ECO do envio do próprio CRM", () => {
  it("NÃO é fala humana: não enfileira operator_turn", async () => {
    // O CRM gravou o envio ANTES de falar com o canal (queued, sem external_id) e o eco chega com o mesmo texto.
    const { admin } = bancoDeMentira([
      {
        conversation_id: "conversa-1",
        direction: "outbound",
        sent_via: "ai",
        status: "queued",
        external_id: null,
        body: CELULAR.body,
        type: "text",
        updated_at: new Date().toISOString(),
      },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope(CELULAR), "req-1");

    expect(mocks.enqueue, "o eco do envio do CRM acordou o Operador como se fosse humano").not.toHaveBeenCalled();
    expect(mocks.agente, "nem chegou a consultar o agente").not.toHaveBeenCalled();
  });
});

describe("mensagem recebida (inbound) não passa por este caminho", () => {
  it("fromMe=false não enfileira operator_turn aqui (quem trata é o inbound_turn)", async () => {
    const { admin } = bancoDeMentira();
    await dispatchWahaEvent(
      admin as never,
      SESSION as never,
      envelope({ ...CELULAR, id: "false_990000000000001@lid_ABC", fromMe: false }),
      "req-1",
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

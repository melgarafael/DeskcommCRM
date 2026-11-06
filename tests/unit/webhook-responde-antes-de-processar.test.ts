import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";

/**
 * A ENTRADA DO NÚMERO OFICIAL RESPONDE ANTES DE PROCESSAR.
 *
 * Medido numa instalação real (27/10/2026): o provedor dá por falha a entrega
 * que não responde em 5 s, e 368 de 1.304 mensagens em 30 dias tiveram uma
 * tentativa vencida (p50 3,6 s e p90 4,6 s na 1ª tentativa, no pico). Agora:
 *
 *   - a rota responde 200 sem esperar a ingestão, que roda no `after()`;
 *   - se o arquivo (a caixa durável) não gravou, 503 — nunca 200;
 *   - o que o `after()` não terminar (contêiner reiniciou) o cron reprocessa
 *     UMA vez, pela mesma ingestão, sem duplicar;
 *   - linha recente, de outro canal ou não aceita, ele não toca;
 *   - a que passou da janela não é ingerida: vira `dead` com aviso.
 *
 * O banco é dublado EM MEMÓRIA e os filtros mordem (`eq`, `in`, `gte`, `lt`,
 * `is`, `order`, `limit`): um dublê que só registra a chamada diria "reprocessou
 * uma vez" de uma consulta que, no banco, pegaria a linha errada.
 */

// ─── O banco em memória ──────────────────────────────────────────────────────

type Linha = Record<string, unknown>;
const banco = vi.hoisted(() => ({
  tabelas: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
  /** Quando preenchido, o INSERT/UPDATE desta tabela devolve erro. */
  falhaDeEscrita: {} as Record<string, string>,
}));

function filtrar(linhas: Linha[], filtros: Array<(l: Linha) => boolean>): Linha[] {
  return linhas.filter((l) => filtros.every((f) => f(l)));
}

function consulta(tabela: string) {
  const filtros: Array<(l: Linha) => boolean> = [];
  let ordem: { coluna: string; asc: boolean } | null = null;
  let limite: number | null = null;
  let op: { tipo: "select" } | { tipo: "update"; patch: Linha } | { tipo: "insert"; linha: Linha } = {
    tipo: "select",
  };

  const executar = () => {
    const todas = (banco.tabelas[tabela] ??= []);
    if (op.tipo === "insert") {
      if (banco.falhaDeEscrita[tabela]) return { data: null, error: { message: banco.falhaDeEscrita[tabela] } };
      // Os defaults das colunas que o código não manda (os do baseline).
      const padrao: Linha =
        tabela === "webhook_events_log"
          ? { received_at: new Date().toISOString(), processed_at: null, valid_signature: null }
          : tabela === "agent_inbox_items"
            ? { status: "open" }
            : {};
      const nova = { id: `${tabela}-${++banco.seq}`, ...padrao, ...op.linha };
      todas.push(nova);
      return { data: [{ id: nova.id }], error: null };
    }
    let alvo = filtrar(todas, filtros);
    if (op.tipo === "update") {
      if (banco.falhaDeEscrita[tabela]) return { data: null, error: { message: banco.falhaDeEscrita[tabela] } };
      for (const l of alvo) Object.assign(l, op.patch);
      return { data: alvo.map((l) => ({ id: l.id })), error: null };
    }
    if (ordem) {
      const { coluna, asc } = ordem;
      alvo = [...alvo].sort((a, b) => (String(a[coluna]) < String(b[coluna]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (limite !== null) alvo = alvo.slice(0, limite);
    return { data: alvo.map((l) => ({ ...l })), error: null };
  };

  const q: Record<string, unknown> = {
    select: () => q,
    insert: (linha: Linha) => ((op = { tipo: "insert", linha }), q),
    update: (patch: Linha) => ((op = { tipo: "update", patch }), q),
    eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
    neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
    in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
    gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), q),
    lt: (c: string, v: string) => (filtros.push((l) => String(l[c]) < v), q),
    is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
    like: (c: string, padrao: string) =>
      (filtros.push((l) => typeof l[c] === "string" && (l[c] as string).startsWith(padrao.replace(/%$/, ""))), q),
    order: (coluna: string, o?: { ascending?: boolean }) => ((ordem = { coluna, asc: o?.ascending !== false }), q),
    limit: (n: number) => ((limite = n), q),
    maybeSingle: async () => {
      const r = executar();
      return { data: (r.data as Linha[] | null)?.[0] ?? null, error: r.error };
    },
    single: async () => {
      const r = executar();
      return { data: (r.data as Linha[] | null)?.[0] ?? null, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(executar()).then(ok, ko),
  };
  return q;
}

const admin = { from: (tabela: string) => consulta(tabela), rpc: async () => ({ data: null, error: null }) };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  // A primeira forma (com `archived_at`) é a que o banco atual aceita.
  queryTolerantToMissingArchived: async (comArquivo: () => Promise<unknown>) => comArquivo(),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => SEGREDO }));
const auditoria = vi.hoisted(() => ({ linhas: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit", () => ({
  audit: async (linha: Record<string, unknown>) => {
    auditoria.linhas.push(linha);
  },
}));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));

// ─── O `after()` do Next: guardado, para o caso decidir QUANDO ele roda ──────
//
// Não rodar é exatamente o contêiner que reiniciou no meio.
const depois = vi.hoisted(() => ({ tarefas: [] as Array<() => Promise<unknown>> }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof NextServer>()),
  after: (tarefa: () => Promise<unknown>) => {
    depois.tarefas.push(tarefa);
  },
}));
async function rodarODepois(): Promise<void> {
  for (const tarefa of depois.tarefas.splice(0)) await tarefa();
}

// ─── A ingestão: lenta, falhando, e com o `unique (org, external_id)` ────────
const ingestao = vi.hoisted(() => ({
  chamadas: 0,
  /** O que cada chamada pediu: só o reprocessamento retoma os efeitos. */
  retomadas: [] as Array<boolean | undefined>,
  demoraMs: 0,
  falhasRestantes: 0,
  /** As mensagens gravadas — o índice único da tabela `messages`. */
  mensagens: new Set<string>(),
}));
vi.mock("@/lib/channels/zernio/ingest", () => ({
  aplicarEdicaoZernio: async () => "aplicado",
  ingestZernioInbound: async (
    _a: unknown,
    input: { organizationId: string; retomada?: boolean; payload: { message: { platformMessageId: string } } },
  ) => {
    ingestao.chamadas += 1;
    ingestao.retomadas.push(input.retomada);
    if (ingestao.demoraMs > 0) await new Promise((r) => setTimeout(r, ingestao.demoraMs));
    if (ingestao.falhasRestantes > 0) {
      ingestao.falhasRestantes -= 1;
      throw new Error("zernio_ingest_insert_failed: canceling statement due to statement timeout");
    }
    const chave = `${input.organizationId}:${input.payload.message.platformMessageId}`;
    if (ingestao.mensagens.has(chave)) return { status: "duplicate", conversationId: "conv-1" };
    ingestao.mensagens.add(chave);
    return { status: "ingested", conversationId: "conv-1", messageId: `msg-${ingestao.mensagens.size}` };
  },
}));

import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";
import { GET as cronWebhookReplay } from "@/app/api/v1/cron/webhook-replay/route";
import {
  ESPERA_DA_ENTRADA_MS,
  JANELA_DA_ENTRADA_MS,
  reprocessarEntradasAceitas,
} from "@/lib/channels/reprocessar-entradas-aceitas";
import { MAX_TENTATIVAS } from "@/lib/channels/reprocessar-arquivo-de-webhook";
import { MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU } from "@/lib/event-log/aviso-de-evento-morto";
import { esquecerRetrato, RECURSOS_DO_CRON, semearRetrato, type RecursoDoCron } from "@/lib/cron/piso-ocioso";

const SEGREDO = "segredo-da-sessao-longo-o-bastante";
const CONTA = "acc_sintetica_desta_sessao";
const SESSAO = {
  id: "sessao-1",
  organization_id: "org-1",
  provider: "zernio",
  display_name: "Número oficial",
  phone_number: "+5511900000002",
  webhook_secret_encrypted: "\\xab",
  webhook_path_token: "token-de-teste",
  archived_at: null,
  zernio_account_id: CONTA,
};

const mensagem = (wamid = "wamid.SINTETICO") => ({
  id: "evt_1",
  event: "message.received",
  account: { id: CONTA },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: wamid,
    direction: "incoming",
    text: "oi, vocês entregam?",
    attachments: [],
    sender: { phoneNumber: "+5511900000003", name: "Cliente" },
    sentAt: "2026-10-27T12:00:00.000Z",
  },
});

function pedido(corpo: unknown) {
  const cru = JSON.stringify(corpo);
  return new Request("http://x/api/v1/webhooks/channel/token-de-teste", {
    method: "POST",
    body: cru,
    headers: {
      "x-zernio-signature": createHmac("sha256", SEGREDO).update(cru, "utf8").digest("hex"),
      "content-type": "application/json",
    },
  });
}

const entregar = (corpo: unknown) =>
  POST(pedido(corpo) as never, { params: Promise.resolve({ token: "token-de-teste" }) } as never);

const arquivo = () => (banco.tabelas.webhook_events_log ?? []) as Linha[];
const avisos = () => (banco.tabelas.agent_inbox_items ?? []) as Linha[];

/** Uma linha que a rota aceitou e cujo `after()` não terminou, recebida há `idadeMs`. */
function linhaAceita(agora: Date, idadeMs: number, extra: Linha = {}): Linha {
  const corpo = JSON.stringify(mensagem(String(extra.wamid ?? "wamid.SINTETICO")));
  const l: Linha = {
    id: `arq-${++banco.seq}`,
    organization_id: "org-1",
    channel_session_id: "sessao-1",
    provider: "zernio",
    raw_body: corpo,
    payload_parsed: JSON.parse(corpo),
    status: "received",
    valid_signature: true,
    attempts: 0,
    error_message: null,
    received_at: new Date(agora.getTime() - idadeMs).toISOString(),
    processed_at: null,
    ...extra,
  };
  delete l.wamid;
  (banco.tabelas.webhook_events_log ??= []).push(l);
  return l;
}

beforeEach(() => {
  // O portão do piso ocioso da rota do cron: tudo com trabalho, sem ir ao banco.
  // (O sinal que ele lê está provado em `lib/cron/piso-ocioso.test.ts`.)
  esquecerRetrato();
  semearRetrato(Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, true])) as Record<RecursoDoCron, boolean>);
  banco.tabelas = { channel_sessions: [{ ...SESSAO }] };
  banco.seq = 0;
  banco.falhaDeEscrita = {};
  depois.tarefas.length = 0;
  ingestao.chamadas = 0;
  ingestao.retomadas.length = 0;
  ingestao.demoraMs = 0;
  ingestao.falhasRestantes = 0;
  ingestao.mensagens.clear();
  auditoria.linhas.length = 0;
});

describe("a rota responde antes de processar", () => {
  it("com a ingestão demorando 2 s, a resposta sai sem esperar por ela", async () => {
    ingestao.demoraMs = 2_000;

    const t0 = performance.now();
    const res = await entregar(mensagem());
    const ms = performance.now() - t0;

    expect(res.status).toBe(200);
    // 500 ms é folga de CI; medido localmente, a resposta sai em poucos ms.
    expect(ms, `a resposta levou ${ms.toFixed(0)} ms`).toBeLessThan(500);
    expect((await res.json()).data).toEqual({ status: "accepted" });
    expect(ingestao.chamadas, "a resposta esperou a ingestão").toBe(0);
    // A linha nasceu aceita e pendente: é o que o cron procura se o `after()` morrer.
    expect(arquivo()).toHaveLength(1);
    expect(arquivo()[0]).toMatchObject({ status: "received", valid_signature: true, processed_at: null });
  });

  it("a ingestão corre depois da resposta, e fecha a linha como processada", async () => {
    await entregar(mensagem());
    expect(depois.tarefas).toHaveLength(1);

    await rodarODepois();

    expect(ingestao.chamadas).toBe(1);
    expect(ingestao.retomadas, "a entrada ao vivo não pode retomar efeitos").toEqual([false]);
    expect(ingestao.mensagens.size).toBe(1);
    expect(arquivo()[0]).toMatchObject({ status: "processed", valid_signature: true });
    expect(arquivo()[0]!.processed_at).toEqual(expect.any(String));
  });

  it("a ingestão que falha depois da resposta deixa a linha pendente, com a 1ª tentativa contada", async () => {
    ingestao.falhasRestantes = 1;
    await entregar(mensagem());
    await rodarODepois();

    expect(arquivo()[0]).toMatchObject({ status: "received", valid_signature: true, attempts: 1, processed_at: null });
    expect(String(arquivo()[0]!.error_message)).toContain("statement timeout");
  });

  it("o arquivo não gravou: 503 com Retry-After, nada agendado, nada ingerido", async () => {
    banco.falhaDeEscrita = { webhook_events_log: "connection refused" };

    const res = await entregar(mensagem());

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(depois.tarefas).toHaveLength(0);
    expect(ingestao.chamadas).toBe(0);
  });

  it("o arquivo gravou mas não se deixou marcar como aceito: 503, e a linha não fica pendente", async () => {
    // O INSERT passa e o UPDATE da marca falha (o banco caiu entre os dois).
    const original = admin.from;
    admin.from = (tabela: string) => {
      const q = original(tabela) as Record<string, unknown>;
      if (tabela !== "webhook_events_log") return q;
      const update = q.update as (p: Linha) => unknown;
      q.update = (p: Linha) => {
        if (p.valid_signature === true && !("status" in p)) {
          return { eq: () => ({ eq: () => ({ select: async () => ({ data: null, error: { message: "down" } }) }) }) };
        }
        return update(p);
      };
      return q;
    };
    try {
      const res = await entregar(mensagem());
      expect(res.status).toBe(503);
      expect(depois.tarefas).toHaveLength(0);
      expect(ingestao.chamadas).toBe(0);
      expect(arquivo()[0]).toMatchObject({ status: "error", error_message: "nao_aceita_reentrega_pedida" });
    } finally {
      admin.from = original;
    }
  });

  it("evento que não é mensagem nova continua respondendo DEPOIS de processar", async () => {
    // Desfecho de envio: o reprocessamento atrasado rebaixaria o tique. Fica como era.
    const status = { ...mensagem(), event: "message.delivered" };
    const res = await entregar(status);
    expect(res.status).toBe(200);
    expect(depois.tarefas).toHaveLength(0);
    expect(arquivo()[0]).toMatchObject({ status: "processed" });
  });
});

describe("o cron reprocessa a entrada aceita que ficou no meio", () => {
  it("o contêiner reiniciou antes do after(): o cron reprocessa UMA vez, e a mensagem entra uma vez", async () => {
    const recebidaEm = Date.now();
    await entregar(mensagem());
    depois.tarefas.length = 0; // o processo morreu: o `after()` nunca rodou

    const dezMinDepois = new Date(recebidaEm + 10 * 60_000);
    const r1 = await reprocessarEntradasAceitas(admin as never, dezMinDepois);
    expect(r1).toEqual({ lidas: 1, processadas: 1, ainda_falhando: 0, desistidas: 0 });

    const r2 = await reprocessarEntradasAceitas(admin as never, new Date(dezMinDepois.getTime() + 60_000));
    expect(r2.lidas, "a rodada seguinte releu a linha já processada").toBe(0);

    expect(ingestao.chamadas).toBe(1);
    expect(ingestao.retomadas, "o cron não pediu a retomada dos efeitos").toEqual([true]);
    expect(ingestao.mensagens.size).toBe(1);
    expect(arquivo()[0]).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("a mensagem já tinha entrado (o after() morreu ao fechar a linha): o reprocessamento não duplica", async () => {
    const agora = new Date();
    ingestao.mensagens.add("org-1:wamid.SINTETICO");
    linhaAceita(agora, 10 * 60_000);

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r.processadas).toBe(1);
    expect(ingestao.mensagens.size, "a mensagem foi gravada duas vezes").toBe(1);
    expect(arquivo()[0]).toMatchObject({ status: "processed" });
  });

  it("linha recente não é tocada: o after() da própria requisição ainda pode estar rodando", async () => {
    const agora = new Date();
    linhaAceita(agora, ESPERA_DA_ENTRADA_MS - 60_000);

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r.lidas).toBe(0);
    expect(ingestao.chamadas).toBe(0);
    expect(arquivo()[0]).toMatchObject({ status: "received", attempts: 0 });
  });

  it("não toca linha não aceita, de outro canal nem já processada", async () => {
    const agora = new Date();
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000, { wamid: "w.velha-nao-aceita", valid_signature: null });
    linhaAceita(agora, 10 * 60_000, { wamid: "w.nao-aceita", valid_signature: null });
    linhaAceita(agora, 10 * 60_000, { wamid: "w.outro-canal", provider: "waha" });
    linhaAceita(agora, 10 * 60_000, { wamid: "w.processada", status: "processed" });

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r.lidas).toBe(0);
    expect(ingestao.chamadas).toBe(0);
    expect(arquivo().map((l) => l.attempts)).toEqual([0, 0, 0, 0]);
  });

  it("⭐ passou da janela sem terminar: não ingere, vira `dead` e abre o aviso", async () => {
    const agora = new Date();
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000, { attempts: 2 });

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r).toEqual({ lidas: 1, processadas: 0, ainda_falhando: 0, desistidas: 1 });
    expect(ingestao.chamadas, "responderia uma mensagem velha").toBe(0);
    expect(arquivo()[0]).toMatchObject({ status: "dead", attempts: 2 });
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({ title: MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU.titulo });
    expect(String(avisos()[0]!.body)).toContain("passou da janela");
  });

  it("⭐ passou da janela com a mensagem já no CRM (só o fechamento falhou): fecha, sem aviso falso", async () => {
    const agora = new Date();
    banco.tabelas.messages = [{ id: "m1", organization_id: "org-1", external_id: "wamid.SINTETICO" }];
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000);

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r).toMatchObject({ processadas: 1, desistidas: 0 });
    expect(arquivo()[0]).toMatchObject({ status: "processed", error_message: "vencida_com_a_mensagem_no_crm" });
    expect(avisos()).toHaveLength(0);
  });

  it("passou da janela e a mesma mensagem existe em OUTRA organização: continua perdida aqui", async () => {
    const agora = new Date();
    banco.tabelas.messages = [{ id: "m1", organization_id: "org-2", external_id: "wamid.SINTETICO" }];
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000);

    await reprocessarEntradasAceitas(admin as never, agora);

    expect(arquivo()[0]).toMatchObject({ status: "dead" });
    expect(avisos()).toHaveLength(1);
  });

  it("passou da janela sem corpo: não há como conferir, então avisa", async () => {
    const agora = new Date();
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000, { raw_body: null });

    await reprocessarEntradasAceitas(admin as never, agora);

    expect(arquivo()[0]).toMatchObject({ status: "dead" });
    expect(avisos()).toHaveLength(1);
  });

  it("a linha vencida não tira a vez da recente, e a rodada seguinte não a relê", async () => {
    const agora = new Date();
    linhaAceita(agora, JANELA_DA_ENTRADA_MS + 60_000, { wamid: "w.velha" });
    linhaAceita(agora, 10 * 60_000, { wamid: "w.recente" });

    const r1 = await reprocessarEntradasAceitas(admin as never, agora);
    expect(r1).toEqual({ lidas: 2, processadas: 1, ainda_falhando: 0, desistidas: 1 });
    expect(arquivo().map((l) => l.status)).toEqual(["dead", "processed"]);

    const r2 = await reprocessarEntradasAceitas(admin as never, agora);
    expect(r2.lidas).toBe(0);
    expect(avisos()).toHaveLength(1);
  });

  it("duas rodadas sobrepostas não processam a mesma linha com a mesma leitura", async () => {
    const agora = new Date();
    linhaAceita(agora, 10 * 60_000);
    ingestao.demoraMs = 50;

    const [a, b] = await Promise.all([
      reprocessarEntradasAceitas(admin as never, agora),
      reprocessarEntradasAceitas(admin as never, agora),
    ]);

    expect(a.processadas + b.processadas).toBe(1);
    expect(ingestao.chamadas).toBe(1);
  });

  it("falha que se repete: soma tentativas e, no teto, vira `dead` com UM aviso na Central", async () => {
    const agora = new Date();
    linhaAceita(agora, 10 * 60_000, { attempts: MAX_TENTATIVAS - 2 });
    ingestao.falhasRestantes = 99;

    const r1 = await reprocessarEntradasAceitas(admin as never, agora);
    expect(r1).toMatchObject({ ainda_falhando: 1, desistidas: 0 });
    expect(arquivo()[0]).toMatchObject({ status: "received", attempts: MAX_TENTATIVAS - 1 });
    expect(avisos()).toHaveLength(0);

    const r2 = await reprocessarEntradasAceitas(admin as never, agora);
    expect(r2).toMatchObject({ ainda_falhando: 0, desistidas: 1 });
    expect(arquivo()[0]).toMatchObject({ status: "dead", attempts: MAX_TENTATIVAS });
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({
      kind: "event_dead",
      severity: "critical",
      title: MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU.titulo,
    });
    expect(String(avisos()[0]!.body)).toMatch(/^Um cliente escreveu para o número oficial/);
    // O número oficial não tem celular: quem lê é mandado ao painel do provedor.
    expect(String(avisos()[0]!.body)).toContain("painel do provedor");
    expect(String(avisos()[0]!.body)).toContain("marque-o como resolvido");
    expect(String(avisos()[0]!.body)).toContain(`${MAX_TENTATIVAS} tentativas`);

    // Outra mensagem morre com o aviso aberto: não abre um segundo.
    linhaAceita(agora, 10 * 60_000, { wamid: "w.outra", attempts: MAX_TENTATIVAS - 1 });
    await reprocessarEntradasAceitas(admin as never, agora);
    expect(avisos()).toHaveLength(1);
  });

  it("canal arquivado depois do aceite: desiste sem ingerir e sem aviso", async () => {
    const agora = new Date();
    banco.tabelas.channel_sessions![0]!.archived_at = "2026-10-27T00:00:00.000Z";
    linhaAceita(agora, 10 * 60_000);

    const r = await reprocessarEntradasAceitas(admin as never, agora);

    expect(r.desistidas).toBe(1);
    expect(ingestao.chamadas).toBe(0);
    expect(arquivo()[0]).toMatchObject({ status: "dead" });
    expect(avisos()).toHaveLength(0);
  });

  it("a rota do cron roda esta metade e audita só a rodada que fez algo", async () => {
    // A linha precisa ser velha em relação ao relógio REAL: a rota usa `new Date()`.
    linhaAceita(new Date(), 10 * 60_000);
    const chamar = () => cronWebhookReplay(new Request("http://x/api/v1/cron/webhook-replay") as never);

    const r1 = await chamar();
    expect(r1.status).toBe(200);
    expect((await r1.json()).data.entradas_aceitas).toMatchObject({ lidas: 1, processadas: 1 });
    expect(ingestao.chamadas).toBe(1);
    expect(auditoria.linhas).toHaveLength(1);
    expect(auditoria.linhas[0]).toMatchObject({
      action: "webhook.replay_run",
      metadata: { entradas_aceitas: { processadas: 1 } },
    });

    // Nada mais a fazer: a rodada não audita.
    const r2 = await chamar();
    expect((await r2.json()).data.entradas_aceitas).toMatchObject({ lidas: 0 });
    expect(auditoria.linhas).toHaveLength(1);
  });

  it("a rodada para depois do prazo, e a linha que ficou é da rodada seguinte", async () => {
    const agora = new Date();
    linhaAceita(agora, 12 * 60_000, { wamid: "w.1" });
    linhaAceita(agora, 11 * 60_000, { wamid: "w.2" });
    let t = 0;
    // Cada leitura do relógio avança 15 s: a 1ª linha cabe, a 2ª já passou do prazo.
    const relogio = () => (t += 15_000);

    const r = await reprocessarEntradasAceitas(admin as never, agora, { relogio });

    expect(r.processadas).toBe(1);
    expect(arquivo().map((l) => l.status)).toEqual(["processed", "received"]);
  });
});

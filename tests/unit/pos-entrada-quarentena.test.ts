import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { acelerarFollowupDoInbound, drenarEventosDoInbound } from "@/lib/dev/kick-local-pipeline";

/**
 * A QUARENTENA NA PORTA DE ENTRADA (#4026, fatia 1).
 *
 * ─── O defeito que este arquivo mede ───────────────────────────────────────
 *
 * Hoje não existe como segurar uma mensagem recebida sem descartá-la. A
 * ingestão grava a linha e, em seguida, roda os efeitos que transformam aquela
 * mensagem em trabalho: nasce o card, a campanha avalia, o follow-up reage e o
 * agente é acordado. Uma mensagem marcada como suspeita percorria tudo isso
 * igual a qualquer outra — e a IA respondia ao golpe.
 *
 * O que a fatia entrega: a mensagem é gravada IGUAL (nada aqui toca `body`,
 * mídia ou id) e os efeitos automáticos param. É o mesmo lugar em que hoje se
 * pula o canal desativado e o contato pessoal — uma guarda, depois do opt-out.
 *
 * ─── Por que o opt-out continua rodando ────────────────────────────────────
 *
 * Pedido de saída é LGPD e não depende de a mensagem ser spam: quem manda
 * "PARAR" num golpe continua pedindo para não receber. Segurar o STOP junto
 * com a IA transformaria a quarentena num jeito de furar o bloqueio.
 *
 * ─── SABOTAGEM (o que este arquivo acusa) ──────────────────────────────────
 *
 * · tirar a guarda: o caso da mensagem marcada acusa (o card nasce e o
 *   `ai_agent.dispatch_requested` sai mesmo marcada);
 * · trocar o fail-open por fail-closed: o caso da leitura que falha acusa (sem
 *   despacho);
 * · rodar a guarda ANTES do opt-out: o caso do STOP acusa (o contato não é
 *   bloqueado).
 */

const garantirLeadDaConversa = vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never);
const encerraDemanda = vi.fn(async () => ({ lead: {}, jaEstava: false }) as never);

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: (...a: unknown[]) => encerraDemanda(...(a as [])),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...a: unknown[]) => garantirLeadDaConversa(...(a as [])),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/leads/origem-por-horario", () => ({ casarOrigemPorHorario: vi.fn(async () => {}) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

/** O que aconteceu, na ordem — é o que os casos inspecionam. */
let sequencia: string[] = [];
/** A linha de `messages` que a leitura de quarentena devolve. */
let quarentena: { quarantined_at: string | null; quarantine_reason: string | null } | null = null;
let quarentenaErro: { message: string } | null = null;
/** Os filtros da leitura de quarentena — provam organização e id da mensagem. */
let filtrosDaQuarentena: Array<[string, unknown]> = [];

const admin = {
  from(tabela: string) {
    return {
      update(_payload: Record<string, unknown>) {
        const cadeia: Record<string, unknown> = {
          eq() {
            return cadeia;
          },
          is() {
            return cadeia;
          },
          select() {
            return cadeia;
          },
          async maybeSingle() {
            return { data: null, error: null };
          },
          then(resolve: (v: unknown) => void) {
            sequencia.push(`update:${tabela}`);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return cadeia;
      },
      select(colunas: string) {
        const consulta: Record<string, unknown> = {
          eq(coluna: string, valor: unknown) {
            if (tabela === "messages" && colunas.includes("quarantined_at")) {
              filtrosDaQuarentena.push([coluna, valor]);
            }
            return consulta;
          },
          order() {
            return consulta;
          },
          limit() {
            return consulta;
          },
          async maybeSingle() {
            // A leitura de quarentena é a única que pede estas colunas; as
            // outras leituras de `messages` (primeira mensagem do contato)
            // continuam com a resposta de sempre.
            if (tabela === "messages" && colunas.includes("quarantined_at")) {
              sequencia.push("select:messages:quarentena");
              return { data: quarentena, error: quarentenaErro };
            }
            if (tabela === "messages") {
              return { data: { id: "msg-1" }, count: 1, error: null };
            }
            return { data: null, count: null, error: null };
          },
        };
        return consulta;
      },
    };
  },
  async rpc(_nome: string, args: Record<string, unknown>) {
    sequencia.push(`rpc:${args.p_event_type ?? "fn"}`);
    return { error: null };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "clique aqui e ganhe um prêmio",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

beforeEach(() => {
  sequencia = [];
  quarentena = null;
  quarentenaErro = null;
  filtrosDaQuarentena = [];
  garantirLeadDaConversa.mockClear();
  garantirLeadDaConversa.mockResolvedValue({ criado: true, leadId: "lead-1" } as never);
  encerraDemanda.mockClear();
  vi.mocked(acelerarFollowupDoInbound).mockClear();
  vi.mocked(drenarEventosDoInbound).mockClear();
});

describe("mensagem em quarentena", () => {
  beforeEach(() => {
    quarentena = { quarantined_at: "2026-11-05T12:00:00.000Z", quarantine_reason: "golpe" };
  });

  it("não acorda o agente, não abre demanda, não avalia campanha e não reage ao follow-up", async () => {
    await rodar();

    expect(sequencia).toContain("select:messages:quarentena");
    expect(sequencia, "o agente foi acordado para uma mensagem em quarentena").not.toContain(
      "rpc:ai_agent.dispatch_requested",
    );
    expect(garantirLeadDaConversa, "o card nasceu de uma mensagem em quarentena").not.toHaveBeenCalled();
    expect(sequencia, "a campanha foi avaliada").not.toContain("update:contacts");
    expect(vi.mocked(acelerarFollowupDoInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(drenarEventosDoInbound)).not.toHaveBeenCalled();
  });

  it("a mensagem NÃO é tocada: nenhuma escrita em `messages`", async () => {
    // Quarentena segura efeito, nunca descarta entrega. Se um dia alguém
    // "resolver" a quarentena apagando o corpo ou movendo a linha, este caso
    // acusa antes de o cliente perder a mensagem.
    await rodar();
    expect(sequencia.filter((s) => s === "update:messages")).toEqual([]);
  });

  it("a leitura pergunta pela mensagem DESTA organização e deste id", async () => {
    await rodar();

    expect(filtrosDaQuarentena).toContainEqual(["organization_id", "org-1"]);
    expect(filtrosDaQuarentena).toContainEqual(["id", "msg-1"]);
  });

  it("o STOP continua valendo em quarentena (LGPD não depende de ser spam)", async () => {
    await rodar({ texto: "quero PARAR de receber" });

    expect(sequencia, "a guarda rodou antes do opt-out e o bloqueio não foi gravado").toContain(
      "update:contacts",
    );
    expect(sequencia).not.toContain("rpc:ai_agent.dispatch_requested");
  });
});

describe("os lados opostos", () => {
  it("mensagem normal não entra em quarentena e o fluxo é o de sempre", async () => {
    quarentena = { quarantined_at: null, quarantine_reason: null };

    await rodar();

    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(sequencia).toContain("rpc:ai_agent.dispatch_requested");
    expect(vi.mocked(acelerarFollowupDoInbound)).toHaveBeenCalledTimes(1);
  });

  it("FALHA AO LER a marca não cala a conversa: o fluxo segue (fail-open)", async () => {
    // O pior desfecho de um timeout não pode ser "o cliente ficou sem
    // resposta". A mensagem já está gravada; o gate é filtro, não
    // disponibilidade.
    quarentenaErro = { message: "timeout" };

    await rodar();

    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(sequencia).toContain("rpc:ai_agent.dispatch_requested");
  });

  it("reentrega sem id de mensagem não consulta a marca e segue o fluxo", async () => {
    quarentena = { quarantined_at: "2026-11-05T12:00:00.000Z", quarantine_reason: "golpe" };

    await rodar({ messageId: null });

    expect(sequencia).not.toContain("select:messages:quarentena");
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
  });
});

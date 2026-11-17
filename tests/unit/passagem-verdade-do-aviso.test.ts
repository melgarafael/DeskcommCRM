/**
 * "O CLIENTE JÁ FOI AVISADO" PRECISA SER VERDADE.
 *
 * ## O defeito, medido no código
 *
 * `avisarLeadDoCrm` devolvia `{ avisado: true }` sempre que `sendMessageHandler`
 * não LANÇAVA — e ele quase nunca lança. Canal em modo de teste, canal
 * arquivado, contato sem telefone e recusa do transporte viram `status='failed'`
 * DENTRO da linha da mensagem, com `error_code`, e a chamada volta normal. Canal
 * fora do ar e instalação sem transporte viram `status='queued'`.
 *
 * O desfecho: a Central afirmava "O cliente JÁ FOI avisado de que uma pessoa vai
 * assumir" para alguém que não recebeu nada. O atendente abria a conversa
 * respondendo a uma pessoa que não sabia que ele vinha — e é a primeira frase
 * dele que muda com isso.
 *
 * Do lado do motor de conversa havia o irmão do mesmo defeito, com um argumento
 * escrito: `queued` era "custódia do CRM, logo avisado". O argumento serve a quem
 * opera a fila e não serve a quem vai atender.
 *
 * ## O que este arquivo mede
 *
 * A TRADUÇÃO do desfecho, nos dois emissores. O texto do aviso tem arquivo
 * próprio (`tests/unit/aviso-ao-lead.test.ts`); misturá-los faria este reprovar
 * por mudança de redação.
 */
import { describe, expect, it, vi } from "vitest";

const enviar = vi.fn();

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviar(...args),
}));
vi.mock("@/lib/escalacao/atendentes", () => ({
  carregarRosterDeAtendimento: vi.fn(async () => []),
  podeAssumirAgora: vi.fn(() => false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

/**
 * O cliente de banco que as GUARDAS de `avisarLeadDoCrm` consultam antes de
 * escrever: "a IA já falou nesta conversa?" e "já houve aviso nas últimas
 * 24 h?" (`tests/unit/aviso-so-quando-a-ia-falou.test.ts`). Com `{} as never` a
 * pergunta lançaria `TypeError`, o catch devolveria `{avisado:false,
 * porque:"TypeError"}`, e os casos abaixo — que são sobre o DESFECHO do envio,
 * não sobre a guarda — reprovariam pelo motivo errado.
 *
 * O dublê responde "a IA já falou" (uma linha de saída da IA que não é aviso),
 * que é a precondição destes casos: eles medem o que o desfecho vira DEPOIS de
 * a guarda deixar passar.
 */
function bancoComFalaDaIa() {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) cadeia[m] = () => cadeia;
  cadeia.limit = () =>
    Promise.resolve({ data: [{ metadata: null, created_at: new Date().toISOString() }], error: null });
  // Guarda 3 (#4797): o cliente precisa estar esperando resposta. Uma entrada
  // mais nova que a última saída — a precondição destes casos, que medem o que
  // acontece DEPOIS de o emissor decidir falar.
  cadeia.maybeSingle = async () => ({
    data: {
      last_inbound_at: new Date().toISOString(),
      last_outbound_at: new Date(Date.now() - 60_000).toISOString(),
      channel_session_id: null,
    },
    error: null,
  });
  return { from: () => cadeia } as never;
}

function avisa() {
  return avisarLeadDoCrm(bancoComFalaDaIa(), {
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: CONTATO,
    reason: "low_sentiment",
  });
}

describe("o desfecho do aviso sai do STATUS da mensagem, não da ausência de exceção", () => {
  it("`sent` é a única coisa que autoriza dizer que o cliente foi avisado", async () => {
    enviar.mockResolvedValueOnce({ status: "sent", error_code: null });
    expect(await avisa()).toEqual({ avisado: true });
  });

  it("`queued` NÃO é avisado — o canal está fora do ar e ele pode nunca receber", async () => {
    enviar.mockResolvedValueOnce({ status: "queued", error_code: null });
    expect(await avisa()).toEqual({
      avisado: false,
      porque: "na_fila_canal_fora",
      motivoCodigo: "na_fila_canal_fora",
    });
  });

  it("`failed` SEM lançar não pode virar `avisado: true` — era o defeito inteiro", async () => {
    // `sendMessageHandler` devolve normalmente e grava a falha na linha. Quem
    // lesse só a ausência de exceção concluiria entrega.
    enviar.mockResolvedValueOnce({ status: "failed", error_code: "waha_send_failed" });
    const desfecho = await avisa();
    expect(desfecho.avisado).toBe(false);
    expect(desfecho).toMatchObject({ motivoCodigo: "falhou_no_envio" });
  });

  it("o `error_code` vira o motivo FECHADO que a tela sabe traduzir", async () => {
    for (const [codigo, esperado] of [
      ["pre_go_live", "pre_go_live"],
      ["pre_go_live_indisponivel", "pre_go_live"],
      ["channel_archived", "canal_arquivado"],
      ["missing_phone_number", "sem_telefone"],
    ] as const) {
      enviar.mockResolvedValueOnce({ status: "failed", error_code: codigo });
      expect(await avisa(), `error_code ${codigo}`).toMatchObject({
        avisado: false,
        motivoCodigo: esperado,
      });
    }
  });

  it("código desconhecido não inventa motivo — cai no genérico, nunca em `avisado`", async () => {
    enviar.mockResolvedValueOnce({ status: "failed", error_code: "codigo_que_ninguem_viu" });
    const desfecho = await avisa();
    expect(desfecho.avisado).toBe(false);
    expect(desfecho).toMatchObject({ motivoCodigo: "falhou_no_envio" });
  });

  it("exceção de verdade continua sendo tratada — e sem motivo inventado", async () => {
    enviar.mockRejectedValueOnce(new TypeError("canal fora"));
    const desfecho = await avisa();
    expect(desfecho.avisado).toBe(false);
    expect(desfecho).not.toHaveProperty("motivoCodigo");
  });
});

describe("o motor de conversa traduz o MESMO desfecho", () => {
  /**
   * COMPORTAMENTO, não texto. Uma sonda que procurasse a linha do conserto no
   * arquivo ficaria verde com um COMENTÁRIO que a citasse — a lição já paga
   * neste épico. Aqui a cadeia de envio é dublada e o que se mede é o que a
   * função DEVOLVE.
   */
  async function desfechoDaCadeia(chain: unknown) {
    vi.resetModules();
    vi.doMock("@/lib/agent-engine/guardrails/before-send", () => ({
      runBeforeSend: vi.fn(async () => chain),
    }));
    vi.doMock("@/lib/escalacao/disponibilidade", () => ({
      expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
    }));
    const { avisarLeadDaEscalacao } = await import(
      "@/lib/agent-engine/agent/aviso-de-escalacao"
    );
    return avisarLeadDaEscalacao({} as never, {
      tenantId: ORG,
      leadId: CONTATO,
      conversationId: CONVERSA,
      channelSessionId: CONVERSA,
      jobId: "job-1",
    }, {
      motivo: "pediu_humano",
      channel: { send: vi.fn() } as never,
      optedOutThisTurn: false,
      now: new Date("2026-09-18T12:00:00Z"),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
  }

  it("`queued` do canal NÃO é entrega — era o irmão do mesmo defeito", async () => {
    const d = await desfechoDaCadeia({
      status: "ok",
      outcome: { kind: "queued", idempotencyKey: "k", messageId: null },
    });
    expect(d.avisado).toBe(false);
    expect(d).toMatchObject({ motivoCodigo: "na_fila_canal_fora" });
  });

  it("`sent` continua sendo entrega", async () => {
    const d = await desfechoDaCadeia({
      status: "ok",
      outcome: { kind: "sent", idempotencyKey: "k", messageId: "m" },
    });
    expect(d).toEqual({ avisado: true });
  });

  it("janela fechada vira o motivo fechado que a tela traduz", async () => {
    const d = await desfechoDaCadeia({ status: "vetoed", code: "messaging_window_closed" });
    expect(d).toMatchObject({ avisado: false, motivoCodigo: "fora_da_janela" });
  });

  it("veto sem par no vocabulário NÃO inventa motivo", async () => {
    // `lgpd_anonymized` não tem código próprio. Dizer a quem atende uma razão
    // que ninguém mediu é pior que dizer "motivo desconhecido".
    const d = await desfechoDaCadeia({ status: "vetoed", code: "lgpd_anonymized" });
    expect(d.avisado).toBe(false);
    expect(d).not.toHaveProperty("motivoCodigo");
  });
});

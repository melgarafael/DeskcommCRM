/**
 * O AVISO DE "A IA SAIU DE CAMPO" SÓ FAZ SENTIDO SE A IA ESTEVE EM CAMPO.
 *
 * ─── O incidente, medido numa instalação real ────────────────────────────────
 *
 * Organização SEM agente publicado. O worker de sentimento — que roda para TODA
 * mensagem, com ou sem agente — disparou `triggerHandoff('low_sentiment')` sobre
 * a conversa de um cliente que mandava uma piada. `avisarLeadDoCrm` enviou "Esse
 * caso é melhor resolvido por uma pessoa. Já acionei o time." a um cliente que
 * NUNCA tinha falado com IA nenhuma.
 *
 * E enviou QUATRO vezes em cinco minutos ao mesmo cliente: o envio travou (canal
 * fora do ar), o disparo foi refeito, e cada nova tentativa virou mensagem nova.
 * Total: 5 mensagens fantasma para 2 clientes.
 *
 * As duas guardas medidas aqui são a causa raiz, não o sintoma:
 *  - sem fala prévia da IA na conversa, não há retirada a anunciar;
 *  - um aviso por conversa por janela de 24 h, contado no BANCO (o `requestId`
 *    não segura, porque cada disparo de passagem é uma chamada nova).
 *
 * O ENVIO é dublado e contado: o que se mede é se a frase SAIU, não só o
 * `porque` devolvido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
/**
 * A janela de horário (#4797) mora fora deste arquivo: aqui ela está ABERTA,
 * para que os casos de 2026-09-27 continuem medindo o que mediam. Quem mede a
 * janela fechada é `aviso-so-com-mensagem-nova.test.ts`.
 */
vi.mock("@/lib/automation/janela-do-canal", () => ({
  adiarAteAJanelaAbrir: vi.fn(async () => null),
}));

import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

type Fala = { metadata: Record<string, unknown> | null; created_at: string; status: string };

/** Os filtros que a leitura das falas aplicou, na ordem: `[coluna, valor]`. */
let filtros: [string, unknown][] = [];

/**
 * Cliente supabase-js de mentira. `messages` devolve as falas dadas (ou o erro);
 * `organizations` devolve o idioma — o resto do caminho é o de sempre.
 *
 * A guarda 3 (#4797) pergunta ao BANCO se o cliente está esperando resposta:
 * `conversations.last_outbound_at` + entrada mais nova que ela. Por isso a
 * conversa de mentira tem uma SAÍDA de 3 h atrás e uma ENTRADA de 2 h atrás — o
 * cliente falou e ninguém respondeu, que é o único caso em que esta frase faz
 * sentido. `entrada: false` é a conversa já respondida.
 */
function banco(falas: Fala[] | { erro: string }, opcoes: { entrada?: boolean } = {}) {
  filtros = [];
  const entrada = opcoes.entrada ?? true;
  return {
    from(tabela: string) {
      if (tabela === "messages") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return cadeia;
          },
          gt: () => cadeia,
          order: () => cadeia,
          // Duas leituras caem aqui: as falas da IA (`limit(20)`) e a entrada
          // sem resposta (`limit(1)`, só `direction=inbound`).
          limit: async (n: number) => {
            if (!Array.isArray(falas)) return { data: null, error: { message: falas.erro } };
            const pediuEntrada = filtros.some(([c, v]) => c === "direction" && v === "inbound");
            if (pediuEntrada) {
              return { data: entrada ? [{ created_at: horasAtras(2) }] : [], error: null };
            }
            return { data: falas.slice(0, n), error: null };
          },
        };
        return cadeia;
      }
      if (tabela === "conversations") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () => ({
            data: { last_outbound_at: horasAtras(3), channel_session_id: null },
            error: null,
          }),
        };
        return cadeia;
      }
      if (tabela === "organizations") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () => ({ data: { locale: "pt-BR" }, error: null }),
        };
        return cadeia;
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  } as never;
}

const ENTRADA = {
  organizationId: ORG,
  conversationId: CONVERSA,
  contactId: "22222222-2222-4222-8222-222222222222",
  reason: "low_sentiment",
};

const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const falaDaIa = (created_at: string): Fala => ({ metadata: null, created_at, status: "sent" });
const aviso = (created_at: string, status = "sent"): Fala => ({
  metadata: { aviso_de_escalacao: true, handoff_reason: "low_sentiment" },
  created_at,
  status,
});

beforeEach(() => {
  enviar.mockReset();
  enviar.mockResolvedValue({ status: "sent", error_code: null });
});

describe("guarda 1 — a IA precisa ter falado nesta conversa", () => {
  it("IA que nunca falou na conversa não tem retirada a anunciar: nada sai", async () => {
    const r = await avisarLeadDoCrm(banco([]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso anterior NÃO conta como fala da IA — senão o primeiro aviso indevido legitimaria o segundo", async () => {
    // O caso da repetição: a ÚNICA linha `sent_via='ai'` é o próprio aviso do
    // disparo anterior, e ele é velho o bastante para a guarda 2 não barrar.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(30))]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("a IA falou e não há aviso: a frase sai, uma vez", async () => {
    const r = await avisarLeadDoCrm(banco([falaDaIa(agora())]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("agente externo via MCP (falas gravadas como 'system'): a frase sai, uma vez", async () => {
    // Chave emitida pela tela não tem `actor:ai_agent`: as falas do agente
    // externo são `sent_via='system'` e a leitura não as vê. O contrato do
    // `crm_request_human_handoff` manda o agente NÃO avisar — o aviso é daqui.
    const r = await avisarLeadDoCrm(banco([]), { ...ENTRADA, origem: "mcp_externo" });
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("a exceção é SÓ do MCP externo: sentimento sem fala da IA continua calado", async () => {
    const r = await avisarLeadDoCrm(banco([]), { ...ENTRADA, origem: "sentimento" });
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("guarda 2 — um aviso por conversa a cada 24 h", () => {
  it("aviso recente ENTREGUE: não repete, e o desfecho diz que o cliente foi avisado", async () => {
    // Sem isto a Central escreveria "O cliente NÃO foi avisado (motivo
    // desconhecido)" para quem recebeu o aviso há uma hora.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1)), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso recente NA FILA (canal fora): não repete, e o desfecho diz que está na fila", async () => {
    // `queued` é o que o session-reconciler reenvia — foi esse o mecanismo das
    // quatro repetições do incidente.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1), "queued"), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({
      avisado: false,
      porque: "aviso_ja_enviado_na_janela",
      motivoCodigo: "na_fila_canal_fora",
    });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso recente que FALHOU não conta: o cliente nunca o recebeu, a frase sai", async () => {
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1), "failed"), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("aviso VELHO (25 h) não bloqueia o novo — a passagem honesta de amanhã avisa", async () => {
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(25)), falaDaIa(horasAtras(26))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});

describe("a leitura das falas", () => {
  it("filtra pela organização E pela conversa — o cliente é service role, sem RLS", async () => {
    await avisarLeadDoCrm(banco([falaDaIa(agora())]), ENTRADA);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["conversation_id", CONVERSA],
        ["direction", "outbound"],
        ["sent_via", "ai"],
      ]),
    );
  });

  it("leitura que falha não avisa (fail-closed) e diz por quê", async () => {
    const r = await avisarLeadDoCrm(banco({ erro: "PostgREST fora" }), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "falas_da_ia_nao_lidas" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

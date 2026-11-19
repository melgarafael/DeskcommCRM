/**
 * O AVISO DE PASSAGEM RESPONDE A UMA MENSAGEM DO CLIENTE — E RESPEITA A HORA.
 *
 * ─── O incidente, medido em produção (#4797) ────────────────────────────────
 *
 * WhatsApp (WAHA), organização real. As datas são BRT e são a linha do tempo da
 * conversa:
 *
 *   13/11 15:23  última mensagem do CLIENTE (áudio)
 *   13/11 15:24  resposta do agente (`sent_via='ai'`)
 *   14/11 16:42  mensagem MANUAL do atendente
 *   16/11 22:19  sai para o cliente "Deixei isso com uma pessoa da equipe, que
 *                continua daqui. Agora não tem ninguém livre; deixei sua
 *                solicitação anotada para o time." — `sent_via: ai`,
 *                `ai_actor_id: handoff-orchestrator`, `handoff_reason:
 *                low_confidence`, `aviso_de_escalacao: true`, `delivered`
 *   16/11 22:26  o atendente APAGA a mensagem no WhatsApp
 *
 * Nenhuma mensagem do cliente em 16/11. As duas guardas que existiam desde
 * 2026-09-27 não tinham o que dizer: a IA JÁ tinha falado (13/11), e a última
 * passagem tinha mais de 24 h. Faltava a pergunta óbvia — "alguém está esperando
 * resposta?" — e a outra, que o autor cobrou explicitamente: 22h, três dias
 * depois, soa como robô perdido.
 *
 * ─── O que se mede aqui ─────────────────────────────────────────────────────
 *
 * O ENVIO é dublado e CONTADO (`enviar`). O que se prova é se a frase saiu para
 * o canal, não só o `porque` devolvido — um `porque` bonito com a mensagem no ar
 * é exatamente o defeito.
 *
 *   (a) sem mensagem nova do cliente → ZERO chamada de envio;
 *   (b) cliente esperando + `low_confidence` → a frase sai, uma vez;
 *   (c) segunda passagem na mesma conversa → não repete o aviso já registrado;
 *   (d) aviso legítimo fora de turno, com a janela fechada → não sai;
 *   (e) passagem interna (caso/Central) continua acontecendo — em
 *       `aviso-nao-impede-a-passagem-interna.test.ts`.
 *   (f) o caso `b934ba2d`: a passagem LOGO DEPOIS de uma fala do automático
 *       continua avisando — venha do sentimento ou do MCP.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *
 * - Devolver o envio sem a guarda 3 (trocar `if (!conversa.esperando) {` por
 *   `if (false) {`) → (a) acusa: a frase volta a sair para quem já foi
 *   respondido por uma pessoa.
 * - Fazer o conserto silenciar TAMBÉM o aviso legítimo (trocar
 *   `if (!conversa.esperando)` por `if (true)`) → (b) acusa.
 * - Contar a fala do AUTOMÁTICO como resposta (tirar `direction`/`sent_via` da
 *   leitura que acha a última resposta humana, isto é, deixar a guarda
 *   comparar só as duas colunas da conversa) → (f) acusa: o `b934ba2d` volta.
 * - Remover a guarda de repetição (guarda 2, `avisosRecentes`) → (c) acusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enviar = vi.fn();
const janela = vi.fn(async () => null as string | null);

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
/** A janela é a MESMA do canal/automação (`channel_knobs`, fuso da org) — aqui dublada. */
vi.mock("@/lib/automation/janela-do-canal", () => ({
  adiarAteAJanelaAbrir: (...args: unknown[]) => janela(...(args as [])),
}));

import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "55555555-5555-4555-8555-555555555555";

/** Uma linha de `messages` — só as FALAS da IA importam aqui (guarda 1). */
type Mensagem = {
  direction: "inbound" | "outbound";
  created_at: string;
  status?: string;
  sent_via?: string | null;
  metadata?: Record<string, unknown> | null;
};

type Cenario = {
  /** As mensagens da conversa; as duas leituras de `messages` filtram por elas. */
  mensagens: Mensagem[];
  /** `conversations.last_inbound_at` — a última mensagem do CLIENTE. */
  lastInboundAt: string | null;
  /** `conversations.last_outbound_at` — a última SAÍDA (IA, atendente ou aviso). */
  lastOutboundAt: string | null;
  /** `conversations.channel_session_id`. */
  canal?: string | null;
  /** Faz a leitura da CONVERSA estourar — o fail-closed da guarda 3. */
  erroNaConversa?: boolean;
};

/**
 * Cliente supabase-js de mentira que RESPONDE ÀS PERGUNTAS.
 *
 * A guarda 1 lê `messages` (falas da IA); as guardas 3 e 4 leem a linha da
 * conversa. Filtrar de verdade em `messages` e devolver `last_inbound_at` /
 * `last_outbound_at` distintos é o que distingue "o cliente está esperando" de
 * "a última coisa na conversa é a nossa": um dublê que respondesse a mesma
 * coisa para as duas perguntas faria os casos medirem a si mesmos.
 */
function banco(c: Cenario) {
  return {
    from(tabela: string) {
      if (tabela === "messages") {
        const filtros: Array<[string, string, unknown]> = [];
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            filtros.push(["eq", coluna, valor]);
            return cadeia;
          },
          /** `sent_via in (...)`: é assim que a guarda 3 pergunta se uma PESSOA respondeu. */
          in: (coluna: string, valores: unknown[]) => {
            filtros.push(["in", coluna, valores]);
            return cadeia;
          },
          gt: (coluna: string, valor: unknown) => {
            filtros.push(["gt", coluna, valor]);
            return cadeia;
          },
          order: () => cadeia,
          limit: async (n: number) => {
            let linhas = [...c.mensagens];
            for (const [op, coluna, valor] of filtros) {
              // `organization_id`/`conversation_id` são o escopo do cliente de
              // serviço: todas as linhas deste dublê já são dessa conversa.
              if (coluna === "organization_id" || coluna === "conversation_id") continue;
              linhas = linhas.filter((m) => {
                const v = (m as unknown as Record<string, unknown>)[coluna];
                if (op === "in") return (valor as unknown[]).includes(v ?? null);
                return op === "eq" ? v === valor : new Date(String(v)) > new Date(String(valor));
              });
            }
            linhas.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
            return {
              data: linhas.slice(0, n).map((m) => ({
                direction: m.direction,
                created_at: m.created_at,
                status: m.status ?? "sent",
                sent_via: m.sent_via ?? null,
                metadata: m.metadata ?? null,
              })),
              error: null,
            };
          },
        };
        return cadeia;
      }
      if (tabela === "conversations") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () =>
            c.erroNaConversa
              ? { data: null, error: { message: "PostgREST fora" } }
              : {
                  data: {
                    last_inbound_at: c.lastInboundAt,
                    last_outbound_at: c.lastOutboundAt,
                    channel_session_id: c.canal === undefined ? CANAL : c.canal,
                  },
                  error: null,
                },
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
  reason: "low_confidence" as const,
  // O caminho AUTOMÁTICO — é ele que o #4797 mede. (A passagem decidida por uma
  // pessoa na Central vai com `origem: "caso_escalado"` e é tratada em (d).)
  origem: "legado_confianca" as const,
};

const horasAtras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const minutosAtras = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
const diasAtras = (d: number) => horasAtras(d * 24);

const falaDaIa = (created_at: string): Mensagem => ({
  direction: "outbound",
  sent_via: "ai",
  created_at,
  status: "sent",
  metadata: null,
});
/** O cliente falando. `direction: "inbound"` da linha de `messages`. */
const falaDoCliente = (created_at: string): Mensagem => ({
  direction: "inbound",
  created_at,
  status: "delivered",
  metadata: null,
});
/**
 * A resposta de uma PESSOA — Inbox do CRM (`user`/`crm`) ou o aparelho
 * conectado (`external_device`). É o vocabulário que o resto do produto usa
 * para separar gente de máquina (`fn_mensagem_do_vendedor_e_atividade`).
 */
const falaHumana = (created_at: string, sent_via = "user"): Mensagem => ({
  direction: "outbound",
  sent_via,
  created_at,
  status: "sent",
  metadata: null,
});
const avisoAnterior = (created_at: string, status = "sent"): Mensagem => ({
  direction: "outbound",
  sent_via: "ai",
  created_at,
  status,
  metadata: { aviso_de_escalacao: true, handoff_reason: "low_confidence" },
});

beforeEach(() => {
  enviar.mockReset();
  enviar.mockResolvedValue({ status: "sent", error_code: null });
  janela.mockReset();
  janela.mockResolvedValue(null);
});

describe("(a) passagem sem mensagem nova do cliente não toca o canal", () => {
  it("conversa já respondida — o caso de 16/11 22:19: ZERO chamada de envio", async () => {
    // A linha do tempo do incidente, nos dois relógios que a guarda consulta:
    // a última SAÍDA é a mensagem manual do atendente (14/11 16:42), DEPOIS da
    // última entrada do cliente (13/11 15:23). Ninguém espera resposta.
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDaIa(diasAtras(3.3)), falaHumana(diasAtras(2.2))],
        lastInboundAt: diasAtras(3.35),
        lastOutboundAt: diasAtras(2.2),
      }),
      ENTRADA,
    );

    expect(r).toEqual({ avisado: false, porque: "sem_mensagem_nova_do_cliente" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("entrada e saída no MESMO instante são empate, não espera: não avisa", async () => {
    const instante = horasAtras(1);
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDaIa(horasAtras(2)), falaHumana(instante)],
        lastInboundAt: instante,
        lastOutboundAt: instante,
      }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: false, porque: "sem_mensagem_nova_do_cliente" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("falha de leitura da conversa não vira 'pode mandar' (fail-closed), e o motivo nomeia a leitura", async () => {
    const r = await avisarLeadDoCrm(
      banco({ mensagens: [falaDaIa(horasAtras(2))], lastInboundAt: null, lastOutboundAt: null, erroNaConversa: true }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: false, porque: "espera_do_cliente_nao_lida" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("(b) mensagem do cliente + low_confidence continua avisando", () => {
  it("cliente falou e ninguém respondeu: a frase sai, uma vez", async () => {
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDaIa(horasAtras(4))],
        lastInboundAt: horasAtras(0.2),
        lastOutboundAt: horasAtras(4),
      }),
      ENTRADA,
    );

    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
    const [, , corpo] = enviar.mock.calls[0] as [unknown, unknown, { metadata: Record<string, unknown> }];
    expect(corpo.metadata).toMatchObject({ aviso_de_escalacao: true, handoff_reason: "low_confidence" });
  });

  it("conversa nunca respondida (sem saída) também é espera: a frase sai", async () => {
    const r = await avisarLeadDoCrm(
      banco({ mensagens: [falaDaIa(horasAtras(4))], lastInboundAt: horasAtras(0.3), lastOutboundAt: null }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("o aviso em si não cria a 'espera' que legitima o próximo: só o cliente cria", async () => {
    // O aviso anterior é a última SAÍDA. Sem entrada nova, a segunda passagem
    // não tem a quem responder — e isso vale mesmo passadas as 24 h da guarda 2.
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [avisoAnterior(horasAtras(30)), falaDaIa(horasAtras(40))],
        lastInboundAt: horasAtras(40),
        lastOutboundAt: horasAtras(30),
      }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: false, porque: "sem_mensagem_nova_do_cliente" });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("(c) a segunda passagem não repete o aviso já registrado", () => {
  it("aviso entregue há 1 h + cliente escrevendo de novo: não sai outro", async () => {
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [avisoAnterior(horasAtras(1)), falaDaIa(horasAtras(2))],
        lastInboundAt: horasAtras(0.1),
        lastOutboundAt: horasAtras(0.05),
      }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: true });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso na fila (canal fora) também não vira um segundo aviso", async () => {
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [avisoAnterior(horasAtras(1), "queued"), falaDaIa(horasAtras(2))],
        lastInboundAt: horasAtras(0.1),
        lastOutboundAt: horasAtras(0.05),
      }),
      ENTRADA,
    );
    expect(r).toEqual({
      avisado: false,
      porque: "aviso_ja_enviado_na_janela",
      motivoCodigo: "na_fila_canal_fora",
    });
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe("(d) fora de turno, a janela de horário da organização manda", () => {
  it("agente externo (MCP) fora da janela: a passagem acontece, o cliente não recebe nada", async () => {
    // `mcp_externo` é o caminho legítimo que avisa sem espera (o contrato manda
    // o agente externo NÃO avisar). É justamente ele que precisa da hora.
    janela.mockResolvedValue(new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString());
    const r = await avisarLeadDoCrm(
      banco({ mensagens: [falaDaIa(horasAtras(2))], lastInboundAt: horasAtras(3), lastOutboundAt: horasAtras(2) }),
      { ...ENTRADA, origem: "mcp_externo" },
    );

    expect(r).toEqual({
      avisado: false,
      porque: "fora_da_janela_de_envio",
      motivoCodigo: "fora_da_janela",
    });
    expect(enviar).not.toHaveBeenCalled();
    expect(janela).toHaveBeenCalledTimes(1);
    // O canal consultado é o DA CONVERSA — não o primeiro da organização.
    expect((janela.mock.calls[0] as unknown[])[2]).toBe(CANAL);
  });

  it("dentro da janela, o mesmo caminho avisa normalmente", async () => {
    const r = await avisarLeadDoCrm(
      banco({ mensagens: [falaDaIa(horasAtras(2))], lastInboundAt: horasAtras(3), lastOutboundAt: horasAtras(2) }),
      { ...ENTRADA, origem: "mcp_externo" },
    );
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("a janela não é consultada para quem está EM turno: cliente esperando às 22h recebe o aviso", async () => {
    const r = await avisarLeadDoCrm(
      banco({ mensagens: [falaDaIa(horasAtras(1))], lastInboundAt: horasAtras(0.2), lastOutboundAt: null }),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: true });
    expect(janela).not.toHaveBeenCalled();
  });
});

/**
 * (f) O CASO `b934ba2d` — o incidente que criou o Step 0.
 *
 * Produção, 26/08. O cliente disse que não conseguia acessar um curso; o agente
 * respondeu e PERGUNTOU o e-mail dele — o envio do agente moveu
 * `conversations.last_outbound_at`. Entre a pergunta e a resposta, o worker de
 * sentimento disparou `triggerHandoff('low_sentiment')`. A guarda 3, escrita
 * como "a última entrada é mais nova que a última saída?", viu a SAÍDA mais nova
 * e não avisou: a conversa ficou silenciada (`bot_silenced_until = 'infinity'`)
 * e o cliente respondeu o e-mail para o vazio.
 *
 * A régua certa é a do próprio Step 0 — "a pessoa falou e NINGUÉM respondeu":
 * o que fecha a espera é uma PESSOA ter respondido, não o automático que está
 * justamente saindo de campo. Os dois lados do mesmo critério estão aqui:
 * a passagem logo depois da fala do automático avisa (do sentimento ou do MCP),
 * e a conversa parada e já respondida por gente não avisa, venha de onde vier.
 */
describe("(f) a passagem logo depois da fala do automático continua avisando", () => {
  it("o agente perguntou o e-mail e o envio dele moveu last_outbound_at: a frase SAI (sentimento)", async () => {
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDoCliente(minutosAtras(3)), falaDaIa(minutosAtras(1))],
        // O relógio da conversa no instante da passagem: a saída (a pergunta da
        // IA) é mais nova que a entrada. É exatamente o que a guarda antiga lia
        // como "ninguém está esperando".
        lastInboundAt: minutosAtras(3),
        lastOutboundAt: minutosAtras(1),
      }),
      { ...ENTRADA, reason: "low_sentiment", origem: "sentimento" },
    );

    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
    // A frase que sai é a de passagem — não o silêncio, e não a de opt-out.
    const [, , corpo] = enviar.mock.calls[0] as [unknown, unknown, { body: string }];
    expect(corpo.body).toMatch(/pessoa|equipe|atendente/i);
  });

  it("o mesmo instante pelo MCP externo também avisa — a automação saiu no meio da fala dela", async () => {
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDoCliente(minutosAtras(4)), falaDaIa(minutosAtras(2))],
        lastInboundAt: minutosAtras(4),
        lastOutboundAt: minutosAtras(2),
      }),
      { ...ENTRADA, origem: "mcp_externo" },
    );

    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("MCP numa conversa parada há dias e já respondida por uma pessoa: NÃO avisa", async () => {
    // O caso 2 medido pelo mantenedor: às 15h, com a janela do canal ABERTA, o
    // aviso sairia para um cliente calado há 3 dias e já respondido. A hora não
    // segura nada aqui — quem segura é a guarda da espera, que agora vale para
    // TODA origem (o `mcp_externo` não é mais isento dela).
    const r = await avisarLeadDoCrm(
      banco({
        mensagens: [falaDaIa(diasAtras(3.3)), falaHumana(diasAtras(2.2), "external_device")],
        lastInboundAt: diasAtras(3.35),
        lastOutboundAt: diasAtras(2.2),
      }),
      { ...ENTRADA, origem: "mcp_externo" },
    );

    expect(r).toEqual({ avisado: false, porque: "sem_mensagem_nova_do_cliente" });
    expect(enviar).not.toHaveBeenCalled();
    // A janela nem chega a ser consultada: a guarda 3 vem antes, e é ela que
    // decide — não a hora do dia.
    expect(janela).not.toHaveBeenCalled();
  });
});

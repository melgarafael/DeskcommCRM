/**
 * QUEM COMEÇA A RESPOSTA COM "PARAR" NÃO RECEBE "PASSEI SEU PEDIDO PARA UM ATENDENTE".
 *
 * ─── O caso, medido em produção (30/09/2026) ────────────────────────────────
 *
 * Um lead respondeu à abordagem com "Parar não é daqui". O detector de bloqueio
 * exige a palavra SOZINHA (ou uma frase inteira de descadastro), então o contato
 * não foi bloqueado; o worker de sentimento escalou como `low_sentiment`; e o
 * aviso genérico saiu, dez segundos depois:
 *
 *   "Prefiro não arriscar aqui: passei seu pedido para um atendente humano.
 *    Fica por aqui que já te respondem."
 *
 * Para quem acabou de dizer que não quer mais mensagens, isso promete atendimento
 * — o contrário do que ele pediu. O produto já tem a frase certa para essa
 * situação (`suspeita_de_opt_out`: "Entendi. Vou parar de te enviar mensagens
 * automáticas por aqui." + "Encaminhei seu pedido para uma pessoa da equipe
 * confirmar."); faltava escolhê-la quando o motivo gravado é o genérico.
 *
 * O ENVIO é dublado: o que se mede é a FRASE que saiu.
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

import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";
import { textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "22222222-2222-4222-8222-222222222222";

/** Ninguém configurado, como no cliente que `quemPodeAssumir` devolve com roster vazio. */
const SEM_EQUIPE = { total: 0, disponiveis: 0 };

let ultimaDoCliente: string | null = null;
let leituraDoClienteFalha = false;
/** Os filtros da leitura da ÚLTIMA MENSAGEM DO CLIENTE (a nova), na ordem. */
let filtrosDaUltima: Array<[string, unknown]> = [];

/**
 * Cliente supabase-js de mentira. `messages` responde as DUAS leituras: as falas
 * da IA (guarda 1 — a IA precisa ter falado) e a última mensagem do cliente.
 */
function banco() {
  return {
    from(tabela: string) {
      if (tabela === "messages") {
        let direcao = "";
        // Cada consulta guarda os PRÓPRIOS filtros: a das falas da IA e a da última
        // mensagem do cliente não se misturam.
        const filtros: Array<[string, unknown]> = [];
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            if (coluna === "direction") direcao = String(valor);
            return cadeia;
          },
          order: () => cadeia,
          limit: () =>
            Object.assign(
              // leitura das falas da IA: aguardada direto
              Promise.resolve({
                data:
                  direcao === "outbound"
                    ? [{ metadata: null, created_at: new Date().toISOString(), status: "sent" }]
                    : null,
                error: null,
              }),
              {
                // leitura da última mensagem do cliente: `.maybeSingle()`
                maybeSingle: async () => {
                  filtrosDaUltima = [...filtros];
                  if (leituraDoClienteFalha) throw new Error("PostgREST fora");
                  return {
                    data: ultimaDoCliente === null ? null : { body: ultimaDoCliente },
                    error: null,
                  };
                },
              },
            ),
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
  contactId: CONTATO,
  reason: "low_sentiment",
};

function corpoEnviado(): string {
  expect(enviar).toHaveBeenCalledTimes(1);
  return (enviar.mock.calls[0] as unknown as [unknown, unknown, { body: string }])[2].body;
}

beforeEach(() => {
  enviar.mockReset();
  enviar.mockResolvedValue({ status: "sent", error_code: null });
  ultimaDoCliente = null;
  leituraDoClienteFalha = false;
  filtrosDaUltima = [];
});

describe("aviso quando o clima escala e o cliente escreveu 'parar'", () => {
  it("'Parar não é daqui' recebe a confirmação de saída, não o texto de atendente", async () => {
    ultimaDoCliente = "Parar não é daqui";

    await avisarLeadDoCrm(banco(), ENTRADA);

    const corpo = corpoEnviado();
    expect(corpo).toBe(textoDoAviso("suspeita_de_opt_out", SEM_EQUIPE, CONTATO, "pt-BR"));
    expect(corpo).not.toMatch(/atendente humano|já te respondem|Já acionei o time/i);
  });

  it("pergunta de paciente ('tem como parar a dor?') segue com a frase genérica de antes", async () => {
    ultimaDoCliente = "tem como parar a dor?";

    await avisarLeadDoCrm(banco(), ENTRADA);

    expect(corpoEnviado()).toBe(textoDoAviso("outro", SEM_EQUIPE, CONTATO, "pt-BR"));
  });

  it("sem mensagem do cliente para ler, segue com a frase genérica de antes", async () => {
    ultimaDoCliente = null;

    await avisarLeadDoCrm(banco(), ENTRADA);

    expect(corpoEnviado()).toBe(textoDoAviso("outro", SEM_EQUIPE, CONTATO, "pt-BR"));
  });

  it("leitura que falha volta ao comportamento de antes — e o aviso sai mesmo assim", async () => {
    ultimaDoCliente = "Parar não é daqui";
    leituraDoClienteFalha = true;

    await avisarLeadDoCrm(banco(), ENTRADA);

    expect(corpoEnviado()).toBe(textoDoAviso("outro", SEM_EQUIPE, CONTATO, "pt-BR"));
  });

  it("só o motivo GENÉRICO é reavaliado: quem pediu uma pessoa recebe a frase de quem pediu uma pessoa", async () => {
    ultimaDoCliente = "PARAR";

    await avisarLeadDoCrm(banco(), { ...ENTRADA, reason: "requested_human" });

    expect(corpoEnviado()).toBe(textoDoAviso("pediu_humano", SEM_EQUIPE, CONTATO, "pt-BR"));
  });

  it("a leitura da última mensagem filtra pela organização E pela conversa, só as recebidas", async () => {
    ultimaDoCliente = "oi";

    await avisarLeadDoCrm(banco(), ENTRADA);

    // O cliente é service role, sem RLS: a organização e a conversa vão no filtro.
    expect(filtrosDaUltima).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["conversation_id", CONVERSA],
        ["direction", "inbound"],
      ]),
    );
  });
});

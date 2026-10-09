/**
 * O interruptor POR EMPRESA do `ai_decide` (#2367) — o freio que o #2228 não
 * trouxe, por decisão do mantenedor.
 *
 * Três provas, na ordem dos critérios de pronto da issue:
 *
 *  1. DESLIGADO: a regra NÃO consulta o modelo — o spy de `decidirAcao` fica em
 *     ZERO chamadas — e o run grava o motivo, com FRASE na aba Atividade (a
 *     frase é lida do próprio mapa da tela, não de memória).
 *  2. LIGADO (controle positivo): o modelo É consultado. Sem este caso, um
 *     teste que só afirma "não chamou" passaria para qualquer defeito que
 *     impedisse a chamada — inclusive uma leitura que falhasse (que, desde a
 *     triagem, também não consulta o modelo: ver o caso ILEGÍVEL).
 *  3. PADRÃO: sem a chave gravada, LIGADO — é o estado de uma empresa que
 *     nunca mexeu no interruptor depois do #2228 (o padrão pedido na issue).
 *
 * E duas que vieram na triagem:
 *
 *  4. ILEGÍVEL: erro ao LER o interruptor não consulta o modelo, e o run grava
 *     um motivo PRÓPRIO — o operador pode ter desligado, e a tela não pode
 *     dizer "a empresa desligou" quando o que houve foi erro de leitura.
 *  5. ADIAMENTO: o `postponeUntil` só pula as janelas com o `false` GRAVADO;
 *     no ilegível elas seguem, para nunca mandar fora da janela.
 *
 * A chamada de modelo é mockada (`decisao-de-acao`), mesmo desenho do irmão
 * `lib/automation/actions/ai-decide.test.ts`: o que se testa aqui é o
 * CONTRATO do freio, não a conversa com o provedor.
 */
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/agent/decisao-de-acao", () => ({ decidirAcao: vi.fn() }));

import { getAction, registerAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import { decidirAcao } from "@/lib/agent-engine/agent/decisao-de-acao";
import { DICIONARIO } from "@/lib/i18n/dicionario";

import "@/lib/automation/actions/ai-decide";

import { lerMapaDeMotivos } from "./helpers/motivos-de-parada";

const decidir = vi.mocked(decidirAcao);

const ORG = "11111111-1111-4111-8111-111111111111";
const REGRA = "22222222-2222-4222-8222-222222222222";
const MOTIVO = "ai_decide_desligado_na_empresa";
const MOTIVO_ILEGIVEL = "ai_decide_interruptor_ilegivel";

const CONFIG = {
  custo_de_token: true,
  instrucao: "Se demonstrou interesse em parcelamento, marque como quente.",
  opcoes: [
    {
      id: "quente",
      rotulo: "Marcar como quente",
      acao: { type: "add_tag", config: { tags: ["quente"] } },
    },
    {
      id: "retorno",
      rotulo: "Criar tarefa de retorno",
      acao: { type: "add_tag", config: { tags: ["retorno"] } },
    },
  ],
};

/**
 * O client só precisa da leitura que o freio faz:
 * `from("organizations").select("settings").eq(...).maybeSingle()`.
 */
function adminComSettings(settings: unknown): ActionCtx["admin"] {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () =>
        table === "organizations"
          ? { data: settings === undefined ? null : { settings }, error: null }
          : { data: null, error: null };
      return b;
    },
  } as unknown as ActionCtx["admin"];
}

function ctx(admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: REGRA,
    ruleName: "Regra de teste",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: ORG,
      event_type: "message.received",
      entity_kind: "crm_lead",
      entity_id: "33333333-3333-4333-8333-333333333333",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: {},
  } as ActionCtx;
}

const executor = () => getAction("ai_decide")!;

/** O settings de uma empresa que DESLIGOU o freio. */
const SETTINGS_DESLIGADO = { automacoes: { ai_decide: false } };

beforeEach(() => {
  decidir.mockReset();
  // Se o freio falhar e a chamada acontecer, é isto que o teste precisa ver.
  decidir.mockResolvedValue({ ok: false, motivo: "resposta_vazia" });
});

describe("interruptor da empresa DESLIGADO: o modelo não é consultado", () => {
  it("não chama o modelo nenhuma vez e o run grava o motivo do freio", async () => {
    const resultado = await executor().execute(
      ctx(adminComSettings(SETTINGS_DESLIGADO)),
      structuredClone(CONFIG),
    );

    expect(
      decidir,
      "o modelo foi consultado com o interruptor da empresa desligado",
    ).not.toHaveBeenCalled();
    expect(resultado).toEqual({
      type: "ai_decide",
      status: "skipped",
      detail: { reason: MOTIVO },
    });
  });

  it.each([MOTIVO, MOTIVO_ILEGIVEL])("o motivo %s tem FRASE na aba Atividade e essa frase tem espanhol", (motivo) => {
    const mapa = lerMapaDeMotivos(
      join(__dirname, "..", ".."),
      "app/app/webhooks/_components/ActivityTab.tsx",
    );
    const frase = mapa.get(motivo);
    expect(frase, `o motivo ${motivo} não tem frase no mapa MOTIVO_DA_PARADA`).toBeTruthy();
    expect(frase!.trim().length, "frase curta demais: a tela mostraria nada").toBeGreaterThan(10);
    expect(
      DICIONARIO[frase!]?.es,
      "a frase da aba Atividade não tem coluna es no dicionário",
    ).toBeTruthy();
  });
});

describe("interruptor da empresa LIGADO (controle positivo)", () => {
  it("chama o modelo — sem este caso, o vermelho de cima não provaria nada", async () => {
    const resultado = await executor().execute(
      ctx(adminComSettings({ automacoes: { ai_decide: true } })),
      structuredClone(CONFIG),
    );

    expect(decidir, "com o interruptor ligado o modelo tem de ser consultado").toHaveBeenCalledTimes(1);
    // O mock devolveu resposta inválida de propósito: nada além da chamada é
    // medido aqui, e a ação-alvo não roda sem escolha.
    expect(resultado.status).toBe("failed");
    expect(resultado.detail).toEqual({ reason: "resposta_vazia" });
  });

  it("sem a chave gravada, o padrão é LIGADO — regra do #2228 segue decidindo", async () => {
    await executor().execute(ctx(adminComSettings({})), structuredClone(CONFIG));

    expect(decidir, "settings sem a chave tem de manter o padrão ligado").toHaveBeenCalledTimes(1);
  });
});

/** Leitura que devolve `error` do supabase (rede, permissão). */
const adminComErro = {
  from() {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: null, error: { message: "rede" } });
    return b;
  },
} as unknown as ActionCtx["admin"];

/** Client sem `from`: a leitura LANÇA, e o leitor converte em "não deu para saber". */
const adminQueLanca = {} as ActionCtx["admin"];

describe("interruptor da empresa ILEGÍVEL: na dúvida sobre agir, não age", () => {
  it.each([
    ["erro devolvido pela leitura", adminComErro],
    ["exceção na leitura", adminQueLanca],
  ])("%s: não consulta o modelo e grava um motivo PRÓPRIO", async (_caso, admin) => {
    const resultado = await executor().execute(ctx(admin), structuredClone(CONFIG));

    expect(
      decidir,
      "o modelo foi consultado sem saber se o operador desligou o interruptor",
    ).not.toHaveBeenCalled();
    expect(resultado).toEqual({
      type: "ai_decide",
      status: "skipped",
      detail: { reason: MOTIVO_ILEGIVEL },
    });
  });
});

describe("pré-checagem do motor (postponeUntil) com o interruptor", () => {
  const ADIA_ATE = "2026-10-07T09:00:00.000Z";
  const postpone = vi.fn(async () => ADIA_ATE);
  // Tipo próprio deste arquivo: o registro é um mapa só, sem remoção, e não
  // pode trocar o executor de uma ação real.
  registerAction({
    type: "teste_janela_do_interruptor",
    postponeUntil: postpone,
    execute: async () => ({ type: "teste_janela_do_interruptor", status: "success" }),
  });
  const CONFIG_COM_JANELA = {
    ...CONFIG,
    opcoes: [
      CONFIG.opcoes[0],
      { id: "janela", rotulo: "Ação com janela", acao: { type: "teste_janela_do_interruptor", config: {} } },
    ],
  };

  beforeEach(() => postpone.mockClear());

  it("DESLIGADO: não adia o evento por um passo que não vai rodar", async () => {
    const ate = await executor().postponeUntil!(
      ctx(adminComSettings(SETTINGS_DESLIGADO)),
      structuredClone(CONFIG_COM_JANELA),
    );

    expect(ate).toBeNull();
    expect(postpone, "com o freio desligado a janela da ação-alvo nem é consultada").not.toHaveBeenCalled();
  });

  it("ILEGÍVEL: as janelas seguem valendo — nunca manda fora da janela", async () => {
    const ate = await executor().postponeUntil!(ctx(adminComErro), structuredClone(CONFIG_COM_JANELA));

    expect(ate).toBe(ADIA_ATE);
    expect(postpone).toHaveBeenCalledTimes(1);
    expect(decidir, "adiado não pode gastar token").not.toHaveBeenCalled();
  });
});

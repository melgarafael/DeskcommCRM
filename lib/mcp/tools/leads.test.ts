/**
 * O agente consegue escrever nos campos que o dono declarou no funil?
 *
 * A cadeia tinha quatro elos e três estavam prontos: `updateLeadSchema` aceitava
 * `custom_fields`, `updateLeadHandler` fazia o merge com o que já existia, e a
 * mudança virava atividade na linha do tempo. O quarto — o shape da FERRAMENTA —
 * não declarava a chave, e como o handler monta `{...rest}` a partir dele, o
 * valor era descartado antes de chegar ao schema que o aceitaria.
 *
 * O modo de falha era mudo: nenhum erro, nenhum log, o `crm_update_lead`
 * devolvia sucesso e o campo continuava vazio na ficha.
 *
 * Por isso o teste não se contenta em olhar o shape. Ele reproduz o caminho do
 * handler (destructuring + `updateLeadSchema.parse`) e cobra o valor do outro
 * lado — e traz o CONTROLE NEGATIVO junto: uma chave não declarada tem de
 * continuar sendo descartada, senão o teste passaria mesmo com o defeito de
 * volta, provando apenas que zod aceita objeto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { updateLeadSchema } from "@/lib/schemas/leads";
import type { McpContext } from "@/lib/mcp/types";

import { crmMoveLeadStage, crmUpdateLead } from "./leads";

/**
 * A escrita de verdade (`updateLeadHandler`) fica DUBLADA: aqui se mede a
 * DECISÃO da ferramenta (#4667) — quem recusa, o que o modelo lê e o que chega
 * ao handler. O merge no banco é assunto do `_handler.test.ts`.
 */
const escrita = vi.hoisted(() => ({
  atualizarNegocio: vi.fn(async (_db: unknown, _ctx: unknown, id: string, corpo: Record<string, unknown>) => ({
    id,
    ...corpo,
  })),
}));

vi.mock("@/app/api/v1/leads/_handler", () => ({
  listLeadsHandler: vi.fn(),
  getLeadHandler: vi.fn(),
  createLeadHandler: vi.fn(),
  updateLeadHandler: escrita.atualizarNegocio,
  moveLeadHandler: vi.fn(),
  retomarLeadHandler: vi.fn(),
}));

/** O mesmo caminho do handler: tira `lead_id`, entrega o resto ao schema. */
function comoOHandlerFaz(entrada: Record<string, unknown>) {
  const doShape = z.object(crmUpdateLead.inputSchema).parse(entrada);
  const { lead_id: _ignorado, ...resto } = doShape as Record<string, unknown>;
  return updateLeadSchema.parse(resto);
}

const LEAD_ID = "11111111-2222-4333-8444-555555555555";

describe("crm_update_lead — campos personalizados do funil", () => {
  it("leva o valor até o schema que o handler usa", () => {
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      custom_fields: { prescritor: "Dra. Ana", forma_farmaceutica: "capsula" },
    });

    expect(saida.custom_fields).toEqual({
      prescritor: "Dra. Ana",
      forma_farmaceutica: "capsula",
    });
  });

  it("aceita qualquer chave, porque quem as nomeia é o dono do funil", () => {
    // O vocabulário é do nicho: uma farmácia de manipulação declara `ativos`,
    // uma imobiliária declara `metragem`. O schema não pode ter uma lista.
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      custom_fields: { metragem: 82, aceita_permuta: true, ativos: null },
    });

    expect(saida.custom_fields).toEqual({
      metragem: 82,
      aceita_permuta: true,
      ativos: null,
    });
  });

  it("continua descartando chave que a ferramenta não declara (controle)", () => {
    // Sem esta asserção, o teste acima passaria mesmo com o defeito de volta:
    // provaria só que `z.object` aceita um objeto, não que a chave sobrevive.
    const saida = comoOHandlerFaz({
      lead_id: LEAD_ID,
      title: "Fórmula da Dra. Ana",
      campo_que_ninguem_declarou: "some aqui",
    });

    expect(saida).not.toHaveProperty("campo_que_ninguem_declarou");
    expect(saida.title).toBe("Fórmula da Dra. Ana");
  });

  it("segue opcional — mexer só em tags não obriga a mandar custom_fields", () => {
    const saida = comoOHandlerFaz({ lead_id: LEAD_ID, tags: ["controlado"] });

    expect(saida.tags).toEqual(["controlado"]);
    expect(saida.custom_fields).toBeUndefined();
  });
});


describe("crm_move_lead_stage — motivo de ganho (#1536)", () => {
  it("declara won_reason no shape da tool (sem isto, o valor é descartado antes do schema)", () => {
    const doShape = z.object(crmMoveLeadStage.inputSchema).parse({
      lead_id: LEAD_ID,
      to_stage_id: LEAD_ID,
      won_reason: "Renovação anual",
    });
    expect(doShape).toMatchObject({ won_reason: "Renovação anual" });
  });

  it("segue aceitando sem won_reason — o movimento comum não muda", () => {
    const doShape = z.object(crmMoveLeadStage.inputSchema).parse({
      lead_id: LEAD_ID,
      to_stage_id: LEAD_ID,
    });
    expect(doShape).not.toHaveProperty("won_reason");
  });
});

describe("crm_move_lead_stage — motivo da perda (#917)", () => {
  it("declara lost_reason no shape da tool (sem isto, o valor é descartado e o banco recusa a perda)", () => {
    const doShape = z.object(crmMoveLeadStage.inputSchema).parse({
      lead_id: LEAD_ID,
      to_stage_id: LEAD_ID,
      lost_reason: "Sem retorno",
    });
    expect(doShape).toMatchObject({ lost_reason: "Sem retorno" });
  });

  it("segue aceitando sem lost_reason — o movimento comum não muda", () => {
    const doShape = z.object(crmMoveLeadStage.inputSchema).parse({
      lead_id: LEAD_ID,
      to_stage_id: LEAD_ID,
    });
    expect(doShape).not.toHaveProperty("lost_reason");
  });

  it("aceita lost_reason vazio — quem decide a recusa é motivo-da-perda.ts, não o zod", () => {
    const r = z.object(crmMoveLeadStage.inputSchema).safeParse({
      lead_id: LEAD_ID,
      to_stage_id: LEAD_ID,
      lost_reason: "",
    });
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4667, parte 2 — `custom_fields` com chave que o funil do negócio NÃO declara
// ─────────────────────────────────────────────────────────────────────────────

describe("crm_update_lead — a chave de custom_fields tem de existir no funil (#4667)", () => {
  const FUNIL = "44444444-4444-4444-8444-444444444444";
  const CONTATO = "33333333-3333-4333-8333-333333333333";
  const ORG = "22222222-2222-4222-8222-222222222222";

  /** Os campos que o DONO declarou neste funil — a lista que o erro ensina. */
  const CAMPOS_DO_FUNIL = [
    { key: "plano", label: "Plano do contrato", type: "text" },
    { key: "vencimento", label: "Vencimento", type: "date" },
  ];

  interface Opcoes {
    /** `null` = funil cujo `settings` não declara campo nenhum. */
    fields?: unknown[] | null;
    /** O funil NÃO pôde ser lido: a tabela de funis responde erro. */
    erroAoLerOFunil?: boolean;
  }

  function banco(opcoes: Opcoes = {}) {
    const lidas: string[] = [];
    const from = (tabela: string) => {
      lidas.push(tabela);
      const q: Record<string, unknown> = {};
      const mesmo = () => q;
      for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = mesmo;
      q.maybeSingle = async () => {
        // Jev desligado: a conferência de VALOR (degrau 2) sai antes de existir,
        // e o que fica à vista é só a conferência da CHAVE.
        if (tabela === "organizations") return { data: { settings: null }, error: null };
        if (tabela === "crm_leads") return { data: { pipeline_id: FUNIL }, error: null };
        if (tabela === "crm_pipelines") {
          if (opcoes.erroAoLerOFunil) return { data: null, error: { message: "funil indisponível agora" } };
          const fields = opcoes.fields === undefined ? CAMPOS_DO_FUNIL : opcoes.fields;
          return { data: { settings: fields === null ? null : { fields } }, error: null };
        }
        return { data: null, error: null };
      };
      q.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, ruim);
      return q;
    };
    return { from, lidas } as unknown as SupabaseClient & { lidas: string[] };
  }

  /** O turno do agente: papel `ai_operator` E o contato que só a ponte injeta. */
  function ctxDoAgente(db: SupabaseClient): McpContext {
    return {
      organizationId: ORG,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "agent-1", agent_id: "agent-1", role: "ai_operator", api_token_id: "tok" },
      apiTokenId: "tok",
      requestId: "req-4667",
      supabase: db,
      contatoDoTurno: CONTATO,
    } as unknown as McpContext;
  }

  /** A chamada por TOKEN DE PESSOA: papel de gestor, sem contato de turno. */
  function ctxDaPessoa(db: SupabaseClient): McpContext {
    return {
      organizationId: ORG,
      role: "manager",
      actor: { type: "user", id: "user-1", role: "manager", api_token_id: "tok-pessoa" },
      apiTokenId: "tok-pessoa",
      requestId: "req-4667",
      supabase: db,
    } as unknown as McpContext;
  }

  const chamada = {
    lead_id: LEAD_ID,
    custom_fields: { valor_do_plano: 1990, plano: "anual" },
  };

  // `clear` limpa as CHAMADAS e preserva a implementação do dublê — é o que os
  // quatro casos precisam para ver só as próprias chamadas.
  beforeEach(() => {
    escrita.atualizarNegocio.mockClear();
  });

  it("(a) chave inventada é RECUSADA, e o erro traz as chaves válidas com rótulo", async () => {
    const db = banco();

    const erro = await crmUpdateLead.handler(chamada as never, ctxDoAgente(db)).then(
      () => null,
      (e: unknown) => e as { status: number; code: string; message: string; details: Record<string, unknown> },
    );

    expect(erro, "a chave inventada não pode ser gravada em silêncio").not.toBeNull();
    expect(erro?.status).toBe(422);
    expect(erro?.code).toBe("custom_field_key_not_in_funnel");
    // A mensagem é o que o MODELO lê (`details` não atravessa o servidor MCP):
    // as válidas precisam estar nela, com chave E rótulo.
    expect(erro?.message).toContain('"valor_do_plano"');
    expect(erro?.message).toContain('"plano" (Plano do contrato)');
    expect(erro?.message).toContain('"vencimento" (Vencimento)');
    expect(erro?.message).toContain("nada foi gravado");
    expect(erro?.details).toMatchObject({
      chaves_invalidas: ["valor_do_plano"],
      chaves_validas: [
        { chave: "plano", rotulo: "Plano do contrato" },
        { chave: "vencimento", rotulo: "Vencimento" },
      ],
    });
    // A recusa vem ANTES da escrita: nada chegou ao handler.
    expect(escrita.atualizarNegocio).not.toHaveBeenCalled();
  });

  it("(b) chave que o funil declara grava normal — sem aviso e sem recusa", async () => {
    const db = banco();

    const saida = (await crmUpdateLead.handler(
      { lead_id: LEAD_ID, custom_fields: { plano: "anual" } } as never,
      ctxDoAgente(db),
    )) as Record<string, unknown>;

    expect(escrita.atualizarNegocio).toHaveBeenCalledTimes(1);
    const corpo = escrita.atualizarNegocio.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(corpo.custom_fields).toEqual({ plano: "anual" });
    expect(saida).not.toHaveProperty("aviso");
    expect(saida).not.toHaveProperty("chaves_do_funil");
  });

  it("(c) funil ilegível: GRAVA como hoje e avisa que as chaves não foram conferidas", async () => {
    const db = banco({ erroAoLerOFunil: true });

    const saida = (await crmUpdateLead.handler(chamada as never, ctxDoAgente(db))) as Record<string, unknown>;

    // Degradação honesta: um erro de leitura não pode virar ferramenta inútil.
    expect(escrita.atualizarNegocio).toHaveBeenCalledTimes(1);
    const corpo = escrita.atualizarNegocio.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(corpo.custom_fields).toEqual({ valor_do_plano: 1990, plano: "anual" });
    expect(saida.chaves_do_funil).toBe("nao_conferidas");
    expect(String(saida.aviso)).toContain("Não conferi as chaves de `custom_fields`");
  });

  it("(d) controle: chamada por token de PESSOA mantém o comportamento de hoje", async () => {
    const db = banco();

    const saida = (await crmUpdateLead.handler(chamada as never, ctxDaPessoa(db))) as Record<string, unknown>;

    expect(escrita.atualizarNegocio).toHaveBeenCalledTimes(1);
    const corpo = escrita.atualizarNegocio.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(corpo.custom_fields).toEqual({ valor_do_plano: 1990, plano: "anual" });
    expect(saida).not.toHaveProperty("aviso");
    // E nenhuma leitura a mais: quem não é o turno do agente não paga a leitura
    // do funil (a catraca de origem da #2234 continua valendo).
    expect(db.lidas).not.toContain("crm_pipelines");
  });
});

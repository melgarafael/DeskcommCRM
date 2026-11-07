/**
 * QUEM CHEGA A UMA ETAPA ENTRA NO TOPO — provado no ESCRITOR, não na função pura
 * (issue #3461, item 1).
 *
 * ─── Por que este arquivo existe ──────────────────────────────────────────
 *
 * A régua de entrada tem teste de unidade (`lib/kanban/entrada-na-etapa.test.ts`:
 * `midpoint(null, min)`), e o quadro tem teste de render. O que NÃO tinha prova
 * era o encontro dos dois: o caminho que ESCREVE `position_in_stage` quando a
 * chamada não manda posição — `moveLeadHandler`, o escritor de etapa de tudo o
 * que não é o arrasto (a tool MCP `crm_move_lead_stage`, a ação
 * `create_or_move_lead` e o espelho de etapa do agente).
 *
 * Era exatamente aí que o defeito morava: `MAX + 1000`, isto é, o fim da
 * coluna. Trocar a função pura de lugar sem trocar esta escrita deixaria o
 * quadro lindo e a conversa transferida continuando no fim — o vermelho que a
 * issue descreve. Este teste fecha a ponta que faltava.
 *
 * ─── O que ele mede, e como ───────────────────────────────────────────────
 *
 * O banco falso devolve a ponta da coluna de DESTINO na direção que o handler
 * pediu (`order("position_in_stage", { ascending })`): crescente = o primeiro
 * card; decrescente = o último. A asserção é sobre o `position_in_stage` que
 * vai no UPDATE, então reverter a regra para `max + 1000` — ou trocar a direção
 * do `order` — muda o número gravado e reprova.
 *
 * O caso da MESMA etapa é o controle negativo, e não um enfeite: mover para a
 * coluna onde o card já está é REORDENAÇÃO sem alvo, e continua indo para o fim
 * de propósito (mandá-lo ao topo transformaria "reordenar" em "pular para o
 * começo"). Sem ele, "sempre topo" passaria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
const rpcDoAdmin = vi.hoisted(() =>
  vi.fn((_funcao: string, _args: unknown) => Promise.resolve({ error: null })),
);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: rpcDoAdmin })),
}));

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_A = "55555555-5555-4555-8555-555555555555";
const ETAPA_B = "66666666-6666-4666-8666-666666666666";

/** A coluna de destino tem dois cards: 3000 (primeiro) e 4000 (último). */
const PRIMEIRO_DA_COLUNA = 3000;
const ULTIMO_DA_COLUNA = 4000;
/** O passo inteiro da régua (o mesmo de `midpoint`). */
const PASSO = 1000;

interface PontaDaColuna {
  primeiro: number | null;
  ultimo: number | null;
}

/**
 * Banco falso que RESPONDE A DIREÇÃO pedida: `ascending: true` devolve o
 * primeiro card da coluna, `false` devolve o último. Um dublê que devolvesse
 * sempre o mesmo número deixaria passar a troca da direção do `order` — que é
 * metade da regra.
 */
function bancoFalso(ponta: PontaDaColuna = { primeiro: PRIMEIRO_DA_COLUNA, ultimo: ULTIMO_DA_COLUNA }) {
  const escritas: Array<Record<string, unknown>> = [];

  const from = (tabela: string) => {
    if (tabela === "crm_pipelines") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: { settings: null }, error: null });
      return chain;
    }
    if (tabela === "crm_stages") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (_col: string, id: string) => {
        chain.id = id;
        return chain;
      };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = async () => ({
        data: {
          id: chain.id,
          organization_id: ORG,
          pipeline_id: FUNIL,
          name: "Etapa",
          is_won: false,
          is_lost: false,
        },
        error: null,
      });
      return chain;
    }
    if (tabela === "crm_lead_activities") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = async () => ({ data: [], error: null });
      return chain;
    }
    if (tabela === "crm_leads") {
      const lead = () => ({
        id: LEAD,
        organization_id: ORG,
        pipeline_id: FUNIL,
        // O card está SEMPRE na ETAPA_A: é ela que o handler compara com o
        // destino para decidir entre "chegada" e "reordenação".
        stage_id: ETAPA_A,
        contact_id: null,
        status: "open",
        lost_reason: null,
        updated_at: "2026-09-15T12:00:00.000Z",
        custom_fields: {} as Record<string, unknown>,
        won_reason: null,
      });

      return {
        select: () => {
          const leitura: Record<string, unknown> = {};
          // A leitura da PONTA da coluna ordena; a releitura do lead
          // (pós-escrita) não. É o que separa as duas consultas no dublê.
          let pediuPonta = false;
          let decrescente = false;
          leitura.eq = () => leitura;
          leitura.order = (_col: string, opts?: { ascending?: boolean }) => {
            pediuPonta = true;
            decrescente = opts?.ascending === false;
            return leitura;
          };
          leitura.limit = () => leitura;
          leitura.maybeSingle = async () => {
            if (!pediuPonta) return { data: lead(), error: null };
            return {
              data: { position_in_stage: decrescente ? ponta.ultimo : ponta.primeiro },
              error: null,
            };
          };
          return leitura;
        },
        update: (valores: Record<string, unknown>) => {
          escritas.push(valores);
          const escrita: Record<string, unknown> = {};
          escrita.eq = () => escrita;
          escrita.select = () => escrita;
          escrita.maybeSingle = async () => ({
            data: { ...lead(), stage_id: String(valores.stage_id) },
            error: null,
          });
          return escrita;
        },
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  };

  return { from, escritas };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-1",
  idioma: "pt-BR",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveLeadHandler — onde o card que CHEGA entra na coluna (#3461, item 1)", () => {
  it("⭐ sem posição, outra etapa: entra ACIMA do primeiro card (min − 1000)", async () => {
    const banco = bancoFalso();

    await moveLeadHandler(banco as never, ctx, LEAD, { to_stage_id: ETAPA_B });

    expect(banco.escritas).toHaveLength(1);
    expect(banco.escritas[0]).toMatchObject({
      stage_id: ETAPA_B,
      // 3000 − 1000. O defeito que a issue relata gravava 4000 + 1000 = 5000,
      // isto é, o fim da coluna.
      position_in_stage: PRIMEIRO_DA_COLUNA - PASSO,
    });
  });

  it("⭐ MESMA etapa sem posição continua indo para o FIM: reordenar não é chegar", async () => {
    const banco = bancoFalso();

    await moveLeadHandler(banco as never, ctx, LEAD, { to_stage_id: ETAPA_A });

    expect(banco.escritas[0]).toMatchObject({
      stage_id: ETAPA_A,
      position_in_stage: ULTIMO_DA_COLUNA + PASSO,
    });
  });

  it("posição EXPLÍCITA passa intacta — quem arrastou já decidiu onde soltar", async () => {
    const banco = bancoFalso();

    await moveLeadHandler(banco as never, ctx, LEAD, {
      to_stage_id: ETAPA_B,
      position_in_stage: 3500,
    });

    expect(banco.escritas[0]).toMatchObject({ stage_id: ETAPA_B, position_in_stage: 3500 });
  });

  it("coluna vazia: o card nasce no miolo de sempre (1000)", async () => {
    const banco = bancoFalso({ primeiro: null, ultimo: null });

    await moveLeadHandler(banco as never, ctx, LEAD, { to_stage_id: ETAPA_B });

    expect(banco.escritas[0]).toMatchObject({ stage_id: ETAPA_B, position_in_stage: 1000 });
  });
});

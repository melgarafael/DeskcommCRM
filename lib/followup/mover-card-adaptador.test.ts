/**
 * O ESCRITOR do "ao responder, mover o card" — medido no adaptador de produção.
 *
 * `moverCardAoResponder` da reatividade escolhe QUAL negócio anda. A escolha é a
 * regra declarada do #3974: o negócio ABERTO do contato que está NA ETAPA DE
 * ORIGEM do gatilho (o card que o fluxo armou), o mais recente quando há mais de
 * um. Um contato com dois negócios — em funis diferentes, ou um deles já
 * fechado — não pode fazer o card errado andar.
 *
 * Roda sem Postgres: o cliente falso aplica DE VERDADE os filtros `eq` e a ordem
 * que o adaptador pede, então um filtro esquecido (organização, etapa, status)
 * muda a linha devolvida em vez de passar despercebido. O `moveLeadHandler` é
 * falso porque o que se mede aqui é a ESCOLHA, não a escrita — a escrita é dele,
 * já coberta pelos testes do board, do lote e da automação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { moveLeadHandler } = vi.hoisted(() => ({ moveLeadHandler: vi.fn(async (..._a: unknown[]) => ({})) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler }));

import { createSupabaseReactivityClient } from "./reactivity";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const ETAPA_ORCAMENTO = "44444444-4444-4444-8444-444444444444";
const ETAPA_NEGOCIACAO = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;

const NEGOCIOS: Linha[] = [
  // O mais recente do contato está em OUTRO funil/etapa: é ele que uma consulta
  // sem o recorte de etapa escolheria.
  { id: "lead-outro-funil", organization_id: ORG, contact_id: CONTATO, stage_id: "etapa-de-outro-funil", status: "open", created_at: "2026-11-04T12:00:00Z" },
  // Fechado, e na etapa do gatilho: não é card para mover.
  { id: "lead-ganho", organization_id: ORG, contact_id: CONTATO, stage_id: ETAPA_ORCAMENTO, status: "won", created_at: "2026-11-03T12:00:00Z" },
  { id: "lead-na-etapa", organization_id: ORG, contact_id: CONTATO, stage_id: ETAPA_ORCAMENTO, status: "open", created_at: "2026-11-01T12:00:00Z" },
  { id: "lead-na-etapa-mais-novo", organization_id: ORG, contact_id: CONTATO, stage_id: ETAPA_ORCAMENTO, status: "open", created_at: "2026-11-02T12:00:00Z" },
  // Mesmo contato, mesma etapa, outra organização: o filtro de org é o que segura.
  { id: "lead-de-outra-org", organization_id: OUTRA_ORG, contact_id: CONTATO, stage_id: ETAPA_ORCAMENTO, status: "open", created_at: "2026-11-05T12:00:00Z" },
];

function cliente(tabelas: Record<string, Linha[]>) {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let ordem: string | null = null;
      let decrescente = false;
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), q),
        order: (coluna: string, opcoes?: { ascending?: boolean }) => {
          ordem = coluna;
          decrescente = opcoes?.ascending === false;
          return q;
        },
        limit: () => q,
        maybeSingle: async () => {
          const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
          if (ordem) {
            linhas.sort((a, b) => {
              const va = String(a[ordem!] ?? "");
              const vb = String(b[ordem!] ?? "");
              return decrescente ? vb.localeCompare(va) : va.localeCompare(vb);
            });
          }
          return { data: linhas[0] ?? null, error: null };
        },
      };
      return q;
    },
  } as never;
}

function escritor(tabelas: Record<string, Linha[]>) {
  return createSupabaseReactivityClient(cliente(tabelas) as never).moverCardAoResponder!;
}

function mover(tabelas: Record<string, Linha[]>) {
  return escritor(tabelas)({
    organization_id: ORG,
    enrollment_id: "enr-1",
    contact_id: CONTATO,
    etapa_de_origem: ETAPA_ORCAMENTO,
    etapa_de_destino: ETAPA_NEGOCIACAO,
  });
}

beforeEach(() => moveLeadHandler.mockClear());

describe("quem se move quando o cliente responde (#3974)", () => {
  it("move o card ABERTO que está na etapa do gatilho, e não o mais recente de outra etapa", async () => {
    const resultado = await mover({ crm_leads: NEGOCIOS });

    expect(resultado).toEqual({ ok: true });
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(moveLeadHandler.mock.calls[0]!.slice(2)).toEqual([
      "lead-na-etapa-mais-novo",
      { to_stage_id: ETAPA_NEGOCIACAO },
    ]);
  });

  it("o ator é o próprio enrollment (`followup:<id>`) — é o que poupa a inscrição da saída de etapa", async () => {
    await mover({ crm_leads: NEGOCIOS });

    const ctx = moveLeadHandler.mock.calls[0]![1] as { organization_id: string; actor: { type: string; id: string } };
    expect(ctx.organization_id).toBe(ORG);
    expect(ctx.actor).toEqual({ type: "webhook_source", id: "followup:enr-1" });
  });

  it("negócio de OUTRA organização na mesma etapa não é tocado", async () => {
    const apenasDeOutraOrg = NEGOCIOS.filter((l) => l.organization_id === OUTRA_ORG);

    const resultado = await mover({ crm_leads: apenasDeOutraOrg });

    expect(resultado).toEqual({ ok: false, motivo: "sem_negocio_na_etapa" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("negócio fechado na etapa não é reaberto por uma resposta", async () => {
    const apenasFechado = NEGOCIOS.filter((l) => l.id === "lead-ganho");

    const resultado = await mover({ crm_leads: apenasFechado });

    expect(resultado).toEqual({ ok: false, motivo: "sem_negocio_na_etapa" });
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });

  it("etapa arquivada/removida: a recusa do escritor vira motivo legível, não exceção", async () => {
    moveLeadHandler.mockRejectedValueOnce(new Error("Etapa não encontrada nesta organização"));

    const resultado = await mover({ crm_leads: NEGOCIOS });

    expect(resultado).toEqual({ ok: false, motivo: "recusado", erro: "Etapa não encontrada nesta organização" });
  });

  it("duas respostas seguidas não movem duas vezes: a segunda não acha mais card na etapa", async () => {
    const tabelas = {
      crm_leads: NEGOCIOS.filter((l) => l.id === "lead-na-etapa").map((l) => ({ ...l })),
    };
    moveLeadHandler.mockImplementationOnce(async (...args: unknown[]) => {
      const leadId = String(args[2]);
      const linha = tabelas.crm_leads.find((l) => l.id === leadId);
      if (linha) linha.stage_id = ETAPA_NEGOCIACAO; // o movimento, refletido no banco
      return {};
    });

    const primeira = await mover(tabelas);
    const segunda = await mover(tabelas);

    expect(primeira).toEqual({ ok: true });
    expect(segunda).toEqual({ ok: false, motivo: "sem_negocio_na_etapa" });
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
  });
});

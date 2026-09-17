/**
 * O CAMINHO 3 (IA) — a etapa de PERDA sem motivo (issue #917).
 *
 * O agente pensa em sete passos fixos (`lead_state.stage`) e o card do tenant
 * anda junto, traduzido por `crm_stages.agent_stage_hint`. O defeito: quando a
 * etapa de destino é de PERDA, `trg_crm_lead_close_on_stage` fecha o negócio e a
 * CHECK `crm_leads_lost_reason_required` recusa a linha — o UPDATE voltava como
 * `falha_de_escrita`, o worker abria um item de INCIDENTE ("o UPDATE do card
 * falhou") e o funil do agente ficava avançado enquanto o do cliente não.
 *
 * A regra do produto é outra, e é esta que os casos abaixo prendem:
 *  - a IA NÃO escreve `lost_reason` (o trigger recusa motivo fora do vocabulário
 *    do funil, 22023 `lost_reason_invalid` — e inventar uma causa no funil do
 *    cliente seria pior que não mover);
 *  - o card NÃO se move (nada é escrito: nem etapa, nem timeline);
 *  - o não-movimento é recusa de NEGÓCIO, com item de inbox acionável — não
 *    warn silencioso (o dono ficaria sem saber por que o card parou) e não
 *    incidente (nada quebrou).
 *
 * Vermelho sem o fix: o resolvedor devolvia `{ move: true }` para a etapa de
 * perda (o espelho tentava o UPDATE) e o motivo chegava ao worker como
 * `falha_de_escrita` — os três casos abaixo falham nesse estado.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolveDestinoDoAgente,
  sincronizaEstagioDoAgente,
  type EstagioCandidato,
} from "@/lib/leads/agent-stage-sync";
import { mirrorLeadStageToCrm, MIRROR_WARN_ONLY } from "@/lib/agent-engine/edge/crm/move-lead-stage";

/** Um pipeline de clínica: avaliação, procedimento e a etapa de PERDA. */
function funilDaClinica(over: Partial<EstagioCandidato> = {}): EstagioCandidato[] {
  return [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Avaliação", agent_stage_hint: "qualifying", is_archived: false, is_lost: false },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Procedimento", agent_stage_hint: "negotiating", is_archived: false, is_lost: false },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Perdido", agent_stage_hint: "lost", is_archived: false, is_lost: true },
    ...(over ? [over as EstagioCandidato] : []),
  ];
}

describe("o resolvedor do agente e a etapa de perda (#917)", () => {
  it("etapa de perda: NÃO move — o card fica onde está e o motivo é do humano", () => {
    const destino = resolveDestinoDoAgente(
      funilDaClinica(),
      "lost",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(destino).toEqual({ move: false, motivo: "perda_sem_motivo", passo: "lost" });
  });

  it("etapa COMUM continua movendo (a recusa não virou bloqueio geral)", () => {
    const destino = resolveDestinoDoAgente(
      funilDaClinica(),
      "negotiating",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(destino).toEqual({
      move: true,
      stageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      stageName: "Procedimento",
    });
  });

  it("é a COLUNA do banco que decide, nunca o nome da etapa", () => {
    // Mesmo nome "Perdido", `is_lost` falso: etapa comum do tenant que se chama
    // assim por razões dele. Recusar pelo nome pararia um movimento legítimo.
    const destino = resolveDestinoDoAgente(
      [
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          name: "Perdido",
          agent_stage_hint: "lost",
          is_archived: false,
          is_lost: false,
        },
      ],
      "lost",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(destino.move).toBe(true);
  });
});

describe("o espelho do funil traduz o não-movimento em AÇÃO para o humano (#917)", () => {
  const cfg = { supabase: {} as never } as never;

  it("`perda_sem_motivo` NÃO é warn-only — é o que faz o caller abrir o item de inbox", async () => {
    expect(MIRROR_WARN_ONLY.has("perda_sem_motivo" as never)).toBe(false);

    const sync = vi.fn(async () => ({ moveu: false as const, motivo: "perda_sem_motivo" as const }));
    const r = await mirrorLeadStageToCrm(
      {} as never,
      cfg,
      { tenantId: "org", leadId: "contato", toStage: "lost" as never },
      { sync: sync as never },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // O rótulo é ELE MESMO (traduzido da tabela do espelho, não o
    // `crm_error` de "motivo não traduzido: ..."), e o detalhe diz o que falta.
    expect(r.reason).toBe("perda_sem_motivo");
    expect(r.detail).toContain("motivo");
  });

  it("a recusa de negócio NÃO é incidente: não vira `crm_error`", async () => {
    const sync = vi.fn(async () => ({ moveu: false as const, motivo: "perda_sem_motivo" as const }));
    const r = await mirrorLeadStageToCrm(
      {} as never,
      cfg,
      { tenantId: "org", leadId: "contato", toStage: "lost" as never },
      { sync: sync as never },
    );
    expect(r.ok ? null : r.reason).not.toBe("crm_error");
    expect(r.ok ? null : r.reason).not.toBe("crm_unavailable");
  });
});

/**
 * O NEGÓCIO REABERTO QUE CONSERVA O MOTIVO ANTIGO.
 *
 * `fn_crm_lead_close_on_stage` devolve `status = 'open'` quando o card sai da
 * etapa de perda e NÃO limpa `lost_reason` (supabase/baseline.sql). O agente só
 * trabalha negócio ABERTO (`resolveActiveLeadForContact`) e só há UMA etapa de
 * perda por funil (`uniq_crm_stages_pipeline_lost`), então o único negócio com
 * motivo gravado que ele pode levar à etapa de perda é exatamente este: o que já
 * foi perdido uma vez, voltou, e agora se perde DE NOVO.
 *
 * Mover seria fechar a perda nova com a causa da perda velha — "preço", gravado
 * meses atrás — sem ninguém ter afirmado nada sobre esta. É o que o aviso da
 * Central diz que o assistente não faz ("o assistente não inventa uma"), por
 * outra porta. O caso passa por `sincronizaEstagioDoAgente`, que é quem lê a
 * linha do banco: prender só o resolvedor deixaria verde quem voltasse a
 * repassar o `lost_reason` lido.
 */
describe("o negócio reaberto que conserva o motivo antigo (#917)", () => {
  const LEAD_REABERTO = {
    id: "lead-reaberto",
    organization_id: "org-1",
    pipeline_id: "pipe-1",
    stage_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "open",
    lost_reason: "price",
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: null,
  };

  function adminFalso() {
    const escritas: string[] = [];
    const admin = {
      rpc: async () => ({ data: null, error: null }),
      from(tabela: string) {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = async () => ({ data: { name: "Avaliação" }, error: null });
        b.update = () => {
          escritas.push(`update ${tabela}`);
          return b;
        };
        b.insert = () => {
          escritas.push(`insert ${tabela}`);
          return b;
        };
        b.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(
            tabela === "crm_leads"
              ? { data: [LEAD_REABERTO], error: null }
              : { data: funilDaClinica(), error: null },
          ).then(ok, erro);
        return b;
      },
    };
    return { admin: admin as never, escritas };
  }

  it("a IA NÃO move — o motivo gravado é da perda ANTERIOR, e ninguém afirmou o desta", async () => {
    const { admin, escritas } = adminFalso();

    const r = await sincronizaEstagioDoAgente(admin, {
      organizationId: "org-1",
      contactId: "contato-1",
      passo: "lost",
    });

    expect(r).toMatchObject({ moveu: false, motivo: "perda_sem_motivo" });
    expect(escritas).toEqual([]);
  });
});

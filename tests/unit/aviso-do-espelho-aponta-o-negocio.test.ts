/**
 * O aviso do espelho de etapa aponta para o NEGÓCIO, não para o contato.
 *
 * ═══ O DEFEITO ═══
 *
 * O funil do agente é por CONTATO: o `leadId` que o turno passa ao espelho é o
 * `contact_id` (o próprio `move-lead-stage.ts` diz isso). O aviso da Central era
 * gravado com `ref_kind = 'lead'` e esse mesmo id — e a Central resolve
 * `ref_kind = 'lead'` em `crm_leads` (`lib/ai/inbox-destino.ts`). Não achava a
 * linha e mostrava "Este contexto não está disponível para você", justamente no
 * aviso que manda o dono abrir o card e informar o motivo da perda. Medido numa
 * instalação real: 3 avisos "quis marcar um negócio como perdido", os 3 com
 * `ref_id` = id de `contacts` e nenhum com linha em `crm_leads`.
 *
 * O `sincronizaEstagioDoAgente` já devolvia o id do negócio que resolveu; o
 * espelho só o descartava. Aqui se prende o caminho inteiro: sync → espelho →
 * aviso, e a fiação no turno.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  abreAvisoDoEspelhoRecusado,
  mirrorLeadStageToCrm,
} from "@/lib/agent-engine/edge/crm/move-lead-stage";

const CONTATO = "contato-1";
const NEGOCIO = "negocio-1";
const cfg = { supabase: {} as never } as never;

function bancoQueRegistra() {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      chamadas.push({ sql, params });
      return { rows: [] };
    },
  };
  return { db: db as never, chamadas };
}

describe("o espelho devolve o negócio que o sync resolveu", () => {
  it("perda sem motivo: o resultado carrega o id do NEGÓCIO, não o do contato", async () => {
    const sync = vi.fn(async () => ({
      moveu: false as const,
      motivo: "perda_sem_motivo" as const,
      leadId: NEGOCIO,
    }));
    const r = await mirrorLeadStageToCrm(
      {} as never,
      cfg,
      { tenantId: "org-1", leadId: CONTATO, toStage: "lost" as never },
      { sync: sync as never },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.negocioId).toBe(NEGOCIO);
  });

  it("sem negócio resolvido (banco fora), não inventa um", async () => {
    const sync = vi.fn(async () => ({
      moveu: false as const,
      motivo: "indisponivel" as const,
      detalhe: "fetch failed",
    }));
    const r = await mirrorLeadStageToCrm(
      {} as never,
      cfg,
      { tenantId: "org-1", leadId: CONTATO, toStage: "lost" as never },
      { sync: sync as never },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.negocioId).toBeUndefined();
  });
});

describe("o aviso gravado referencia o negócio", () => {
  it("com o negócio resolvido, ref = ('lead', negócio)", async () => {
    const { db, chamadas } = bancoQueRegistra();
    await abreAvisoDoEspelhoRecusado(db, "org-1", {
      negocioId: NEGOCIO,
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: "Perdido",
    });
    expect(chamadas).toHaveLength(1);
    // Ordem dos parâmetros de `insertInboxItem`: org, kind, severity, title, body,
    // ref_kind, ref_id, "casa a ref?", "casa o título?".
    expect(chamadas[0]!.params.slice(5, 7)).toEqual(["lead", NEGOCIO]);
  });

  it("sem negócio, o aviso sai sem referência — nunca o contato rotulado de negócio", async () => {
    const { db, chamadas } = bancoQueRegistra();
    await abreAvisoDoEspelhoRecusado(db, "org-1", {
      motivo: "crm_unavailable",
      detalhe: "d",
      etapaDeDestino: "Perdido",
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.params.slice(5, 7)).toEqual([null, null]);
  });

  it("o caminho inteiro: o contato entra no espelho e o NEGÓCIO sai no aviso", async () => {
    const sync = vi.fn(async () => ({
      moveu: false as const,
      motivo: "perda_sem_motivo" as const,
      leadId: NEGOCIO,
    }));
    const mirror = await mirrorLeadStageToCrm(
      {} as never,
      cfg,
      { tenantId: "org-1", leadId: CONTATO, toStage: "lost" as never },
      { sync: sync as never },
    );
    if (mirror.ok) throw new Error("o espelho devia recusar");

    const { db, chamadas } = bancoQueRegistra();
    await abreAvisoDoEspelhoRecusado(db, "org-1", {
      ...(mirror.negocioId !== undefined ? { negocioId: mirror.negocioId } : {}),
      motivo: mirror.reason,
      detalhe: mirror.detail,
      etapaDeDestino: "lost",
    });
    expect(chamadas[0]!.params[6]).toBe(NEGOCIO);
    expect(chamadas[0]!.params).not.toContain(CONTATO);
  });
});

describe("a fiação no turno do agente", () => {
  it("o turno passa o negócio do espelho ao aviso, e não o `leadId` (contact_id)", () => {
    const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    const i = fonte.indexOf("await abreAvisoDoEspelhoRecusado(pool, tenantId, {");
    expect(i).toBeGreaterThan(-1);
    const chamada = fonte.slice(i, fonte.indexOf("});", i));
    expect(chamada).toMatch(/negocioId: mirror\.negocioId/);
    expect(chamada).not.toMatch(/^\s*leadId,?\s*$/m);
  });
});

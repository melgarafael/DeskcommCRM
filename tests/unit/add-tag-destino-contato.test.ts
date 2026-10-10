/**
 * O DESTINO OPCIONAL DA `add_tag` (#2498).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * A ação grava no LEAD sempre que o contexto traz um — e o Inbox consulta
 * etiquetas do CONTATO ou da conversa. A regra `lead.created` da issue marcava
 * o card, e a tela seguia mostrando a conversa sem marca nenhuma: duas fontes
 * de verdade para a mesma pergunta.
 *
 * ─── O que este arquivo trava ──────────────────────────────────────────────
 *
 * 1. `destino: "contato"` grava NO CONTATO — lendo as etiquetas ATUAIS dele no
 *    banco (não as do contexto, que o evento pode trazer velhas) e somando às
 *    existentes. Preservar é o ponto: um UPDATE que partisse de `[]` apagaria
 *    o vocabulário já construído pela operação.
 * 2. sem contato resolvível, a ação é IGNORADA (`skipped`/`no_contact`) — nunca
 *    troca de destino em silêncio para o card, que é o defeito espelhado.
 * 3. sem `destino` (regra antiga) o comportamento de HOJE continua byte a
 *    byte: lead manda, evento é `lead.tag_added`, e nenhuma leitura nasce na
 *    conta — é o controle que impede a feature de ser uma regressão.
 * 4. o schema da regra GUARDA o destino (sem a chave, o editor gravaria e o
 *    zod descartaria o campo no save, e a tela mentiria sobre o que está salvo).
 *
 * A autorização da IA, as mensagens e os gatilhos ficam fora do alcance: nada
 * aqui mexe em `emit_event` além do tipo/entidade do próprio alvo, e o
 * `caused_by_rule` anti-loop continua sendo o mesmo.
 */
import { describe, expect, it, vi } from "vitest";

// A origem do serviço leria o banco num client dublado; aqui não é o sob teste.
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: async () => null,
}));

import { actionSchema } from "@/lib/schemas/webhooks";
import { getAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import type { EventRow } from "@/lib/event-log/dispatcher";

import "@/lib/automation/actions/add-tag";

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "1ea1-0000-0000-0000-000000000001";
const CONTATO = "c0c0c0c0-0000-0000-0000-000000000001";

type Registro = {
  tabela: string;
  payload?: Record<string, unknown>;
  filtros: Record<string, unknown>;
};

/** O suficiente do client admin para ler, atualizar e emitir — e para GRAVAR o que aconteceu. */
function adminFalso(contatoNoBanco: { id: string; tags?: string[] } | null) {
  const leituras: Registro[] = [];
  const atualizacoes: Registro[] = [];
  const eventos: Record<string, unknown>[] = [];
  const admin = {
    from(tabela: string) {
      let atual: Registro | null = null;
      const api: Record<string, unknown> = {};
      const mesmo = () => api;
      api.select = () => {
        atual = { tabela, filtros: {} };
        leituras.push(atual);
        return api;
      };
      api.update = (payload: Record<string, unknown>) => {
        atual = { tabela, payload, filtros: {} };
        atualizacoes.push(atual);
        return api;
      };
      api.eq = (coluna: string, valor: unknown) => {
        if (atual) atual.filtros[coluna] = valor;
        return api;
      };
      api.maybeSingle = async () => ({
        data: tabela === "contacts" ? contatoNoBanco : null,
        error: null,
      });
      // O `await` do UPDATE cai aqui: o builder do supabase é thenável.
      api.then = (ok: (valor: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
      return api;
    },
    rpc: async (_nome: string, args: Record<string, unknown>) => {
      eventos.push(args);
      return { error: null };
    },
  };
  return { admin, leituras, atualizacoes, eventos };
}

function contexto(opcoes: {
  lead?: { id: string; contact_id?: string; tags?: string[] } | undefined;
  contact?: { id: string; tags?: string[] } | undefined;
  contatoNoBanco?: { id: string; tags?: string[] } | null;
}) {
  const { admin, leituras, atualizacoes, eventos } = adminFalso(
    opcoes.contatoNoBanco ?? null,
  );
  const context: Record<string, unknown> = {};
  if (opcoes.lead !== undefined) context.lead = opcoes.lead;
  if (opcoes.contact !== undefined) context.contact = opcoes.contact;
  const ctx = {
    admin,
    organizationId: ORG,
    ruleId: "r0r0r0r0-0000-0000-0000-000000000001",
    ruleName: "Etiqueta de origem",
    event: {
      id: "7e7e7e7e-0000-0000-0000-000000000001",
      organization_id: ORG,
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    } as unknown as EventRow,
    context,
    requestId: "rule:r0r0r0r0-0000-0000-0000-000000000001",
  } as unknown as ActionCtx;
  return { ctx, leituras, atualizacoes, eventos };
}

const acao = () => getAction("add_tag")!;

describe("destino 'contato' — grava no contato, preservando as etiquetas atuais dele", () => {
  it("somando às etiquetas que o CONTATO JÁ tem no banco", async () => {
    const { ctx, leituras, atualizacoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      // O contexto traz etiqueta VELHA: provar que a leitura veio do banco é o
      // que separa "preserva as atuais" de "preserva as que o evento lembra".
      contact: { id: CONTATO, tags: ["desatualizada"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "contato" });

    expect(resultado.status).toBe("success");
    expect(atualizacoes).toHaveLength(1);
    const gravou = atualizacoes[0]!;
    expect(gravou.tabela).toBe("contacts");
    expect(gravou.payload?.tags).toEqual(["antiga", "nova"]);
    // Isolamento por organização na escrita, como a ação sempre fez.
    expect(gravou.filtros).toMatchObject({ id: CONTATO, organization_id: ORG });
    // E a leitura também: o contato é da MESMA organização, ou não é alvo.
    expect(leituras).toContainEqual({
      tabela: "contacts",
      filtros: { id: CONTATO, organization_id: ORG },
    });
    // O card não foi tocado — é justamente o que a issue pede para deixar de fazer.
    expect(atualizacoes.some((u) => u.tabela === "crm_leads")).toBe(false);
    expect(eventos[0]).toMatchObject({
      p_event_type: "contact.tag_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO,
      p_organization_id: ORG,
      p_payload: { added_tags: ["nova"], tags: ["antiga", "nova"] },
      p_metadata: { caused_by_rule: "r0r0r0r0-0000-0000-0000-000000000001" },
    });
  });

  it("repetindo a mesma etiqueta não duplica nem regrava à toa", async () => {
    const { ctx, atualizacoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["antiga"], destino: "contato" });

    expect(resultado.status).toBe("success");
    expect(resultado.detail).toMatchObject({ added: [] });
    expect(atualizacoes).toHaveLength(0);
    expect(eventos).toHaveLength(0);
  });

  it("sem contato resolvível a ação é IGNORADA — nunca troca de destino em silêncio", async () => {
    const { ctx, leituras, atualizacoes, eventos } = contexto({
      // Lead existe (é por isso que o destino foi pedido), mas não tem contato.
      lead: { id: LEAD, tags: ["do-card"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "contato" });

    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toMatchObject({ reason: "no_contact" });
    expect(atualizacoes).toHaveLength(0);
    expect(eventos).toHaveLength(0);
    // Sem contato não há o que ler: nenhuma consulta nasce na conta.
    expect(leituras).toHaveLength(0);
  });
});

describe("sem destino — o comportamento de HOJE, byte a byte", () => {
  it("regra antiga (só `tags`) continua marcando o CARD", async () => {
    const { ctx, leituras, atualizacoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      contact: { id: CONTATO, tags: ["antiga"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"] });

    expect(resultado.status).toBe("success");
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]!.tabela).toBe("crm_leads");
    expect(atualizacoes[0]!.payload?.tags).toEqual(["do-card", "nova"]);
    expect(atualizacoes[0]!.filtros).toMatchObject({ id: LEAD, organization_id: ORG });
    expect(eventos[0]).toMatchObject({
      p_event_type: "lead.tag_added",
      p_entity_kind: "crm_lead",
      p_entity_id: LEAD,
    });
    // O default NÃO nasce com leitura nenhuma: é o caminho de sempre, sem
    // consulta nova por conta da feature.
    expect(leituras).toHaveLength(0);
  });

  it("`destino: \"card\"` explícito é o mesmo caminho do default", async () => {
    const { ctx, atualizacoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "card" });

    expect(resultado.status).toBe("success");
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]!.tabela).toBe("crm_leads");
    expect(eventos[0]).toMatchObject({ p_event_type: "lead.tag_added" });
  });

  it("sem lead e sem contato continua sendo `no_target` (nada mudou por lá)", async () => {
    const { ctx, atualizacoes } = contexto({});

    const resultado = await acao().execute(ctx, { tags: ["nova"] });

    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toMatchObject({ reason: "no_target" });
    expect(atualizacoes).toHaveLength(0);
  });
});

describe("o schema da regra guarda o destino", () => {
  it("`destino: \"contato\"` sobrevive ao parse do save", () => {
    const puro = actionSchema.parse({ type: "add_tag", config: { tags: ["x"], destino: "contato" } });
    // Sem tipar `puro.config.destino`: o TIPO do add_tag é o de antes, e é o
    // parse (e não o compilador) que decide o que a rota grava.
    expect((puro.config as Record<string, unknown>).destino).toBe("contato");
  });

  it("regra sem destino continua válida e continua SEM a chave nova", () => {
    const velho = actionSchema.parse({ type: "add_tag", config: { tags: ["x"] } });
    expect((velho.config as Record<string, unknown>).destino).toBeUndefined();
  });

  it("destino fora do enum é RECUSADO — não vira card em silêncio", () => {
    expect(() =>
      actionSchema.parse({ type: "add_tag", config: { tags: ["x"], destino: "coluna" } }),
    ).toThrow();
  });
});

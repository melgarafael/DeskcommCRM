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
 * 1. `destino: "contato"` grava NO CONTATO — somando às etiquetas ATUAIS dele no
 *    banco (não às do contexto, que o evento pode trazer velhas). Preservar é o
 *    ponto: uma gravação que partisse de `[]` apagaria o vocabulário já
 *    construído pela operação.
 * 2. sem contato resolvível, a ação é IGNORADA (`skipped`/`no_contact`) — nunca
 *    troca de destino em silêncio para o card, que é o defeito espelhado.
 * 3. sem `destino` (regra antiga) o comportamento mantém o alvo: lead manda e o
 *    evento é `lead.tag_added`.
 * 4. o schema da regra GUARDA o destino (sem a chave, o editor gravaria e o
 *    zod descartaria o campo no save, e a tela mentiria sobre o que está salvo).
 *
 * ─── #2888 — o dublê acompanhou a troca de lado da junção ──────────────────
 *
 * Desde a 0682 quem junta é a função SQL, dentro do `UPDATE`. Aqui isso é o que
 * dá ainda mais força ao item 1: o dublê devolve o que o BANCO tem (["antiga"]),
 * não o que o contexto lembra (["desatualizada"]) — se a ação voltasse a montar
 * a lista em memória, as etiquetas do banco sumiriam do que ela anuncia. A
 * corrida entre dois eventos DIFERENTES é medida com transações de verdade em
 * `tests/invariants/add-tag-concorrente-nao-apaga.test.ts`.
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

type Juncao = { rpc: string; args: Record<string, unknown> };

/**
 * O suficiente do client admin para JUNTAR e emitir — e para GRAVAR o que
 * aconteceu. `fn_*_adicionar_etiquetas` do dublê devolve a linha COMO O BANCO A
 * TEM, com o `except` do SQL (nada duplica) e o "nada entrou, nada grava".
 */
function adminFalso(
  contatoNoBanco: { id: string; tags?: string[] } | null,
  leadNoBanco: { id: string; tags?: string[] } | null,
) {
  const juncoes: Juncao[] = [];
  const eventos: Record<string, unknown>[] = [];
  const linhas: Record<string, string[]> = {};
  if (contatoNoBanco) linhas[contatoNoBanco.id] = contatoNoBanco.tags ?? [];
  if (leadNoBanco) linhas[leadNoBanco.id] = leadNoBanco.tags ?? [];

  const admin = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "emit_event") {
        eventos.push(args);
        return { data: null, error: null };
      }
      const daJuncao = nome === "fn_contato_adicionar_etiquetas" || nome === "fn_lead_adicionar_etiquetas";
      if (!daJuncao) throw new Error(`dublê: rpc desconhecida ${nome}`);
      juncoes.push({ rpc: nome, args });

      const id = String(nome === "fn_contato_adicionar_etiquetas" ? args.p_contato : args.p_lead);
      if (!(id in linhas)) return { data: null, error: null };
      const antes = linhas[id]!;
      const adicionadas = (args.p_etiquetas as string[]).filter((t) => !antes.includes(t));
      if (adicionadas.length) linhas[id] = [...antes, ...adicionadas];
      return { data: { tags: linhas[id]!, adicionadas }, error: null };
    },
  };
  return { admin, juncoes, eventos, linhas };
}

function contexto(opcoes: {
  lead?: { id: string; contact_id?: string; tags?: string[] } | undefined;
  contact?: { id: string; tags?: string[] } | undefined;
  contatoNoBanco?: { id: string; tags?: string[] } | null;
  leadNoBanco?: { id: string; tags?: string[] } | null;
}) {
  const { admin, juncoes, eventos, linhas } = adminFalso(
    opcoes.contatoNoBanco ?? null,
    opcoes.leadNoBanco ?? null,
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
  return { ctx, juncoes, eventos, linhas };
}

const acao = () => getAction("add_tag")!;

describe("destino 'contato' — grava no contato, preservando as etiquetas atuais dele", () => {
  it("somando às etiquetas que o CONTATO JÁ tem no banco", async () => {
    const { ctx, juncoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      // O contexto traz etiqueta VELHA: o que a função devolveu prova que a
      // junção aconteceu sobre o banco, e não sobre o que o evento lembra.
      contact: { id: CONTATO, tags: ["desatualizada"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "contato" });

    expect(resultado.status).toBe("success");
    expect(resultado.detail).toMatchObject({ added: ["nova"] });
    // A junção foi na tabela do CONTATO, com o filtro de organização na própria
    // instrução — é a função que garante as duas coisas.
    expect(juncoes).toHaveLength(1);
    expect(juncoes[0]).toMatchObject({
      rpc: "fn_contato_adicionar_etiquetas",
      args: { p_org: ORG, p_contato: CONTATO, p_etiquetas: ["nova"] },
    });
    // O card não foi tocado — é justamente o que a issue pede para deixar de fazer.
    expect(juncoes.some((j) => j.args.p_lead !== undefined)).toBe(false);
    expect(eventos[0]).toMatchObject({
      p_event_type: "contact.tag_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO,
      p_organization_id: ORG,
      // `tags` é o que o RETURNING devolveu; `added_tags`, o que ESTA chamada somou.
      p_payload: { added_tags: ["nova"], tags: ["antiga", "nova"] },
      p_metadata: { caused_by_rule: "r0r0r0r0-0000-0000-0000-000000000001" },
    });
  });

  it("repetindo a mesma etiqueta não duplica nem regrava à toa", async () => {
    const { ctx, eventos, linhas } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["do-card"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["antiga"], destino: "contato" });

    expect(resultado.status).toBe("success");
    expect(resultado.detail).toMatchObject({ added: [] });
    expect(linhas[CONTATO]).toEqual(["antiga"]);
    expect(eventos).toHaveLength(0);
  });

  it("sem contato resolvível a ação é IGNORADA — nunca troca de destino em silêncio", async () => {
    const { ctx, juncoes, eventos } = contexto({
      // Lead existe (é por isso que o destino foi pedido), mas não tem contato.
      lead: { id: LEAD, tags: ["do-card"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "contato" });

    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toMatchObject({ reason: "no_contact" });
    expect(eventos).toHaveLength(0);
    // Sem contato não há o que gravar: nenhuma instrução nasce na conta.
    expect(juncoes).toHaveLength(0);
  });
});

describe("sem destino — mantém o alvo card e preserva as etiquetas gravadas", () => {
  it("regra antiga (só `tags`) continua marcando o CARD", async () => {
    const { ctx, juncoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["contexto-antigo"] },
      leadNoBanco: { id: LEAD, tags: ["do-card"] },
      contact: { id: CONTATO, tags: ["antiga"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"] });

    expect(resultado.status).toBe("success");
    expect(juncoes).toHaveLength(1);
    expect(juncoes[0]).toMatchObject({
      rpc: "fn_lead_adicionar_etiquetas",
      args: { p_org: ORG, p_lead: LEAD, p_etiquetas: ["nova"] },
    });
    expect(eventos[0]).toMatchObject({
      p_event_type: "lead.tag_added",
      p_entity_kind: "crm_lead",
      p_entity_id: LEAD,
      p_payload: { added_tags: ["nova"], tags: ["do-card", "nova"] },
    });
  });

  it("`destino: \"card\"` explícito é o mesmo caminho do default", async () => {
    const { ctx, juncoes, eventos } = contexto({
      lead: { id: LEAD, contact_id: CONTATO, tags: ["contexto-antigo"] },
      leadNoBanco: { id: LEAD, tags: ["do-card"] },
      contatoNoBanco: { id: CONTATO, tags: ["antiga"] },
    });

    const resultado = await acao().execute(ctx, { tags: ["nova"], destino: "card" });

    expect(resultado.status).toBe("success");
    expect(juncoes[0]!.rpc).toBe("fn_lead_adicionar_etiquetas");
    expect(eventos[0]).toMatchObject({ p_event_type: "lead.tag_added" });
  });

  it("sem lead e sem contato continua sendo `no_target` (nada mudou por lá)", async () => {
    const { ctx, juncoes } = contexto({});

    const resultado = await acao().execute(ctx, { tags: ["nova"] });

    expect(resultado.status).toBe("skipped");
    expect(resultado.detail).toMatchObject({ reason: "no_target" });
    expect(juncoes).toHaveLength(0);
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

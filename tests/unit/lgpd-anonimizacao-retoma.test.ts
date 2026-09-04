/**
 * A CASCATA DE ANONIMIZAÇÃO RETOMA DE ONDE PAROU (issue #310).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 * `POST /api/v1/lgpd/anonymize` tem um early-return em `existing.is_anonymized`
 * (route.ts:75) que devolve `200 { action: "already_anonymized" }` ANTES de
 * tocar `crm_leads` (passo 2) e `crm_lead_activities` (passo 3).
 *
 * Se o passo 1 já rodou numa requisição que caiu no meio — timeout de cliente,
 * recompile do dev server, o contêiner reiniciado —, os passos 2 e 3 nunca mais
 * chegam a rodar. E não há como retomá-los: a MESMA checagem que decide "já foi
 * anonimizado" também decide "não faço mais nada". O botão da tela diz "já
 * anonimizado" e não faz nada.
 *
 * O contato fica com atividades e títulos de lead PERMANENTEMENTE não redigidos.
 * Isso é violação direta do direito do titular: a cascata promete remover PII de
 * `contacts` + `crm_leads` + `crm_lead_activities`, e entrega um terço.
 *
 * ─── Por que o conserto não é só "tirar o return" ───────────────────────────
 *
 * O passo 2 monta o título como `title.slice(0, 20) + " (anonimizado)"`. Rodar
 * de novo sobre um título JÁ redigido produziria
 * "Orçamento telhado (an (anonimizado)" e, na terceira, come o resto — o retry
 * que existe para curar estragaria. Por isso a retomada é IDEMPOTENTE: quem já
 * tem o sufixo é pulado.
 *
 * ─── A direção da falha, escolhida de propósito ─────────────────────────────
 *
 * Os passos 2 e 3 são best-effort (o erro vai para o log e não derruba). Isso
 * continua: falhar a requisição inteira porque uma lead resistiu deixaria o
 * CONTATO não anonimizado — o oposto do defeito, e pior, porque `contacts` é
 * onde mora o PII forte (nome, e-mail, telefone, CPF). O que muda é que agora
 * existe retomada, então o best-effort deixou de ser "uma chance só".
 *
 * ─── E por que a rota, sozinha, não fechava a issue ─────────────────────────
 *
 * A correção era INALCANÇÁVEL. `app/app/contacts/[id]/_client.tsx:197-208`
 * troca o botão "Anonimizar contato" por um parágrafo quando `is_anonymized` é
 * verdadeiro, e `setAnonOpen(true)` é o ÚNICO caminho para o diálogo em todo o
 * repositório: no estado exato que esta retomada conserta, **não existe botão**.
 *
 * Quem passou a alcançá-la é o cron diário de retenção (`varrerRedacoesIncompletas`),
 * porque a LGPD dá PRAZO — redact em D+15 — e um direito do titular não pode
 * depender de alguém lembrar de clicar. Os casos de varredura estão em
 * `tests/unit/lgpd-varredura-completa-a-cascata.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";

interface Escritas {
  contacts: Record<string, unknown>[];
  leads: Array<{ id: string; patch: Record<string, unknown> }>;
  atividades: Record<string, unknown>[];
}

let escrito: Escritas;

/**
 * Dublê do PostgREST com as linhas de verdade: as leads voltam do SELECT, e o
 * UPDATE de cada uma é registrado com o id. Um dublê que só contasse chamadas
 * não distinguiria "reescreveu a lead já redigida" de "pulou", que é metade do
 * conserto.
 */
function db(
  contato: Record<string, unknown>,
  leads: Array<{ id: string; title: string | null }>,
  atividades: Array<{ id: string; payload: unknown }> = [{ id: "atv-1", payload: { texto: "PII" } }],
) {
  const cliente = {
    from: (tabela: string) => ({
      select: () => {
        // O UPDATE só sai depois de o SELECT dizer o que existe, então o dublê
        // devolve as linhas de VERDADE por tabela. Um dublê que devolvesse a
        // mesma lista para todas não distinguiria "pulou a atividade já
        // redigida" de "reescreveu", que é metade do conserto.
        const filtros: Array<[string, string | boolean]> = [];
        const q: Record<string, unknown> = {
          eq: (col: string, val: string | boolean) => {
            filtros.push([col, val]);
            return q;
          },
          in: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: contato, error: null }),
          then: (r: (v: { data: unknown; error: null }) => unknown) => {
            const linhas =
              tabela === "crm_leads" ? leads : tabela === "crm_lead_activities" ? atividades : [];
            return Promise.resolve({ data: linhas, error: null }).then(r);
          },
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        // O registro acontece no `then`, não no `eq`: a cascata encadeia
        // `.eq(org).eq(id)`, e registrar por `eq` contaria a MESMA escrita duas
        // vezes — um dublê que mente para mais é tão ruim quanto um que mente
        // para menos.
        let alvo = "";
        const q: Record<string, unknown> = {
          eq: (col: string, val: string) => {
            if (col === "id" || col === "contact_id") alvo = val;
            return q;
          },
          in: (_col: string, vals: string[]) => {
            alvo = vals.join(",");
            return q;
          },
          then: (r: (v: unknown) => unknown) => {
            if (tabela === "contacts") escrito.contacts.push(patch);
            else if (tabela === "crm_leads") escrito.leads.push({ id: alvo, patch });
            else if (tabela === "crm_lead_activities") escrito.atividades.push({ ...patch, alvo });
            return Promise.resolve({ error: null }).then(r);
          },
        };
        return q;
      },
    }),
    rpc: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }),
    // A rota valida o JWT no backend com `getUser()` (nunca `getSession()`), e
    // é a primeira coisa que ela faz.
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
  };
  vi.mocked(createClient).mockResolvedValue(cliente as never);
}

function contato(over: Record<string, unknown> = {}) {
  return {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    anonymized_at: null,
    ...over,
  };
}

async function anonimizar() {
  vi.mocked(requireRole).mockResolvedValue({ ok: true } as never);
  const { POST } = await import("@/app/api/v1/lgpd/anonymize/route");
  const req = new NextRequest("http://localhost/api/v1/lgpd/anonymize", {
    method: "POST",
    body: JSON.stringify({ contact_id: CONTATO, justification: "pedido do titular por e-mail" }),
    headers: { "content-type": "application/json" },
  });
  const res = await POST(req);
  return { status: res.status, corpo: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  escrito = { contacts: [], leads: [], atividades: [] };
});

describe("cascata de anonimização — retomada", () => {
  it("⭐ contato JÁ anonimizado com lead pendente: a cascata roda o que faltou", async () => {
    // O estado real depois de uma requisição que caiu entre o passo 1 e o 2.
    db(contato({ is_anonymized: true, anonymized_at: "2026-08-01T10:00:00.000Z" }), [
      { id: "lead-pendente", title: "Orçamento telhado do cliente" },
    ]);

    const r = await anonimizar();

    expect(r.status).toBe(200);
    expect(
      escrito.leads.map((l) => l.id),
      "a lead do contato anonimizado continua com o título original — PII que a cascata prometeu remover",
    ).toContain("lead-pendente");
    expect(
      escrito.atividades.length,
      "as atividades do contato continuam não redigidas",
    ).toBeGreaterThan(0);
    expect(escrito.atividades[0]).toMatchObject({ payload: { redacted: true } });
    // O passo 1 NÃO se repete: reescrever `anonymized_at` apagaria a data real
    // do exercício do direito, que é o que responde ao prazo legal.
    expect(escrito.contacts, "reescreveu contacts numa retomada").toEqual([]);
    // NÃO é `already_anonymized`: a redação pendente acabou de acontecer, e
    // dizer "já estava anonimizado" é exatamente a frase que descreve o DEFEITO
    // — era o que o diálogo mostrava (AnonymizeDialog.tsx:46) no único momento
    // em que houve trabalho.
    expect(r.corpo.data.action).toBe("resumed");
  });

  it("retomada SEM resíduo continua dizendo que nada faltava", async () => {
    db(
      contato({ is_anonymized: true }),
      [{ id: "lead-ja-feita", title: "Orçamento (anonimizado)" }],
      [{ id: "atv-ja-feita", payload: { redacted: true } }],
    );

    const r = await anonimizar();

    // A distinção só vale se ela discrimina: se todo caminho devolvesse
    // "resumed", o desfecho novo seria decoração.
    expect(r.corpo.data.action).toBe("already_anonymized");
    expect(escrito.leads).toEqual([]);
    expect(escrito.atividades, "reescreveu atividade já redigida").toEqual([]);
  });

  it("⭐ a auditoria lista as tabelas que foram REALMENTE tocadas", async () => {
    // Era o literal ["contacts","crm_leads","crm_lead_activities"]. Numa
    // retomada `contacts` não é tocada; e se nada faltasse, a linha afirmaria
    // ter redigido as três tendo redigido nenhuma.
    db(
      contato({ is_anonymized: true }),
      [{ id: "lead-ja-feita", title: "Orçamento (anonimizado)" }],
      [{ id: "atv-ja-feita", payload: { redacted: true } }],
    );

    await anonimizar();

    const linha = vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; metadata: Record<string, unknown> })
      .find((c) => c.action === "lgpd.anonymize_catchup");
    expect(linha, "a retomada não auditou").toBeDefined();
    expect(
      linha!.metadata.redacted_tables,
      "afirmou ter redigido tabelas que não tocou — sucesso declarado sobre trabalho não feito",
    ).toEqual([]);
  });

  it("⭐ rodar duas vezes não come o título: quem já tem o sufixo é pulado", async () => {
    db(contato({ is_anonymized: true }), [
      { id: "lead-ja-feita", title: "Orçamento telhado (anonimizado)" },
    ]);

    await anonimizar();

    expect(
      escrito.leads,
      'reescreveu uma lead já redigida — o retry produziria "... (an (anonimizado)"',
    ).toEqual([]);
  });

  it("a retomada deixa rastro próprio, não se disfarça de primeira execução", async () => {
    db(contato({ is_anonymized: true }), [{ id: "lead-pendente", title: "Orçamento" }]);

    await anonimizar();

    const acoes = vi.mocked(audit).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acoes).toContain("lgpd.anonymize_catchup");
    expect(acoes, "uma retomada auditada como execução original mente sobre a data").not.toContain(
      "lgpd.anonymize_executed",
    );
  });

  it("primeira execução segue igual: os três passos, e o desfecho diz o que fez", async () => {
    db(contato(), [{ id: "lead-nova", title: "Orçamento telhado do cliente" }]);

    const r = await anonimizar();

    expect(escrito.contacts.length, "o passo 1 não rodou").toBe(1);
    expect(escrito.contacts[0]).toMatchObject({ is_anonymized: true, name: null });
    expect(escrito.leads.map((l) => l.id)).toContain("lead-nova");
    expect(escrito.atividades.length).toBeGreaterThan(0);
    // Hoje o caminho feliz OMITE `action`, e quem consome não distingue os dois
    // desfechos sem inspecionar o corpo inteiro.
    expect(r.corpo.data.action).toBe("anonymized");
  });

  it("contato sem lead pendente não inventa escrita", async () => {
    db(contato({ is_anonymized: true }), []);

    const r = await anonimizar();

    expect(r.status).toBe(200);
    expect(escrito.leads).toEqual([]);
  });
});

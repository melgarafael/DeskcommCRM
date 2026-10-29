// @vitest-environment node
/**
 * A VARREDURA QUE VENCE A PROPOSTA DO CARD EXISTE E RODA (#3316).
 *
 * ─── Por que este teste é o consumidor de expiração ────────────────────────
 *
 * No #3415, `lead_field_proposals.expires_at` era obrigatória e NINGUÉM a
 * cobrava em lote: a linha vencida ficava `pending` para sempre, continuava
 * bloqueando o índice único parcial e só sairia da tela pelo filtro de leitura
 * (que também não existia). Prazo que ninguém cobre é pior que prazo nenhum —
 * promete um limite que não existe.
 *
 * Aqui se prova o CONSUMIDOR: o cron horário que já vencia as propostas de dado
 * do contato passa a vencer as do card na MESMA varredura. O teste falha se:
 *   • a chamada a `vencePropostasDeCampo` sumir;
 *   • a segunda consulta (origs a partir de `lead_field_proposals`) sumir — a
 *     organização que só tem proposta do card deixaria de ser varrida;
 *   • a rota deixar de devolver a contagem própria (`lead_field_proposals_expired`),
 *     que é o que permite ver "a fila do card parou de vencer".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  vencidasNoCard: [] as string[],
  vencidasNoContato: [] as string[],
  /** As linhas que cada tabela devolve para "quem tem proposta vencida". */
  orgsPorTabela: {
    contact_field_proposals: [] as { organization_id: string }[],
    lead_field_proposals: [] as { organization_id: string }[],
  },
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: "contact_field_proposals" | "lead_field_proposals") => {
      const b = {
        select: () => b,
        eq: () => b,
        lt: () => b,
        then: (ok: (r: { data: unknown; error: null }) => unknown) =>
          Promise.resolve({ data: h.orgsPorTabela[tabela], error: null }).then(ok),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/contacts/proposta-de-dado", () => ({
  vencePropostasDeDado: async (_db: unknown, org: string) => {
    h.vencidasNoContato.push(org);
    return { vencidas: 0, itensDeCaixa: 0 };
  },
}));
vi.mock("@/lib/leads/proposta-de-campos-por-documento", () => ({
  vencePropostasDeCampo: async (_db: unknown, org: string) => {
    h.vencidasNoCard.push(org);
    return { vencidas: 1 };
  },
}));

import { GET } from "@/app/api/v1/cron/contact-proposals-watcher/route";

beforeEach(() => {
  h.vencidasNoCard = [];
  h.vencidasNoContato = [];
  h.orgsPorTabela = { contact_field_proposals: [], lead_field_proposals: [] };
});

describe("o cron vence a proposta de campo do CARD (#3316)", () => {
  it("⭐ organização que só tem proposta do CARD é varrida — e a contagem é própria", async () => {
    // Só a segunda fila tem vencida: sem a consulta a `lead_field_proposals`, a
    // org não entraria na lista e nada venceria.
    h.orgsPorTabela.lead_field_proposals = [{ organization_id: "org-do-card" }];

    const r = await GET(
      new NextRequest("http://localhost/api/v1/cron/contact-proposals-watcher", {
        headers: { authorization: "Bearer teste" },
      }),
    );
    const corpo = (await r.json()) as {
      data: { lead_field_proposals_expired: number; proposals_expired: number };
    };

    expect(r.status).toBe(200);
    expect(h.vencidasNoCard).toEqual(["org-do-card"]);
    expect(corpo.data.lead_field_proposals_expired).toBe(1);
    // Não somado à fila do contato: uma varredura que vence 0 de contato e 7 do
    // card tem de poder dizer isso, ou "a fila do card parou" parece normal.
    expect(corpo.data.proposals_expired).toBe(0);
  });

  it("as duas filas na MESMA passada, sem org repetida", async () => {
    h.orgsPorTabela.contact_field_proposals = [{ organization_id: "org-a" }];
    h.orgsPorTabela.lead_field_proposals = [
      { organization_id: "org-a" },
      { organization_id: "org-b" },
    ];

    await GET(new NextRequest("http://localhost/api/v1/cron/contact-proposals-watcher"));

    expect(h.vencidasNoContato.sort()).toEqual(["org-a", "org-b"]);
    expect(h.vencidasNoCard.sort()).toEqual(["org-a", "org-b"]);
  });
});

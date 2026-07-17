import { beforeAll, describe, expect, it } from "vitest";

import { columnExists, indexExists, seedGov } from "./gov-helpers";

/**
 * Eixo 7 — Tags (spec 13 §1; fase que fecha: G3).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "origem/categoria/
 * etiquetas ausentes ou não-filtráveis". Padrão do repo: tags text[] + GIN
 * (CLAUDE.md §Modelagem); alvo conversations.tags na spec 13 §3.
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 7 — tags", () => {
  it("contacts.tags e crm_leads.tags existem com índice GIN (padrão filtrável)", () => {
    expect(columnExists("contacts", "tags")).toBe(true);
    expect(columnExists("crm_leads", "tags")).toBe(true);
    expect(indexExists("idx_contacts_tags_gin")).toBe(true);
    expect(indexExists("idx_crm_leads_tags_gin")).toBe(true);
  });

  // GAP(G3): conversas não são etiquetáveis — conversations.tags text[]
  // (spec 13 §3, mesmo padrão de contacts/leads) não existe.
  it.fails("conversations.tags text[] existe (spec 13 §3)", () => {
    expect(columnExists("conversations", "tags")).toBe(true);
  });
});

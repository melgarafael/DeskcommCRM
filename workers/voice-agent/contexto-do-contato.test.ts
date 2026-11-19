import { describe, expect, it, vi } from "vitest";
import { carregarContextoDoContatoNaVoz } from "./contexto-do-contato";

function makeSupabaseMock(fixtures: {
  contato?: Record<string, unknown> | null;
  negocios?: Array<Record<string, unknown>>;
  compromissos?: Array<Record<string, unknown>>;
  conversa?: Record<string, unknown> | null;
  msgs?: Array<Record<string, unknown>>;
  throwOnContact?: boolean;
}) {
  const filtersSeen: Array<{ table: string; col: string; val: unknown }> = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (col: string, val: unknown) => {
      filtersSeen.push({ table, col, val });
      return chain;
    };
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(record);
    chain.in = vi.fn(record);
    chain.gte = vi.fn(record);
    chain.not = vi.fn(record);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => {
      if (table === "crm_leads") return Promise.resolve({ data: fixtures.negocios ?? [] });
      if (table === "calendar_appointments") return Promise.resolve({ data: fixtures.compromissos ?? [] });
      if (table === "messages") return Promise.resolve({ data: fixtures.msgs ?? [] });
      return chain;
    });
    chain.maybeSingle = vi.fn(() => {
      if (table === "contacts") {
        if (fixtures.throwOnContact) return Promise.reject(new Error("db down"));
        return Promise.resolve({ data: fixtures.contato ?? null });
      }
      if (table === "conversations") return Promise.resolve({ data: fixtures.conversa ?? null });
      return Promise.resolve({ data: null });
    });
    return chain;
  });

  return { supabase: { from } as never, filtersSeen };
}

describe("carregarContextoDoContatoNaVoz", () => {
  it("retorna vazio para contato anonimizado ou bloqueado", async () => {
    const anon = makeSupabaseMock({ contato: { name: "Maria", is_anonymized: true, is_blocked: false } });
    expect(
      await carregarContextoDoContatoNaVoz(anon.supabase, { organizationId: "org-1", contactId: "c-1" }),
    ).toBe("");

    const blocked = makeSupabaseMock({ contato: { name: "Maria", is_anonymized: false, is_blocked: true } });
    expect(
      await carregarContextoDoContatoNaVoz(blocked.supabase, { organizationId: "org-1", contactId: "c-1" }),
    ).toBe("");
  });

  it("falha aberto retornando string vazia em erro de banco", async () => {
    const { supabase } = makeSupabaseMock({ throwOnContact: true });
    expect(
      await carregarContextoDoContatoNaVoz(supabase, { organizationId: "org-1", contactId: "c-1" }),
    ).toBe("");
  });

  it("monta bloco com nome, negócio, agendamento, mensagens em ordem e filtra por organization_id", async () => {
    const { supabase, filtersSeen } = makeSupabaseMock({
      contato: {
        name: "João Silva",
        display_name: "João Silva",
        email: "joao@empresa.com.br",
        tags: ["vip", "clinica"],
        is_anonymized: false,
        is_blocked: false,
      },
      negocios: [{ title: "Automação Clínica Alfa" }],
      compromissos: [{ title: "Diagnóstico Operacional", starts_at: "2026-11-25T14:00:00Z", status: "confirmed" }],
      conversa: {
        id: "conv-1",
        channel: "whatsapp",
        status: "open",
        last_message_at: "2026-11-05T15:00:00Z",
      },
      msgs: [
        // vem DESC do banco
        { direction: "outbound", body: "Qual horário prefere?", created_at: "2026-11-05T15:00:00Z" },
        { direction: "inbound", body: "Quero automatizar o WhatsApp da clínica", created_at: "2026-11-05T14:58:00Z" },
      ],
    });

    const out = await carregarContextoDoContatoNaVoz(supabase, {
      organizationId: "org-1",
      contactId: "c-1",
    });

    expect(out).toContain("João Silva");
    expect(out).toContain("joao@empresa.com.br");
    expect(out).toContain("Automação Clínica Alfa");
    expect(out).toContain("Diagnóstico Operacional");
    expect(out).toContain("em aberto (não finalizada)");
    // Ordem cronológica na saída: inbound antes de outbound
    expect(out.indexOf("Cliente: Quero automatizar")).toBeLessThan(
      out.indexOf("Empresa: Qual horário prefere?"),
    );

    // Todas as tabelas consultadas receberam filtro de organization_id
    for (const table of ["contacts", "crm_leads", "calendar_appointments", "conversations", "messages"]) {
      expect(filtersSeen.some((f) => f.table === table && f.col === "organization_id" && f.val === "org-1")).toBe(
        true,
      );
    }
  });
});

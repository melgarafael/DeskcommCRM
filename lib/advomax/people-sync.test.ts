import { describe, expect, it, vi } from "vitest";

import { sincronizarClientesAdvomax } from "./people-sync";

function query(result: unknown) {
  const q: Record<string, any> = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    in: vi.fn(() => q),
    is: vi.fn(() => q),
    update: vi.fn((patch: unknown) => { q.patch = patch; return q; }),
    insert: vi.fn((payload: unknown) => { q.payload = payload; return q; }),
    single: vi.fn(async () => ({ data: q.singleResult ?? result, error: null })),
    maybeSingle: vi.fn(async () => ({ data: result, error: null })),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return q;
}

function fixture(options: {
  links?: unknown[];
  linkedContacts?: unknown[];
  inserted?: unknown;
} = {}) {
  const linkRead = query({ data: options.links ?? [], error: null });
  const linkWrite = query({ data: null, error: null });
  const contactReadByPhone = query({ data: [], error: null });
  const contactReadByLink = query({ data: options.linkedContacts ?? [], error: null });
  const contactWrite = query({ data: options.inserted ?? { id: "created" }, error: null });
  contactReadByPhone.insert.mockImplementation((payload: unknown) => {
    contactReadByPhone.payload = payload;
    contactReadByPhone.singleResult = options.inserted ?? { id: "created" };
    return contactReadByPhone;
  });
  const calls: Array<{ table: string; query: Record<string, any> }> = [];
  const admin = {
    from: vi.fn((table: string) => {
      const q = table === "advomax_contact_links"
        ? (calls.some((call) => call.table === table) ? linkWrite : linkRead)
        : (calls.some((call) => call.table === table) ? contactReadByLink : contactReadByPhone);
      calls.push({ table, query: q });
      return q;
    }),
  };
  // The test only needs one contact write after the read queries.
  admin.from.mockImplementation((table: string) => {
    if (table === "advomax_contact_links") {
      const q = calls.filter((call) => call.table === table).length === 0 ? linkRead : linkWrite;
      calls.push({ table, query: q });
      return q;
    }
    const contactCalls = calls.filter((call) => call.table === table).length;
    const q = contactCalls === 0 ? contactReadByPhone : contactCalls === 1 ? contactReadByLink : contactWrite;
    calls.push({ table, query: q });
    return q;
  });
  return { admin, calls, contactReadByPhone, contactReadByLink, contactWrite };
}

describe("sincronizarClientesAdvomax", () => {
  it("atualiza nome, telefone e e-mail de contato importado pelo Advomax", async () => {
    const f = fixture({
      links: [{ pessoa_codigo: 7, contact_id: "contact-7", status: "linked" }],
      linkedContacts: [{
        id: "contact-7", name: "Nome antigo", display_name: "Nome antigo", email: "old@example.com",
        phone_number: "+5585999990000", source: "advomax", source_metadata: { advomax_pessoa_codigo: 7 }, is_anonymized: false,
      }],
    });

    const result = await sincronizarClientesAdvomax(f.admin as never, "org-1", "user-1", [{
      codigo: 7, nome: "Nome atualizado", telefone: "85988887777", email: "new@example.com", cliente: true,
    }]);

    expect(result).toMatchObject({ encontrados: 1, atualizados: 1, conflitos: 0 });
    expect(f.contactWrite.update).toHaveBeenCalledWith(expect.objectContaining({
      name: "Nome atualizado", display_name: "Nome atualizado", phone_number: "+5585988887777", email: "new@example.com",
    }));
  });

  it("não sobrescreve contato manual apenas porque existe um vínculo", async () => {
    const f = fixture({
      links: [{ pessoa_codigo: 8, contact_id: "contact-8", status: "linked" }],
      linkedContacts: [{
        id: "contact-8", name: "Nome escolhido no CRM", display_name: "Nome escolhido no CRM", email: "local@example.com",
        phone_number: "+5585999990000", source: "manual", source_metadata: {}, is_anonymized: false,
      }],
    });

    const result = await sincronizarClientesAdvomax(f.admin as never, "org-1", "user-1", [{
      codigo: 8, nome: "Nome do Gestão", telefone: "85988887777", email: "gestao@example.com", cliente: true,
    }]);

    expect(result).toMatchObject({ encontrados: 1, atualizados: 0, ignorados: 1 });
    expect(f.contactWrite.update).not.toHaveBeenCalled();
  });

  it("importa cliente sem telefone e deixa o campo nulo", async () => {
    const f = fixture({ inserted: { id: "contact-9" } });
    const result = await sincronizarClientesAdvomax(f.admin as never, "org-1", "user-1", [{
      codigo: 9, nome: "Cliente sem telefone", telefone: null, email: null, cliente: true,
    }]);

    expect(result).toMatchObject({ encontrados: 1, criados: 1, vinculados: 1 });
    expect(f.contactReadByPhone.insert).toHaveBeenCalledWith(expect.objectContaining({ phone_number: null }));
  });
});

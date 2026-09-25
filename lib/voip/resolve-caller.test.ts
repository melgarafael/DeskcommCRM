import { describe, expect, it } from "vitest";

import { resolveOrCreateCallerContact } from "./resolve-caller";

/**
 * Mock mínimo do client Supabase para os dois caminhos que este módulo usa:
 * `contacts.select(...).eq(...).in(...).is(...).limit(...)` (via
 * `encontrarContatoPorTelefone`) e `contacts.insert(...).select(...).single()`.
 */
function fakeSupabase(opts: {
  existente?: { id: string; phone_number: string } | null;
  insertResult?: { data?: Record<string, unknown> | null; error?: { code: string; message: string } | null };
}) {
  const selectChain = {
    eq: () => selectChain,
    in: () => selectChain,
    is: () => selectChain,
    limit: () => Promise.resolve({ data: opts.existente ? [opts.existente] : [] }),
  };
  const insertChain = {
    select: () => ({
      single: () => Promise.resolve(opts.insertResult ?? { data: { id: "novo-id" }, error: null }),
    }),
  };
  return {
    from: () => ({
      select: () => selectChain,
      insert: () => insertChain,
    }),
  };
}

describe("resolveOrCreateCallerContact", () => {
  it("número inválido/vazio não bate contato nem cria nada", async () => {
    const supabase = fakeSupabase({});
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "");
    expect(result).toBeNull();
  });

  it("acha contato existente pelo número, sem criar um novo", async () => {
    const supabase = fakeSupabase({ existente: { id: "contato-1", phone_number: "+5532984793302" } });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toBe("contato-1");
  });

  it("cria contato novo com source voip quando o número não bate com nenhum", async () => {
    const supabase = fakeSupabase({ existente: null, insertResult: { data: { id: "contato-novo" }, error: null } });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toBe("contato-novo");
  });

  it("corrida (23505) cai de volta pro lookup em vez de propagar o erro", async () => {
    let lookups = 0;
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => ({
              is: () => ({
                limit: () => {
                  lookups++;
                  // primeira busca: ninguém ainda. segunda (pós-corrida): já existe.
                  return Promise.resolve(
                    lookups === 1 ? { data: [] } : { data: [{ id: "contato-da-corrida", phone_number: "+5532984793302" }] },
                  );
                },
              }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }),
          }),
        }),
      }),
    };

    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toBe("contato-da-corrida");
    expect(lookups).toBe(2);
  });
});

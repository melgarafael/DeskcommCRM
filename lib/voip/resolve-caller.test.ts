import { describe, expect, it } from "vitest";

import { resolveOrCreateCallerContact } from "./resolve-caller";

/**
 * Mock mínimo do client Supabase para os dois caminhos que este módulo usa:
 * `contacts.select(...).eq(...).in(...).is(...).limit(...)` (via
 * `encontrarContatoPorTelefoneComBloqueio`) e
 * `contacts.insert(...).select(...).single()`.
 */
function fakeSupabase(opts: {
  existente?: { id: string; phone_number: string; is_blocked?: boolean | null; is_personal?: boolean | null } | null;
  insertResult?: { data?: Record<string, unknown> | null; error?: { code: string; message: string } | null };
  /** Telefone EXTRA que casa o número: a ficha dona (`contact_phones`). */
  extra?: { contact_id: string } | null;
  /** A ficha dona, viva, com as colunas que a busca lê. */
  dona?: { id: string; phone_number?: string | null; is_blocked?: boolean | null; is_personal?: boolean | null } | null;
}) {
  // Cadeia da busca de contato: `in`/`is`/`limit` (principal) e `maybeSingle` (dona).
  const chainContatos = {
    eq: () => chainContatos,
    in: () => chainContatos,
    is: () => chainContatos,
    limit: () => Promise.resolve({ data: opts.existente ? [opts.existente] : [] }),
    maybeSingle: () => Promise.resolve({ data: opts.dona ?? null, error: null }),
  };
  // Cadeia do telefone extra: só `eq` e `maybeSingle`.
  const chainExtras = {
    eq: () => chainExtras,
    maybeSingle: () => Promise.resolve({ data: opts.extra ?? null, error: null }),
  };
  const insertChain = {
    select: () => ({
      single: () => Promise.resolve(opts.insertResult ?? { data: { id: "novo-id" }, error: null }),
    }),
  };
  return {
    from: (tabela: string) => ({
      select: () => (tabela === "contact_phones" ? chainExtras : chainContatos),
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
    expect(result).toEqual({ id: "contato-1", is_blocked: false, is_personal: false });
  });

  it("contato existente bloqueado viaja com is_blocked true", async () => {
    const supabase = fakeSupabase({
      existente: { id: "contato-bloq", phone_number: "+5532984793302", is_blocked: true },
    });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toEqual({ id: "contato-bloq", is_blocked: true, is_personal: false });
  });

  it("contato existente pessoal viaja com is_personal true (spec 21, etapa 14)", async () => {
    const supabase = fakeSupabase({
      existente: { id: "contato-pessoal", phone_number: "+5532984793302", is_personal: true },
    });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toEqual({ id: "contato-pessoal", is_blocked: false, is_personal: true });
  });

  it("cria contato novo com source voip quando o número não bate com nenhum (nasce desbloqueado)", async () => {
    const supabase = fakeSupabase({ existente: null, insertResult: { data: { id: "contato-novo" }, error: null } });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toEqual({ id: "contato-novo", is_blocked: false, is_personal: false });
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
            // Busca do telefone EXTRA (depois do principal): nenhum extra nesta corrida.
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
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
    expect(result).toEqual({ id: "contato-da-corrida", is_blocked: false, is_personal: false });
    expect(lookups).toBe(2);
  });

  it("ligação de número que é EXTRA de uma ficha: vai para a dona, sem criar contato", async () => {
    // Sem principal com o número, o extra acha a dona. As flags vêm da dona.
    const supabase = fakeSupabase({
      existente: null,
      extra: { contact_id: "dona-1" },
      dona: { id: "dona-1", phone_number: "+5531991112222", is_blocked: true, is_personal: false },
    });
    const result = await resolveOrCreateCallerContact(supabase as never, "org-1", "+5532984793302");
    expect(result).toEqual({ id: "dona-1", is_blocked: true, is_personal: false });
  });
  // Sabotagem: tirar o passo do extra em `buscarPorVariantes` cai no insert ("contato-novo"), e este caso fica vermelho.
});

import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolverContatoDoTeste } from "./contato-do-teste";

it.each(["outra_org", "bloqueado", "anonimizado", "grupo", "erro", "valido"])(
  "identidade do teste: %s",
  async (caso) => {
    const filtros: Record<string, string> = {};
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((k: string, v: string) => {
        filtros[k] = v;
        return query;
      }),
      maybeSingle: vi.fn(async () => ({
        data:
          caso === "outra_org"
            ? null
            : {
                id: "contato",
                name: "Teste",
                phone_number: "+5511999990000",
                is_blocked: caso === "bloqueado",
                is_anonymized: caso === "anonimizado",
                kind: caso === "grupo" ? "whatsapp_group" : "person",
              },
        error: caso === "erro" ? { code: "erro" } : null,
      })),
    };
    const db = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    const result = await resolverContatoDoTeste(db, "org-da-sessao", "contato");
    expect(filtros).toEqual({ organization_id: "org-da-sessao", id: "contato" });
    expect(result).toEqual(
      caso === "valido" ? { id: "contato", name: "Teste", phone_number: "+5511999990000" } : null,
    );
  },
);

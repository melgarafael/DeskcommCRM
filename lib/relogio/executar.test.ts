import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { TickDeps } from "@/lib/followup/engine";

import { aplicarRespostasQueChegaram } from "./executar";

/** Anota cada chamada como `tabela.metodo(args)`; `organizations` devolve a org parada. */
function bancoQueAnota(): { admin: SupabaseClient; chamadas: string[] } {
  const chamadas: string[] = [];
  const admin = {
    from(tabela: string) {
      const resposta =
        tabela === "organizations" ? { data: [{ id: "org-parada" }], error: null } : { data: [], error: null };
      const encadeia: object = new Proxy(
        {},
        {
          get(_alvo, metodo) {
            if (metodo === "then") {
              return (ok: (r: unknown) => unknown) => Promise.resolve(resposta).then(ok);
            }
            return (...args: unknown[]) => {
              chamadas.push(`${tabela}.${String(metodo)}(${args.map((a) => JSON.stringify(a)).join(",")})`);
              return encadeia;
            };
          },
        },
      );
      return encadeia;
    },
  } as unknown as SupabaseClient;
  return { admin, chamadas };
}

describe("relógio — respostas que chegaram", () => {
  it("a org parada fica fora da varredura de waiting_reply", async () => {
    const { admin, chamadas } = bancoQueAnota();
    await aplicarRespostasQueChegaram(admin, {} as TickDeps);
    expect(chamadas).toContain(`followup_enrollments.not("organization_id","in","(org-parada)")`);
  });
});

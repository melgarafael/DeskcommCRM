import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { TickDeps } from "@/lib/followup/engine";

import { aplicarRespostasQueChegaram } from "./executar";

type Linha = Record<string, unknown>;

/**
 * PostgREST em memória: `eq`/`in` sobre as colunas da linha e o `limit`, nesta
 * ordem — como o banco. `organizations.status` só corta quando o `select` embute
 * `organizations` com `!inner`. Anota cada chamada como `tabela.metodo(args)`.
 */
function bancoEmMemoria(enrollments: Linha[]): { admin: SupabaseClient; chamadas: string[] } {
  const chamadas: string[] = [];
  const admin = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      let limite = Infinity;
      let embuteOrgInner = false;
      const linhas = () =>
        (tabela === "followup_enrollments" ? enrollments : []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      const encadeia: object = new Proxy(
        {},
        {
          get(_alvo, metodo) {
            if (metodo === "then") {
              return (ok: (r: unknown) => unknown) => Promise.resolve({ data: linhas(), error: null }).then(ok);
            }
            if (metodo === "maybeSingle") return async () => ({ data: null, error: null });
            return (...args: unknown[]) => {
              chamadas.push(`${tabela}.${String(metodo)}(${args.map((a) => JSON.stringify(a)).join(",")})`);
              const [coluna, valor] = args as [string, unknown];
              if (metodo === "select" && /organizations[^,(]*!inner\(/.test(String(coluna))) embuteOrgInner = true;
              if (metodo === "limit") limite = coluna as unknown as number;
              if (metodo === "in") filtros.push((l) => !(coluna in l) || (valor as unknown[]).includes(l[coluna]));
              if (metodo === "eq" && coluna === "organizations.status") {
                if (embuteOrgInner) filtros.push((l) => (l.organizations as { status?: string }).status === valor);
              } else if (metodo === "eq") {
                filtros.push((l) => !(coluna in l) || l[coluna] === valor);
              }
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

const enrollment = (id: string, org: string, orgStatus: string): Linha => ({
  id,
  organization_id: org,
  contact_id: `contato-${id}`,
  status: "waiting_reply",
  organizations: { status: orgStatus },
});

describe("relógio — respostas que chegaram", () => {
  it("a org parada fica fora da varredura de waiting_reply, sem lista de ids na URL", async () => {
    const { admin, chamadas } = bancoEmMemoria([enrollment("e-parada", "org-parada", "suspended")]);
    await aplicarRespostasQueChegaram(admin, {} as TickDeps);
    expect(chamadas.some((c) => c.startsWith("organizations."))).toBe(false);
    expect(chamadas.some((c) => c.includes(".not("))).toBe(false);
    expect(chamadas.some((c) => c.startsWith("messages."))).toBe(false);
  });

  it("⭐ 40 enrollments de org parada à frente não tiram a vez da org operante (o corte é ANTES do limit)", async () => {
    const paradas = Array.from({ length: 40 }, (_, i) => enrollment(`e-parada-${i}`, "org-parada", "suspended"));
    const { admin, chamadas } = bancoEmMemoria([...paradas, enrollment("e-ativa", "org-operante", "active")]);
    await aplicarRespostasQueChegaram(admin, {} as TickDeps);
    // A operante chegou à leitura da resposta; a parada, nunca.
    expect(chamadas).toContain(`messages.eq("organization_id","org-operante")`);
    expect(chamadas).not.toContain(`messages.eq("organization_id","org-parada")`);
  });
});

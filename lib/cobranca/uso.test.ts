import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { bancoFalso, filtros } from "@/tests/helpers/banco-falso-da-cobranca";

import { excedenteDoPlano, lerUsoDaOrganizacao } from "./uso";

describe("excedenteDoPlano — quanto remover para caber (D-4)", () => {
  it.each([
    [{ assentos: 5, canais: 2 }, { max_assentos: 3, max_canais: 1 }, { assentos: 2, canais: 1 }],
    [{ assentos: 3, canais: 2 }, { max_assentos: 3, max_canais: 1 }, { canais: 1 }],
    [{ assentos: 9, canais: 9 }, { max_assentos: null, max_canais: null }, {}],
    [{ assentos: 0, canais: 0 }, { max_assentos: 1, max_canais: 1 }, {}],
  ])("uso %o no plano %o → %o", (uso, plano, esperado) => {
    expect(excedenteDoPlano(uso, plano)).toEqual(esperado);
  });
});

describe("lerUsoDaOrganizacao — a mesma contagem dos gatilhos de limite (spec §5)", () => {
  it("conta membro ativo não provisório e canal não arquivado que não é wacalls, só desta org", async () => {
    const b = bancoFalso((c) => ({ count: c.tabela === "user_organizations" ? 4 : 2 }));
    expect(await lerUsoDaOrganizacao(b.cliente as unknown as SupabaseClient, "org-1")).toEqual({ assentos: 4, canais: 2 });
    const membros = b.cadeias.find((c) => c.tabela === "user_organizations")!;
    expect(filtros(membros)).toEqual([
      ["eq", "organization_id", "org-1"],
      ["is", "revoked_at", null],
      ["eq", "provisional_until_handover", false],
    ]);
    const canais = b.cadeias.find((c) => c.tabela === "channel_sessions")!;
    expect(filtros(canais)).toEqual([
      ["eq", "organization_id", "org-1"],
      ["is", "archived_at", null],
      ["neq", "provider", "wacalls"],
    ]);
  });

  it("leitura que falha devolve null: quem chama responde 500, nunca 'cabe'", async () => {
    const b = bancoFalso((c) => (c.tabela === "channel_sessions" ? { error: { message: "boom" } } : { count: 1 }));
    expect(await lerUsoDaOrganizacao(b.cliente as unknown as SupabaseClient, "org-1")).toBeNull();
  });
});

/**
 * As duas réguas não podem divergir: se um predicado mudar num lado só, a tela
 * (e a troca de plano) diz "cabe" e o banco recusa com PT402, ou o contrário.
 * O caso acima fixa os filtros do app; este fixa os predicados dos gatilhos no
 * baseline que o kit aplica.
 */
describe("a contagem do app é a dos gatilhos", () => {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const corpo = (fn: string) => {
    const inicio = baseline.lastIndexOf(`create or replace function public.${fn}()`);
    expect(inicio, `${fn} sumiu do baseline`).toBeGreaterThan(-1);
    return baseline.slice(inicio, baseline.indexOf("$$;", inicio));
  };

  it("assentos: revoked_at nulo e não provisório", () => {
    const c = corpo("fn_trava_assentos_do_plano");
    expect(c).toContain("uo.revoked_at is null");
    expect(c).toContain("not uo.provisional_until_handover");
  });

  it("canais: não arquivado e não wacalls", () => {
    const c = corpo("fn_trava_canais_do_plano");
    expect(c).toContain("cs.archived_at is null");
    expect(c).toContain("cs.provider <> 'wacalls'");
  });
});

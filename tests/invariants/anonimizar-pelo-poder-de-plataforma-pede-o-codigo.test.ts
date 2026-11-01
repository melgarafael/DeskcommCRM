import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0747 — anonimizar um contato pelo PODER DE PLATAFORMA (quem não é
 * admin da organização do contato) pede o código provado NESTA sessão, a mesma
 * régua de `mfaEmDividaEstrita` no app.
 *
 * A 0747 faz `fn_session_mfa_proven` aceitar a sessão `aal1` reconhecida por um
 * dispositivo confiável. Isso vale na organização onde a pessoa é admin — o
 * dono da instalação segue usando a confiança na própria empresa —, e não nas
 * outras. Sem fator cadastrado, nada muda: a verificação é opcional.
 */
const PLAT = "dddddddd-0747-4000-8000-000000000001";
const SEM_FATOR = "dddddddd-0747-4000-8000-000000000002";
const FATOR = "dddddddd-0747-4000-8000-0000000000f1";
const SESSAO = "dddddddd-0747-4000-8000-0000000000a1";
const PROPRIA = "dddddddd-0747-4000-8000-0000000000b1";
const OUTRA = "dddddddd-0747-4000-8000-0000000000b2";
const CONTATO_PROPRIO = "dddddddd-0747-4000-8000-0000000000c1";
const CONTATO_DE_FORA = "dddddddd-0747-4000-8000-0000000000c2";

/**
 * Anonimiza como `usuario`, numa transação desfeita no fim: cada caso parte do
 * contato intacto. Devolve `already_anonymized` (`false` = anonimizou agora).
 */
function anonimizar(usuario: string, contato: string, org: string, aal: "aal1" | "aal2"): string | undefined {
  const claims = JSON.stringify({ sub: usuario, session_id: SESSAO, aal, role: "authenticated" });
  return sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    select 'R:' || (public.fn_lgpd_anonymize_contact('${org}', '${contato}') ->> 'already_anonymized');
    rollback;
  `)
    .split("\n")
    .find((l) => l.startsWith("R:"))
    ?.slice(2);
}

function confiar(on: boolean) {
  sql(`
    delete from public.mfa_trusted_devices where user_id = '${PLAT}';
    ${
      on
        ? `insert into public.mfa_trusted_devices (user_id, factor_id, token_hash, session_id, expires_at)
           values ('${PLAT}', '${FATOR}', md5(random()::text), '${SESSAO}', now() + interval '30 days');`
        : ""
    }
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${PLAT}', 'plataforma-0747@example.test'), ('${SEM_FATOR}', 'sem-fator-0747@example.test')
    on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, status, factor_type)
      values ('${FATOR}', '${PLAT}', 'verified', 'totp') on conflict (id) do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${PLAT}', '${PLAT}', 'full', false, 'invariante 0747'),
      ('${SEM_FATOR}', '${SEM_FATOR}', 'full', false, 'invariante 0747')
    on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${PROPRIA}', 'propria-0747', 'Própria 0747', 'Própria 0747'),
      ('${OUTRA}', 'outra-0747', 'Outra 0747', 'Outra 0747')
    on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${PLAT}', '${PROPRIA}', 'admin', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, name, display_name) values
      ('${CONTATO_PROPRIO}', '${PROPRIA}', 'Contato Próprio', 'Contato Próprio'),
      ('${CONTATO_DE_FORA}', '${OUTRA}', 'Contato de Fora', 'Contato de Fora')
    on conflict (id) do nothing;
  `);
});

describe("0747 — anonimizar pelo poder de plataforma pede o código provado na sessão", () => {
  it("CONTROLE: sem o código e sem dispositivo confiável, fora da própria organização, recusa", () => {
    confiar(false);
    expect(() => anonimizar(PLAT, CONTATO_DE_FORA, OUTRA, "aal1")).toThrow(/contact_anonymize_mfa_required/);
  });

  it("fora da própria organização, o dispositivo confiável não substitui o código", () => {
    confiar(true);
    expect(() => anonimizar(PLAT, CONTATO_DE_FORA, OUTRA, "aal1")).toThrow(/contact_anonymize_mfa_required/);
  });

  it("fora da própria organização, com o código provado nesta sessão, anonimiza", () => {
    confiar(true);
    expect(anonimizar(PLAT, CONTATO_DE_FORA, OUTRA, "aal2")).toBe("false");
  });

  it("na organização onde é admin, a sessão do dispositivo confiável anonimiza", () => {
    confiar(true);
    expect(anonimizar(PLAT, CONTATO_PROPRIO, PROPRIA, "aal1")).toBe("false");
  });

  it("sem fator cadastrado (verificação opcional), fora da própria organização, nada muda", () => {
    expect(anonimizar(SEM_FATOR, CONTATO_DE_FORA, OUTRA, "aal1")).toBe("false");
  });
});

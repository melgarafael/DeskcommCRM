import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import {
  chaveDeCobranca, comoServidor, criarOrg, criarPlano, criarUsuarios, erroDe, numero, tornarPlatformAdmin, uuid, valor,
} from "./cobranca-helpers";

/**
 * TESTE GRÁTIS NA CRIAÇÃO — invariante 7 da spec (§2.6, §7b), migration 0510.
 * A org que nasce pelo cadastro ganha `trial` com os dias do plano do cadastro
 * quando: a chave está ligada, existe plano do cadastro vigente, a org tem autor
 * e o autor não é platform admin ativo. O tenant criado pelo dono recebe o plano
 * explícito (`plano_id`) em fn_create_tenant_with_owner; com a chave desligada,
 * nada muda (settings.plan segue).
 */

const P = "c0b00006-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const chave = (n: number) => uuid(P, 500 + n);
const CLIENTE = uuid(P, 101);
const DONO = uuid(P, 102);
const SUPORTE = uuid(P, 103);
const EX_ADMIN = uuid(P, 104);
const PADRAO = uuid(P, 901);
const OUTRO = uuid(P, 902);
const ARQUIVADO = uuid(P, 903);
const HOJE = uuid(P, 904);

/** `estado|plano|dias de teste grátis`, ou `isenta`. */
function assinatura(orgId: string): string {
  return valor(`select coalesce((select estado || '|' || plano_id || '|' || round(extract(epoch from (trial_ate - created_at)) / 86400)
                  from public.cobranca_assinaturas where organization_id = '${orgId}'), 'isenta');`);
}

function tenant(n: number, extra: Record<string, string>): string {
  const corpo = JSON.stringify({
    display_name: `Cob Trial ${n}`, slug: `cob-trial-tenant-${n}`, owner_email: `dono-real-${n}-0510@invariant.test`, ...extra,
  });
  return `public.fn_create_tenant_with_owner('${DONO}', '${chave(n)}', '${corpo}'::jsonb, 'abcd')`;
}

function trocarPadrao(de: string, para: string): void {
  sql(`update public.cobranca_planos set padrao_no_cadastro = false where id = '${de}';
       update public.cobranca_planos set padrao_no_cadastro = true where id = '${para}';`);
}

beforeAll(() => {
  criarUsuarios([
    [CLIENTE, "cliente-trial-0510@invariant.test"],
    [DONO, "dono-trial-0510@invariant.test"],
    [SUPORTE, "suporte-trial-0510@invariant.test"],
    [EX_ADMIN, "ex-admin-trial-0510@invariant.test"],
  ]);
  tornarPlatformAdmin(DONO, "full", DONO);
  tornarPlatformAdmin(SUPORTE, "support_readonly", DONO);
  tornarPlatformAdmin(EX_ADMIN, "full", DONO);
  sql(`update public.platform_admins set revoked_at = now(), revoked_by = '${DONO}', revoke_reason = 'fixture 0510'
        where user_id = '${EX_ADMIN}';`);
  criarPlano({ id: PADRAO, nome: "Cadastro", trialDias: 7, padrao: true });
  criarPlano({ id: OUTRO, nome: "Escolhido pelo dono", trialDias: 30 });
  criarPlano({ id: ARQUIVADO, nome: "Arquivado", trialDias: 10 });
  criarPlano({ id: HOJE, nome: "Sem teste grátis", trialDias: 0 });
  sql(`update public.cobranca_planos set arquivado_em = now() where id = '${ARQUIVADO}';`);
});

describe("inv. 7 — teste grátis na criação da organização", () => {
  it("⭐ chave ligada + plano do cadastro: a org do cliente nasce em teste grátis com os dias do plano", () => {
    chaveDeCobranca("ligado");
    criarOrg(org(1), "cob-trial-1", CLIENTE);
    expect(assinatura(org(1))).toBe(`trial|${PADRAO}|7`);
  });

  it("org criada por platform admin ativo (full ou suporte) não ganha teste grátis; o revogado conta como cliente", () => {
    chaveDeCobranca("ligado");
    criarOrg(org(2), "cob-trial-2", DONO);
    criarOrg(org(3), "cob-trial-3", SUPORTE);
    criarOrg(org(4), "cob-trial-4", EX_ADMIN);
    expect(assinatura(org(2))).toBe("isenta");
    expect(assinatura(org(3))).toBe("isenta");
    expect(assinatura(org(4))).toBe(`trial|${PADRAO}|7`);
  });

  it("⭐ chave desligada ou ausente: nada nasce", () => {
    chaveDeCobranca("desligado");
    criarOrg(org(5), "cob-trial-5", CLIENTE);
    chaveDeCobranca("ausente");
    criarOrg(org(6), "cob-trial-6", CLIENTE);
    expect(assinatura(org(5))).toBe("isenta");
    expect(assinatura(org(6))).toBe("isenta");
  });

  it("sem plano do cadastro VIGENTE (só um arquivado), ou sem autor: nada nasce", () => {
    chaveDeCobranca("ligado");
    trocarPadrao(PADRAO, ARQUIVADO);
    try {
      criarOrg(org(7), "cob-trial-7", CLIENTE);
    } finally {
      trocarPadrao(ARQUIVADO, PADRAO);
    }
    criarOrg(org(8), "cob-trial-8", null);
    expect(assinatura(org(7))).toBe("isenta");
    expect(assinatura(org(8))).toBe("isenta");
  });

  it("plano do cadastro de 0 dias: nasce em trial já vencido (a régua da PR 3a cobra)", () => {
    chaveDeCobranca("ligado");
    trocarPadrao(PADRAO, HOJE);
    try {
      criarOrg(org(9), "cob-trial-9", CLIENTE);
    } finally {
      trocarPadrao(HOJE, PADRAO);
    }
    expect(assinatura(org(9))).toBe(`trial|${HOJE}|0`);
  });

  it("⭐ fn_create_tenant_with_owner com plano_id: teste grátis com o plano do formulário, mesmo o autor sendo o dono", () => {
    chaveDeCobranca("ligado");
    const id = valor(comoServidor(`select ${tenant(1, { plano_id: OUTRO })}->>'id'`));
    expect(assinatura(id)).toBe(`trial|${OUTRO}|30`);
    // Sem `plan` no pedido, nenhum rótulo antigo nasce (nem {"plan": null}).
    expect(valor(`select (settings ? 'plan')::text from public.organizations where id = '${id}';`)).toBe("false");
  });

  it("sem plano_id e chave ausente: settings.plan gravado como hoje e nenhuma assinatura", () => {
    chaveDeCobranca("ausente");
    const id = valor(comoServidor(`select ${tenant(2, { plan: "pro" })}->>'id'`));
    expect(valor(`select settings->>'plan' from public.organizations where id = '${id}';`)).toBe("pro");
    expect(assinatura(id)).toBe("isenta");
  });

  it("⭐ plano_id com a chave desligada é recusado, e nenhuma organização nasce", () => {
    chaveDeCobranca("desligado");
    const e = erroDe(comoServidor(`select ${tenant(3, { plano_id: OUTRO })}`));
    expect(e).toContain("22023");
    expect(e).toContain("cobranca_desligada");
    expect(numero(`select count(*) from public.organizations where slug = 'cob-trial-tenant-3';`)).toBe(0);
  });

  it("plano arquivado ou inexistente é recusado", () => {
    chaveDeCobranca("ligado");
    for (const [n, plano] of [[4, ARQUIVADO], [5, uuid(P, 999)]] as const) {
      const e = erroDe(comoServidor(`select ${tenant(n, { plano_id: plano })}`));
      expect(e, plano).toContain("plano_invalido");
      expect(numero(`select count(*) from public.organizations where slug = 'cob-trial-tenant-${n}';`)).toBe(0);
    }
  });

  it("replay idempotente com plano_id não cria segunda assinatura", () => {
    chaveDeCobranca("ligado");
    const primeira = JSON.parse(valor(comoServidor(`select ${tenant(6, { plano_id: OUTRO })}`))) as { id: string };
    const segunda = JSON.parse(valor(comoServidor(`select ${tenant(6, { plano_id: OUTRO })}`))) as { id: string; created: boolean };
    expect(segunda).toMatchObject({ id: primeira.id, created: false });
    expect(numero(`select count(*) from public.cobranca_assinaturas where organization_id = '${primeira.id}';`)).toBe(1);
  });

  it("a sessão não executa a função do gatilho", () => {
    expect(valor(`select has_function_privilege('anon', 'public.fn_trial_na_criacao_da_org()', 'EXECUTE')::text || '|' ||
                         has_function_privilege('authenticated', 'public.fn_trial_na_criacao_da_org()', 'EXECUTE')::text;`)).toBe("false|false");
  });
});

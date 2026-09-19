import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONTACT_2, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Issue #1248 — `public.fn_estampar_atribuicao_de_anuncio` é `security definer` e o
 * único limite era o `p_contact` que o CHAMADOR mandava: o `where` não filtrava
 * `organization_id`, então uma chamada de `service_role` com o contato de OUTRA
 * organização estampava o anúncio lá dentro — escrita cross-tenant por um caminho
 * que a RLS não vê, porque roda como definer.
 *
 * A migration 0344 exige a organização (`p_org`) e o `where` casa
 * `organization_id = p_org`. Este invariante prova as quatro coisas que fazem a
 * barreira valer:
 *
 *  1. a assinatura antiga de TRÊS argumentos NÃO existe mais no catálogo (sem
 *     isto, a chamada de três chaves resolveria na versão sem filtro);
 *  2. CONTROLE POSITIVO — com a organização CERTA, `service_role` estampa (se
 *     este caso ficar vermelho, o ingest de canal parou de gravar atribuição);
 *  3. a chamada com a organização ERRADA não escreve no contato da outra
 *     organização (zero linhas, sem erro levantado);
 *  4. o privilégio segue fechado: só `service_role` executa.
 */

/** Organização de OUTRA barba — o tenant de quem tenta escrever no contato alheio. */
const ORG_VIZINHA = "cccccccc-9999-4000-8000-000000000001";

/** O carimbo do anúncio no contato, ou AUSENTE. */
function marcador(contato: string): string {
  return lastLine(
    sql(
      `select coalesce(source_metadata->>'ad_platform', 'AUSENTE') from public.contacts where id = '${contato}';`,
    ),
  );
}

/** Chama a função como `service_role` (o único papel que pode executá-la). */
function comoServiceRole(org: string, contato: string): string {
  return sql(`
    set role service_role;
    select public.fn_estampar_atribuicao_de_anuncio(
      '${org}', '${contato}', 'meta_ads', '{"ad_platform":"meta_ads","ad_id":"120210000000000"}'::jsonb
    );
  `);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'gov-inv-vizinha', 'Gov Invariant Vizinha', 'Gov Vizinha')
      on conflict do nothing;
  `);
  // Reset determinístico: a suíte roda repetidas vezes sobre o MESMO banco, e a
  // guarda de primeiro-toque (`ad_platform is null`) faria a segunda rodada não
  // escrever nada — o teste passaria pelo motivo errado.
  sql(`
    update public.contacts
       set source = null,
           source_metadata = coalesce(source_metadata, '{}'::jsonb) - 'ad_platform'
     where id in ('${GOV_CONTACT_1}', '${GOV_CONTACT_2}');
  `);
});

describe("atribuição de anúncio não atravessa a organização", () => {
  it("sonda de catálogo: só a assinatura de quatro argumentos existe", () => {
    const assinaturas = lastLine(
      sql(`
        select count(*)
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'fn_estampar_atribuicao_de_anuncio';
      `),
    );
    expect(assinaturas).toBe("1");
  });

  it("CONTROLE POSITIVO: service_role estampa na PRÓPRIA organização", () => {
    comoServiceRole(GOV_ORG, GOV_CONTACT_2);
    expect(marcador(GOV_CONTACT_2)).toBe("meta_ads");
  });

  it("service_role com a organização ERRADA não escreve no contato da outra organização", () => {
    comoServiceRole(ORG_VIZINHA, GOV_CONTACT_1);
    expect(marcador(GOV_CONTACT_1)).toBe("AUSENTE");
  });

  it("o privilégio segue fechado: só service_role executa a assinatura nova", () => {
    const linha = lastLine(
      sql(`
        select has_function_privilege('service_role', 'public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb)', 'EXECUTE')
          || ',' ||
             has_function_privilege('anon', 'public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb)', 'EXECUTE')
          || ',' ||
             has_function_privilege('authenticated', 'public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb)', 'EXECUTE');
      `),
    );
    expect(linha).toBe("t,f,f");
  });
});

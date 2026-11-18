/**
 * O MOLDE DE IA DAS EMPRESAS NOVAS — contra o Postgres nascido do baseline (migration 9096).
 *
 * O dono da instalação escolhe uma empresa como molde
 * (`platform_settings.molde_de_ia_org_id`) e toda empresa que nasce depois
 * recebe, do gatilho `fn_molde_de_ia_na_org_nova` (AFTER INSERT) e do degrau
 * novo de `fn_seed_org_llm_defaults` (BEFORE INSERT), a escolha de modelo por
 * função do molde e o padrão dele.
 *
 * O que só o banco prova, e cada caso abaixo é um:
 *
 *  1. sem molde, NADA muda — o default nulo é o comportamento de antes;
 *  2. com molde, as funções vêm com `credential_id` NULO (a chave da
 *     instalação) e só as copiáveis: endpoint próprio, assinatura do ChatGPT,
 *     Jev e provedor sem chave da instalação ficam de fora;
 *  3. a lista de provedores copiados é EXATAMENTE `PROVEDORES_DO_MOLDE` — a
 *     mesma que a tela usa para mostrar o que vai ser copiado;
 *  4. o padrão (`settings.llm`) vem do molde, mas quem cria com um padrão
 *     explícito fica com o seu;
 *  5. nunca vai junto credencial, Jev, agente nem base de conhecimento;
 *  6. o efeito fica na auditoria DA EMPRESA NOVA, e só quando houve efeito;
 *  7. a cópia não toca nenhuma outra organização;
 *  8. molde excluído zera a coluna e criar empresa continua funcionando;
 *  9. os quatro caminhos de criação passam por aqui — o insert como o servidor
 *     faz (`service_role`) e a RPC `fn_create_tenant_with_owner`;
 * 10. as funções novas não são alcançáveis por `anon`/`authenticated`.
 *
 * Toda criação de empresa aqui é feita como `service_role`, que é o papel com
 * que o cadastro, o `bootstrap-owner` e as rotas de servidor inserem: um
 * gatilho que só funcionasse como `postgres` passaria verde e quebraria o
 * cadastro em produção.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PROVEDORES_DO_MOLDE } from "@/lib/ai/molde-de-ia";
import { IDS_COM_CHAVE, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

import { comoServidor, criarUsuarios, numero, tornarPlatformAdmin, uuid, valor } from "./cobranca-helpers";
import { sql } from "./gov-helpers";

const P = "a0de9096-0000-4000-8000";
const MOLDE = uuid(P, 1);
const OUTRA = uuid(P, 2);
const CRED = uuid(P, 3);
const DONO = uuid(P, 4);
const AGENTE = uuid(P, 5);
const MOLDE_VAZIO = uuid(P, 6);
let sequencia = 100;

/** A empresa nova, criada COMO O SERVIDOR CRIA (service_role), sem nada além do que o cadastro manda. */
function nascer(extraSettings?: Record<string, unknown>): string {
  const id = uuid(P, ++sequencia);
  const settings = extraSettings ? `'${JSON.stringify(extraSettings)}'::jsonb` : "'{}'::jsonb";
  sql(
    comoServidor(`insert into public.organizations (id, slug, legal_name, display_name, status, settings)
       values ('${id}', 'molde-nova-${sequencia}', 'Nova ${sequencia}', 'Nova ${sequencia}', 'active', ${settings})`),
  );
  return id;
}

function escolherMolde(org: string | null): void {
  sql(`insert into public.platform_settings (id, molde_de_ia_org_id) values (1, ${org ? `'${org}'` : "null"})
       on conflict (id) do update set molde_de_ia_org_id = excluded.molde_de_ia_org_id;`);
}

/** As funções de uma organização, uma por linha: purpose|provider|model_id|is_enabled|credencial nula|endereço nulo. */
function funcoes(org: string): string[] {
  const out = sql(`select purpose || '|' || provider || '|' || model_id || '|' || is_enabled
                          || '|' || (credential_id is null) || '|' || (base_url is null)
                     from public.ai_purpose_bindings where organization_id = '${org}' order by purpose;`);
  return out ? out.split("\n") : [];
}

function llm(org: string): string {
  return valor(`select coalesce(settings->'llm'->>'provider', '∅') || '|' || coalesce(settings->'llm'->>'default_model', '∅')
                  from public.organizations where id = '${org}';`);
}

function padraoDoProduto(): string {
  return valor(`select 'anthropic|' || coalesce((select model_id from public.ai_models
                   where provider = 'anthropic' and is_default_for_provider and deprecated_at is null limit 1),
                   'claude-sonnet-4-6');`);
}

function auditoriasDoMolde(org: string): number {
  return numero(`select count(*) from public.api_audit_log
                  where organization_id = '${org}' and action = 'ai.molde_de_ia_aplicado';`);
}

/** O retrato das funções de toda organização (menos `exceto`), para provar que a cópia não as toca. */
function retrato(exceto?: string): string {
  return valor(`select coalesce(md5(string_agg(organization_id || purpose || provider || model_id
                    || coalesce(credential_id::text, '') || coalesce(base_url, '') || is_enabled || updated_at,
                    ',' order by organization_id, purpose)), 'vazio')
                  from public.ai_purpose_bindings
                 where organization_id is distinct from ${exceto ? `'${exceto}'::uuid` : "null"};`);
}

/** O que a empresa nova deve receber do molde montado em `beforeEach` — e nada mais. */
const ESPERADO = [
  "compaction|openai|gpt-5.6-luna|true|true|true",
  "flush|openrouter|openai/gpt-5-mini|true|true|true",
  "sentiment_classify|anthropic|claude-haiku-5-5|false|true|true",
  "stage_classifier|anthropic|claude-haiku-4-5|true|true|true",
];

beforeAll(() => {
  criarUsuarios([[DONO, "dono-molde-9096@invariant.test"]]);
  tornarPlatformAdmin(DONO, "full", DONO);
});

beforeEach(() => {
  sql(`
    update public.platform_settings set molde_de_ia_org_id = null where id = 1;
    delete from public.ai_agents where id = '${AGENTE}';
    delete from public.ai_purpose_bindings where organization_id in ('${MOLDE}', '${OUTRA}', '${MOLDE_VAZIO}');
    delete from public.ai_provider_credentials where id = '${CRED}';
    insert into public.organizations (id, slug, legal_name, display_name, status, settings) values
      ('${MOLDE}', 'molde-9096', 'Molde LTDA', 'Molde', 'active',
        '{"llm": {"provider": "openai", "default_model": "gpt-5.6-luna", "enabled_models": ["gpt-5.6-luna"]},
          "jev": {"ligado": true, "aceite": true}}'::jsonb),
      ('${OUTRA}', 'outra-9096', 'Outra LTDA', 'Outra', 'active', '{}'::jsonb),
      ('${MOLDE_VAZIO}', 'molde-vazio-9096', 'Molde Vazio LTDA', 'Molde Vazio', 'active',
        '{"llm": {"provider": "google", "default_model": "gemini-2.5-flash"}}'::jsonb)
    on conflict (id) do update set settings = excluded.settings;
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, is_active, validated_at)
      values ('${CRED}', '${MOLDE}', 'openai', 'chave do molde', '\\x00', '\\x00', '\\x00', '1234', true, now());
    insert into public.ai_agents (id, organization_id, name, system_prompt) values
      ('${AGENTE}', '${MOLDE}', 'Agente do molde', 'prompt do molde');
    insert into public.ai_purpose_bindings (organization_id, purpose, provider, credential_id, model_id, base_url, is_enabled) values
      -- vão para a empresa nova
      ('${MOLDE}', 'stage_classifier',  'anthropic',  null,      'claude-haiku-4-5',   null, true),
      ('${MOLDE}', 'sentiment_classify','anthropic',  null,      'claude-haiku-5-5',   null, false),
      ('${MOLDE}', 'compaction',        'openai',     '${CRED}', 'gpt-5.6-luna',       null, true),
      ('${MOLDE}', 'flush',             'openrouter', null,      'openai/gpt-5-mini',  '  ', true),
      -- ficam de fora
      ('${MOLDE}', 'checkpoint',        'openai',     null,      'gpt-x',  'https://gw.exemplo.test/v1', true),
      ('${MOLDE}', 'visao_de_imagem',   'google',     null,      'gemini-2.5-flash',   null, true),
      ('${MOLDE}', 'followup_classify', '${PROVEDOR_POR_ASSINATURA}', null, 'gpt-5-codex', null, true),
      ('${MOLDE}', 'jailbreak_detect',  'typesafe',   null,      'jev-1',              null, true),
      ('${MOLDE}', 'embedding_indexar', 'deepseek',   null,      'deepseek-chat',      null, true),
      -- a OUTRA tem as suas, que a cópia não pode tocar
      ('${OUTRA}', 'stage_classifier',  'openai',     null,      'gpt-outra',          null, true),
      ('${MOLDE_VAZIO}', 'visao_de_imagem', 'google', null,      'gemini-2.5-flash',   null, true);
  `);
});

describe("molde de IA das empresas novas (9096)", () => {
  it("controle: o molde montado existe — sem ele, 'nada copiado' seria verdade vazia", () => {
    expect(numero(`select count(*) from public.ai_purpose_bindings where organization_id = '${MOLDE}';`)).toBe(9);
    expect(llm(MOLDE)).toBe("openai|gpt-5.6-luna");
  });

  it("⭐ sem molde (o default): a empresa nova nasce como antes — sem funções e com o padrão do produto", () => {
    const nova = nascer();
    expect(funcoes(nova)).toEqual([]);
    expect(llm(nova)).toBe(padraoDoProduto());
    expect(auditoriasDoMolde(nova)).toBe(0);
  });

  it("sem linha em platform_settings (instalação que nunca abriu a tela): também como antes", () => {
    sql(`delete from public.platform_settings where id = 1;`);
    const nova = nascer();
    expect(funcoes(nova)).toEqual([]);
    expect(llm(nova)).toBe(padraoDoProduto());
  });

  it("⭐ com molde: copia as funções copiáveis, todas com credential_id NULO e sem endereço", () => {
    escolherMolde(MOLDE);
    const nova = nascer();
    expect(funcoes(nova)).toEqual(ESPERADO);
  });

  it("⭐ com molde: o padrão da empresa nova (settings.llm) é o do molde — só provider e default_model", () => {
    escolherMolde(MOLDE);
    const nova = nascer();
    expect(llm(nova)).toBe("openai|gpt-5.6-luna");
    // `enabled_models` do molde é escolha dele, não vai junto.
    expect(valor(`select (settings->'llm' ? 'enabled_models')::text from public.organizations where id = '${nova}';`)).toBe(
      "false",
    );
  });

  it("endereço próprio, assinatura, Jev, Google e DeepSeek ficam de fora — nenhuma dessas funções existe na nova", () => {
    escolherMolde(MOLDE);
    const nova = nascer();
    expect(
      numero(`select count(*) from public.ai_purpose_bindings where organization_id = '${nova}'
                and purpose in ('checkpoint','visao_de_imagem','followup_classify','jailbreak_detect','embedding_indexar');`),
    ).toBe(0);
  });

  it("⭐ a lista de provedores copiados é EXATAMENTE PROVEDORES_DO_MOLDE (a mesma da tela)", () => {
    // Uma função-sonda por provedor que o sistema conhece, mais um inventado.
    const todos = [...new Set([...IDS_COM_CHAVE, PROVEDOR_POR_ASSINATURA, "inventado"])];
    sql(`insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id) values
         ${todos.map((p) => `('${MOLDE}', 'sonda_${p}', '${p}', 'modelo-${p}')`).join(",\n         ")};`);
    escolherMolde(MOLDE);
    const nova = nascer();
    const copiados = sql(`select provider from public.ai_purpose_bindings
                           where organization_id = '${nova}' and purpose like 'sonda\\_%' order by provider;`)
      .split("\n")
      .filter(Boolean);
    expect(copiados).toEqual([...PROVEDORES_DO_MOLDE].sort());
  });

  it("quem cria com um padrão explícito fica com o seu; as funções vêm do molde mesmo assim", () => {
    escolherMolde(MOLDE);
    const nova = nascer({ llm: { provider: "anthropic", default_model: "claude-escolhido" } });
    expect(llm(nova)).toBe("anthropic|claude-escolhido");
    expect(funcoes(nova)).toEqual(ESPERADO);
    expect(valor(`select (metadata->>'padrao_copiado') from public.api_audit_log
                   where organization_id = '${nova}' and action = 'ai.molde_de_ia_aplicado';`)).toBe("false");
  });

  it("⭐ nunca copia credencial, Jev, agente nem base de conhecimento", () => {
    escolherMolde(MOLDE);
    const nova = nascer();
    expect(numero(`select count(*) from public.ai_provider_credentials where organization_id = '${nova}';`)).toBe(0);
    expect(valor(`select (settings ? 'jev')::text from public.organizations where id = '${nova}';`)).toBe("false");
    expect(numero(`select count(*) from public.ai_agents where organization_id = '${nova}';`)).toBe(0);
    expect(numero(`select count(*) from public.ai_knowledge_sources where organization_id = '${nova}';`)).toBe(0);
  });

  it("⭐ o efeito fica na auditoria DA EMPRESA NOVA, com o molde e as contagens", () => {
    escolherMolde(MOLDE);
    const nova = nascer();
    expect(auditoriasDoMolde(nova)).toBe(1);
    const meta = JSON.parse(
      valor(`select metadata::text from public.api_audit_log
              where organization_id = '${nova}' and action = 'ai.molde_de_ia_aplicado';`),
    ) as Record<string, unknown>;
    expect(meta).toEqual({
      molde_org_id: MOLDE,
      funcoes_copiadas: 4,
      funcoes_deixadas: 5,
      padrao_copiado: true,
      padrao: { provider: "openai", default_model: "gpt-5.6-luna" },
    });
    // A linha é da empresa nova: o molde não ganha auditoria nenhuma por ter sido copiado.
    expect(auditoriasDoMolde(MOLDE)).toBe(0);
  });

  it("molde sem nada copiável: a empresa nasce como antes e NADA é auditado (rodada sem efeito)", () => {
    escolherMolde(MOLDE_VAZIO);
    const nova = nascer();
    expect(funcoes(nova)).toEqual([]);
    expect(llm(nova)).toBe(padraoDoProduto());
    expect(auditoriasDoMolde(nova)).toBe(0);
  });

  it("⭐ a cópia não toca nenhuma outra organização — nem o molde", () => {
    escolherMolde(MOLDE);
    const antes = retrato();
    const nova = nascer();
    expect(retrato(nova)).toBe(antes);
    expect(funcoes(OUTRA)).toEqual(["stage_classifier|openai|gpt-outra|true|true|true"]);
  });

  it("⭐ molde excluído: a coluna volta a nulo e criar empresa não falha", () => {
    const efemero = uuid(P, 7);
    sql(`insert into public.organizations (id, slug, legal_name, display_name, status, settings)
           values ('${efemero}', 'molde-efemero-9096', 'Efêmero', 'Efêmero', 'active',
                   '{"llm": {"provider": "openai", "default_model": "gpt-5.6-luna"}}'::jsonb);
         insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id)
           values ('${efemero}', 'compaction', 'openai', 'gpt-5.6-luna');`);
    escolherMolde(efemero);
    sql(`delete from public.organizations where id = '${efemero}';`);
    expect(valor(`select coalesce(molde_de_ia_org_id::text, 'nulo') from public.platform_settings where id = 1;`)).toBe(
      "nulo",
    );
    const nova = nascer();
    expect(funcoes(nova)).toEqual([]);
    expect(llm(nova)).toBe(padraoDoProduto());
  });

  it("⭐ o caminho de Painel › Empresas › Nova (fn_create_tenant_with_owner) também nasce do molde", () => {
    escolherMolde(MOLDE);
    const corpo = JSON.stringify({
      display_name: "Nova pela RPC",
      slug: "nova-pela-rpc-9096",
      owner_email: "dono-molde-9096@invariant.test",
    });
    const id = valor(
      comoServidor(
        `select public.fn_create_tenant_with_owner('${DONO}', '${uuid(P, 900)}', '${corpo}'::jsonb, 'abcd')->>'id'`,
      ),
    );
    expect(funcoes(id)).toEqual(ESPERADO);
    expect(llm(id)).toBe("openai|gpt-5.6-luna");
    expect(auditoriasDoMolde(id)).toBe(1);
  });

  it.each(["fn_llm_do_molde_de_ia", "fn_seed_org_llm_defaults", "fn_molde_de_ia_na_org_nova"])(
    "%s não é executável por anon nem authenticated (doutrina, item 9)",
    (fn) => {
      expect(
        valor(`select has_function_privilege('anon', 'public.${fn}()', 'EXECUTE')::text
                  || '|' || has_function_privilege('authenticated', 'public.${fn}()', 'EXECUTE')::text;`),
      ).toBe("false|false");
    },
  );

  it("a coluna do molde é FK para organizations com on delete set null (a garantia do caso do molde excluído)", () => {
    expect(
      valor(`select confdeltype::text from pg_constraint
              where conrelid = 'public.platform_settings'::regclass and contype = 'f'
                and conkey = array[(select attnum from pg_attribute
                                     where attrelid = 'public.platform_settings'::regclass
                                       and attname = 'molde_de_ia_org_id')]::int2[];`),
    ).toBe("n");
  });
});

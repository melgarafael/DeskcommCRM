/**
 * #3514 — a porteira da carteira quando quem chama é o SISTEMA.
 *
 * A passagem SDR → Closer move o negócio, o cliente e a conversa. O negócio já
 * era da ação; a conversa usa `fn_conversation_assign` sem mudança nenhuma; a
 * carteira precisava de uma porta e ela é a MESMA (`fn_definir_carteira_do_cliente`,
 * migration 9057 / apêndice do baseline) — com a regra que faltava: **quem não
 * tem ator é o sistema, e o sistema se identifica pela origem `automacao`.**
 *
 * Este arquivo prova as quatro pontas dessa bicondicional, porque errar
 * qualquer uma delas reabre um buraco fechado na 0622:
 *
 *   1. ator nulo + `automacao`  → grava (é a automação), e adota os negócios
 *      abertos sem dono na mesma transação;
 *   2. ator nulo + origem humana → `carteira_sem_ator` (42501): nada de gravar
 *      sem dizer quem foi;
 *   3. ator humano + `automacao` → `carteira_origem_invalida` (22023): a origem
 *      do sistema não é rótulo que uma pessoa escolhe para o próprio ato;
 *   4. a régua do DONO não afrouxa para a automação: `viewer` e revogado
 *      continuam recusados (`carteira_dono_invalido`), e contato de outra
 *      organização continua não sendo alcançável.
 *
 * 5. a passagem das CONVERSAS (`fn_passar_conversas_do_contato`, 9057): só as
 *    abertas que estão com OUTRA pessoa, a contagem é a das linhas que a
 *    atribuição gravou, é tudo ou nada, e só o service_role a executa. Com a
 *    carteira junto (#3642), toda conversa aberta com gente vai para o novo dono.
 *
 * Organização própria (namespace `35653565-`) para não encostar em `GOV_ORG`,
 * na `eeeeeeee-` da irmã `carteira-do-cliente.test.ts` nem na `ffffffff-` de
 * `o-numero-segue-o-vendedor`, `gov-5-visibility-scope` e `webhooks-rls`, que
 * rodam em paralelo no mesmo banco (esta suíte nasceu na `ffffffff-` e o
 * `afterAll` dela apagava a organização das outras).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "35653565-0000-4000-8000-000000000001";
const OUTRA_ORG = "35653565-0000-4000-8000-000000000002";
const CLOSER = "35653565-1111-4000-8000-000000000001"; // agent: o novo dono
const SDR = "35653565-1111-4000-8000-000000000002"; // agent: o dono de antes
const GESTOR = "35653565-1111-4000-8000-000000000003"; // manager, com ator
const SOMENTE_LEITURA = "35653565-1111-4000-8000-000000000004"; // viewer
const SAIU_DA_EQUIPE = "35653565-1111-4000-8000-000000000005"; // agent revogado
const PIPELINE = "35653565-5555-4000-8000-000000000001";
const ETAPA = "35653565-5555-4000-8000-000000000002";
const CONTATO = "35653565-3333-4000-8000-000000000001";
const CONTATO_DA_OUTRA_ORG = "35653565-3333-4000-8000-000000000002";
const CONTATO_DAS_CONVERSAS = "35653565-3333-4000-8000-000000000003";
// Um número por conversa: a 0027 permite UMA conversa por contato e número.
const NUMEROS = [1, 2, 3, 4, 5].map((n) => `35653565-2222-4000-8000-00000000000${n}`);
const CONVERSA_DO_SDR = "35653565-4444-4000-8000-000000000001";
const CONVERSA_DO_GESTOR = "35653565-4444-4000-8000-000000000002";
const CONVERSA_ENCERRADA = "35653565-4444-4000-8000-000000000003";
const CONVERSA_SEM_DONO = "35653565-4444-4000-8000-000000000004";
const CONVERSA_DO_CLOSER = "35653565-4444-4000-8000-000000000005";

/**
 * Chama a RPC como o MOTOR chama: `service_role`, sem ator humano, com a
 * origem declarada. Devolve o stderr quando a função recusa (psql com
 * ON_ERROR_STOP=1 aborta o script e o erro vem por aí).
 */
function chamaSemAtor(contato: string, dono: string, origem: string): string {
  try {
    sql(`
      set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', null, '${contato}', '${dono}', '${origem}');
    `);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

/** Chama a RPC como a ROTA chama: `service_role`, com o ator humano explícito. */
function chamaComAtor(ator: string, contato: string, dono: string, origem: string): string {
  try {
    sql(`
      set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', '${ator}', '${contato}', '${dono}', '${origem}');
    `);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

/** Uma linha só: dono | origem | data preenchida. É o retrato da carteira. */
function retratoDaCarteira(contato: string): string {
  return lastLine(
    sql(`
      select coalesce(carteira_user_id::text, 'NULL')
             || '|' || coalesce(carteira_origem, 'NULL')
             || '|' || (carteira_definida_em is not null)::text
        from public.contacts where id = '${contato}';
    `),
  );
}

function limpaCarteira(contato: string): void {
  sql(`update public.contacts
         set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null
       where id = '${contato}';`);
}

function semCarteira(): string {
  return "NULL|NULL|false";
}

/** As cinco conversas do contato, do jeito que cada caso começa. */
function conversasDoComeco(): void {
  sql(`
    delete from public.conversations where contact_id = '${CONTATO_DAS_CONVERSAS}';
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id)
    values
      ('${CONVERSA_DO_SDR}',    '${ORG}', '${CONTATO_DAS_CONVERSAS}', '${NUMEROS[0]}', 'claimed', '${SDR}'),
      ('${CONVERSA_DO_GESTOR}', '${ORG}', '${CONTATO_DAS_CONVERSAS}', '${NUMEROS[1]}', 'claimed', '${GESTOR}'),
      ('${CONVERSA_ENCERRADA}', '${ORG}', '${CONTATO_DAS_CONVERSAS}', '${NUMEROS[2]}', 'closed',  '${SDR}'),
      ('${CONVERSA_SEM_DONO}',  '${ORG}', '${CONTATO_DAS_CONVERSAS}', '${NUMEROS[3]}', 'open',    null),
      ('${CONVERSA_DO_CLOSER}', '${ORG}', '${CONTATO_DAS_CONVERSAS}', '${NUMEROS[4]}', 'claimed', '${CLOSER}');
  `);
}

/** `dono|status` de cada conversa, na ordem das constantes. */
function retratoDasConversas(): string[] {
  return [CONVERSA_DO_SDR, CONVERSA_DO_GESTOR, CONVERSA_ENCERRADA, CONVERSA_SEM_DONO, CONVERSA_DO_CLOSER].map((id) =>
    lastLine(
      sql(`select coalesce(assigned_to_user_id::text, 'NULL') || '|' || status
             from public.conversations where id = '${id}';`),
    ),
  );
}

function passaConversas(dono: string): string {
  try {
    return lastLine(
      sql(`
        set role service_role;
        select public.fn_passar_conversas_do_contato('${ORG}', '${CONTATO_DAS_CONVERSAS}', '${dono}');
      `),
    );
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

describe("carteira do cliente pela origem `automacao` (#3514)", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${CLOSER}', 'passagem-closer@invariant.test'),
        ('${SDR}', 'passagem-sdr@invariant.test'),
        ('${GESTOR}', 'passagem-gestor@invariant.test'),
        ('${SOMENTE_LEITURA}', 'passagem-viewer@invariant.test'),
        ('${SAIU_DA_EQUIPE}', 'passagem-revogado@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG}', 'passagem-inv', 'Passagem Invariant Org', 'Passagem Inv'),
        ('${OUTRA_ORG}', 'passagem-inv-2', 'Passagem Outra Org', 'Passagem Outra')
      on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${CLOSER}', '${ORG}', 'agent', now()),
        ('${SDR}', '${ORG}', 'agent', now()),
        ('${GESTOR}', '${ORG}', 'manager', now()),
        ('${SOMENTE_LEITURA}', '${ORG}', 'viewer', now()),
        ('${SAIU_DA_EQUIPE}', '${ORG}', 'agent', now())
      on conflict (user_id, organization_id) do nothing;
      -- Reexecução não herda papel/estado dos testes anteriores.
      update public.user_organizations set role = 'agent', revoked_at = null
        where organization_id = '${ORG}' and user_id in ('${CLOSER}', '${SDR}', '${SAIU_DA_EQUIPE}');
      update public.user_organizations set role = 'manager', revoked_at = null
        where organization_id = '${ORG}' and user_id = '${GESTOR}';
      update public.user_organizations set role = 'viewer', revoked_at = null
        where organization_id = '${ORG}' and user_id = '${SOMENTE_LEITURA}';
      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name)
      values ${NUMEROS.map((id, i) => `('${id}', '${ORG}', 'waha', 'passagem-inv-${i}', '\\x00'::bytea, 'WORKING', 'Passagem ${i}')`).join(",\n")}
      on conflict (id) do nothing;
      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO_DAS_CONVERSAS}', '${ORG}', 'Contato das Conversas'),
        ('${CONTATO}', '${ORG}', 'Contato da Passagem'),
        ('${CONTATO_DA_OUTRA_ORG}', '${OUTRA_ORG}', 'Contato de Outra Org')
      on conflict (id) do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE}', '${ORG}', 'Passagem Invariant', 'passagem-inv')
        on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Reunião agendada', 'reuniao', 9100)
        on conflict (id) do nothing;
    `);
    limpaCarteira(CONTATO);
  });

  afterAll(() => {
    sql(`
      delete from public.conversations where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.channel_sessions where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.crm_leads where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.user_organizations where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.crm_stages where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.crm_pipelines where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.contacts where organization_id in ('${ORG}', '${OUTRA_ORG}');
      delete from public.organizations where id in ('${ORG}', '${OUTRA_ORG}');
      delete from auth.users where id in
        ('${CLOSER}', '${SDR}', '${GESTOR}', '${SOMENTE_LEITURA}', '${SAIU_DA_EQUIPE}');
    `);
  });

  it("o vocabulário da CHECK aceita `automacao` e segue recusando nome inventado", () => {
    // O valor novo entra pela porta (se a CHECK não o conhecesse, este INSERT
    // morria com `contacts_carteira_origem_vocabulario`).
    sql(`update public.contacts
            set carteira_user_id = '${SDR}', carteira_origem = 'automacao', carteira_definida_em = now()
          where id = '${CONTATO}';`);
    expect(retratoDaCarteira(CONTATO)).toBe(`${SDR}|automacao|true`);

    let recusa = "";
    try {
      sql(`update public.contacts set carteira_origem = 'sistema'
            where id = '${CONTATO}';`);
    } catch (err) {
      recusa = ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
    }
    expect(recusa).toContain("contacts_carteira_origem_vocabulario");
    limpaCarteira(CONTATO);
  });

  it("sem ator e com a origem `automacao`, o sistema grava a carteira — e adota o negócio aberto sem dono", () => {
    const negocioSemDono = randomUUID();
    const negocioDoSdr = randomUUID();
    sql(`
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, status)
        values ('${negocioSemDono}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'reunião agendada', '${CONTATO}', 'open'),
               ('${negocioDoSdr}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'negócio do SDR', '${CONTATO}', 'open');
      update public.crm_leads set owner_user_id = '${SDR}', owner_kind = 'user'
        where id = '${negocioDoSdr}';
    `);

    expect(chamaSemAtor(CONTATO, CLOSER, "automacao")).toBe("");
    expect(retratoDaCarteira(CONTATO)).toBe(`${CLOSER}|automacao|true`);
    // A adoção é a mesma da 0622: aberto e SEM dono vai junto; o que já tem dono
    // fica (a ação já moveu o negócio do evento — este é outro).
    expect(lastLine(sql(`select owner_user_id from public.crm_leads where id = '${negocioSemDono}';`))).toBe(CLOSER);
    expect(lastLine(sql(`select owner_user_id from public.crm_leads where id = '${negocioDoSdr}';`))).toBe(SDR);
  });

  it("sem ator e com origem humana, a função continua recusando: `carteira_sem_ator`", () => {
    limpaCarteira(CONTATO);
    for (const origem of ["manual", "importacao", "atribuicao_automatica"]) {
      expect(chamaSemAtor(CONTATO, CLOSER, origem)).toContain("carteira_sem_ator");
    }
    expect(retratoDaCarteira(CONTATO)).toBe(semCarteira());
  });

  it("com ator humano, a origem `automacao` é recusada: o ato do sistema não é rótulo de gente", () => {
    limpaCarteira(CONTATO);
    expect(chamaComAtor(GESTOR, CONTATO, SDR, "manual")).toBe("");
    // Gestor tentando gravar a própria troca como se fosse da automação.
    expect(chamaComAtor(GESTOR, CONTATO, CLOSER, "automacao")).toContain("carteira_origem_invalida");
    // A carteira ficou exatamente onde o gestor a deixou.
    expect(retratoDaCarteira(CONTATO)).toBe(`${SDR}|manual|true`);
  });

  it("a automação não afrouxa a régua do DONO: viewer e revogado continuam fora", () => {
    limpaCarteira(CONTATO);
    expect(chamaSemAtor(CONTATO, SOMENTE_LEITURA, "automacao")).toContain("carteira_dono_invalido");
    expect(retratoDaCarteira(CONTATO)).toBe(semCarteira());

    sql(`update public.user_organizations set revoked_at = now()
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);
    expect(chamaSemAtor(CONTATO, SAIU_DA_EQUIPE, "automacao")).toContain("carteira_dono_invalido");
    expect(retratoDaCarteira(CONTATO)).toBe(semCarteira());
    sql(`update public.user_organizations set revoked_at = null
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);
  });

  it("o contato de outra organização não é alcançável nem pela automação", () => {
    expect(chamaSemAtor(CONTATO_DA_OUTRA_ORG, CLOSER, "automacao")).toContain(
      "carteira_contato_de_outra_organizacao",
    );
    expect(retratoDaCarteira(CONTATO_DA_OUTRA_ORG)).toBe(semCarteira());
  });

  it("a sessão continua sem conseguir se dar carteira (o gatilho da 0622 segue de pé)", () => {
    let recusa = "";
    try {
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${CLOSER}"}', false);
        update public.contacts set carteira_user_id = '${CLOSER}' where id = '${CONTATO}';
      `);
    } catch (err) {
      recusa = ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
    }
    expect(recusa).toContain("contacts_carteira_so_pelo_servidor");
  });

  it("`conversas`: passa só as ABERTAS que estão com outra pessoa, e conta o que a atribuição gravou", () => {
    conversasDoComeco();

    expect(passaConversas(CLOSER)).toBe("2");
    expect(retratoDasConversas()).toEqual([
      `${CLOSER}|claimed`, // era do SDR
      `${CLOSER}|claimed`, // era de uma terceira pessoa: a carteira não a pegaria
      `${SDR}|closed`, // encerrada: nem o dono, nem o status
      "NULL|open", // sem dono: fila ou IA, `transfer` calaria o bot
      `${CLOSER}|claimed`, // já era do destino: não conta
    ]);
    // Pela porta do Transferir: o evento vai junto, com o motivo do vocabulário.
    expect(
      lastLine(
        sql(`select count(*) from public.conversation_assignment_events
              where conversation_id = '${CONVERSA_DO_GESTOR}' and reason = 'transfer'
                and from_user_id = '${GESTOR}' and to_user_id = '${CLOSER}';`),
      ),
    ).toBe("1");

    // De novo: não há mais o que passar, e a contagem diz zero.
    expect(passaConversas(CLOSER)).toBe("0");
  });

  it("`conversas` é tudo ou nada: dono que não pode receber conversa não move nenhuma", () => {
    conversasDoComeco();
    expect(passaConversas(SOMENTE_LEITURA)).toContain("assignee_not_eligible_member");
    expect(retratoDasConversas()).toEqual([
      `${SDR}|claimed`,
      `${GESTOR}|claimed`,
      `${SDR}|closed`,
      "NULL|open",
      `${CLOSER}|claimed`,
    ]);
  });

  it("`contato` + `conversas`: a carteira leva as do dono anterior (#3642), a opção leva as de terceiros", () => {
    conversasDoComeco();
    sql(`update public.contacts
            set carteira_user_id = '${SDR}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DAS_CONVERSAS}';`);

    // Só a carteira: a conversa do SDR (dono anterior) vai; a do gestor fica.
    sql(`
      set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', null, '${CONTATO_DAS_CONVERSAS}', '${CLOSER}', 'automacao');
    `);
    const soACarteira = retratoDasConversas();
    expect(soACarteira[0]).toBe(`${CLOSER}|claimed`);
    expect(soACarteira[1]).toBe(`${GESTOR}|claimed`);

    // Com a opção das conversas, a do gestor vai também.
    expect(passaConversas(CLOSER)).toBe("1");
    const retrato = retratoDasConversas();
    expect(retrato[1]).toBe(`${CLOSER}|claimed`);
    expect(retrato[2]).toBe(`${SDR}|closed`);
    // A `open` sem dono que a IA atende fica com a IA nas duas portas (doc 237, 3-B).
    expect(
      lastLine(sql(`select public.comando_da_conversa(c) from public.conversations c where id = '${CONVERSA_SEM_DONO}';`)),
    ).toBe("automatico");
    expect(retrato[3]).toBe("NULL|open");
  });

  it("só o service_role executa a passagem das conversas", () => {
    const pode = (papel: string) =>
      lastLine(
        sql(`select has_function_privilege('${papel}',
               'public.fn_passar_conversas_do_contato(uuid, uuid, uuid)', 'execute');`),
      );
    expect(pode("anon")).toBe("f");
    expect(pode("authenticated")).toBe("f");
    expect(pode("service_role")).toBe("t");
  });
});

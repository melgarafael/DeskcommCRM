import { beforeAll, describe, expect, it } from "vitest";

import {
  countAs,
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * #4023 e #4026 — OS INVARIANTES DE BANCO DA PESQUISA E DA QUARENTENA.
 *
 * O que só o Postgres pode provar (o teste de unidade usa um duplo de banco):
 *
 *   1. UM pedido aberto por conversa é o ÍNDICE que garante "pergunta uma vez".
 *      O duplo reproduz a regra; aqui ela é a constraint de verdade.
 *   2. A nota é de quem GERENCIA: `manager` lê, `agent` não lê — pela policy,
 *      não pela tela. E cliente de outra empresa não lê nada.
 *   3. `sem_nota` não entra na média (`fn_satisfacao_resumo`) e o pedido vencido
 *      vira `sem_nota` por `fn_satisfacao_fechar_vencidas`.
 *   4. A quarentena NÃO apaga nem esconde a mensagem: o contador `perdidas` de
 *      `fn_quarentena_resumo` fica 0 com a mensagem no lugar, e vira 1 quando
 *      ela deixa de existir — que é o alarme de perda.
 *
 * Tudo roda com o `baseline.sql` reaplicado pelo `scripts/test-db.sh`, então a
 * passada dupla (install + update) prova a idempotência da migration de espelho.
 */

const VIZINHA_ORG = "96920000-0000-4000-8000-000000000001";
const VIZINHA_ADMIN = "96920000-1111-4000-8000-000000000001";
const VIZINHA_CONTACT = "96920000-3333-4000-8000-000000000001";
const VIZINHA_SESSION = "96920000-2222-4000-8000-000000000001";
const VIZINHA_CONV = "96920000-4444-4000-8000-000000000001";
const VIZINHA_MESSAGE = "96920000-7777-4000-8000-000000000001";

/** Mensagens do caso da quarentena, na org de `seedGov`. */
const MENSAGEM_1 = "cccccccc-7777-4000-8000-000000000001";
const MENSAGEM_2 = "cccccccc-7777-4000-8000-000000000002";
const CONVERSA_2 = "cccccccc-4444-4000-8000-0000000000a2";
/** Contato PRÓPRIO deste arquivo: os três do `seedGov` já têm conversa na sessão. */
const CONTATO_2 = "96920000-3333-4000-8000-0000000000c2";

function resumoDaSatisfacao(): Record<string, unknown> {
  return JSON.parse(
    sql(`select public.fn_satisfacao_resumo('${GOV_ORG}')::text;`),
  ) as Record<string, unknown>;
}

function resumoDaQuarentena(org = GOV_ORG): Record<string, unknown> {
  return JSON.parse(sql(`select public.fn_quarentena_resumo('${org}')::text;`)) as Record<string, unknown>;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${VIZINHA_ADMIN}', 'quarentena-vizinha@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${VIZINHA_ORG}', 'quarentena-vizinha', 'Vizinha Quarentena', 'Vizinha Q')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${VIZINHA_ADMIN}', '${VIZINHA_ORG}', 'admin', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${VIZINHA_CONTACT}', '${VIZINHA_ORG}', 'Contato Vizinha') on conflict do nothing;
    do $q$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${VIZINHA_SESSION}', '${VIZINHA_ORG}', 'quarentena-vizinha', '\\x00'::bytea);
    exception when unique_violation then null; end $q$;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${VIZINHA_CONV}', '${VIZINHA_ORG}', '${VIZINHA_CONTACT}', '${VIZINHA_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type,
       direction, status, sent_via, body, sent_at)
    values
      ('${VIZINHA_MESSAGE}', '${VIZINHA_ORG}', '${VIZINHA_CONV}', '${VIZINHA_SESSION}', '${VIZINHA_CONTACT}',
       'text', 'inbound', 'received', 'ai', 'ganhe um premio bit.ly/x', now());

    -- Contato PRÓPRIO: a constraint uniq_conversations_1to1_per_contact_session
    -- é 1:1 por (contato, sessão), e os três contatos do seedGov já têm
    -- conversa nesta sessão.
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_2}', '${GOV_ORG}', 'Contato Onda 692') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_2}', '${GOV_ORG}', '${CONTATO_2}', '${GOV_SESSION}', 'closed')
      on conflict (id) do nothing;
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type,
       direction, status, sent_via, body, sent_at)
    values
      ('${MENSAGEM_1}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}',
       'text', 'inbound', 'received', 'ai', 'PARABENS voce foi sorteado: bit.ly/premio', now()),
      ('${MENSAGEM_2}', '${GOV_ORG}', '${CONVERSA_2}', '${GOV_SESSION}', '${CONTATO_2}',
       'text', 'inbound', 'received', 'ai', 'Sou do suporte, sua conta sera bloqueada', now());
  `);
});

describe("#4023 — o pedido de nota no banco", () => {
  it("não aceita DOIS pedidos abertos para a mesma conversa (o índice é a regra)", () => {
    sql(`
      insert into public.satisfacao_do_atendimento
        (organization_id, conversation_id, contact_id, status, expira_em)
      values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_CONTACT_1}', 'aguardando', now() + interval '1 day');
    `);

    expect(() =>
      sql(`
        insert into public.satisfacao_do_atendimento
          (organization_id, conversation_id, contact_id, status, expira_em)
        values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_CONTACT_1}', 'aguardando', now() + interval '1 day');
      `),
    ).toThrow();

    const abertos = Number(
      sql(`select count(*) from public.satisfacao_do_atendimento
            where conversation_id = '${GOV_CONV_UNASSIGNED}' and status = 'aguardando';`),
    );
    expect(abertos).toBe(1);
  });

  it("respondida exige nota, e nota fora de 1-5 é recusada", () => {
    expect(() =>
      sql(`
        insert into public.satisfacao_do_atendimento
          (organization_id, conversation_id, contact_id, status, expira_em)
        values ('${GOV_ORG}', '${CONVERSA_2}', '${CONTATO_2}', 'respondida', now() + interval '1 day');
      `),
    ).toThrow();
    expect(() =>
      sql(`
        insert into public.satisfacao_do_atendimento
          (organization_id, conversation_id, contact_id, status, nota, respondido_em, expira_em)
        values ('${GOV_ORG}', '${CONVERSA_2}', '${CONTATO_2}', 'respondida', 9, now(), now() + interval '1 day');
      `),
    ).toThrow();
  });

  it("a média ignora sem_nota e pedido vencido vira sem_nota", () => {
    sql(`
      insert into public.satisfacao_do_atendimento
        (organization_id, conversation_id, contact_id, status, nota, respondido_em, expira_em)
      values ('${GOV_ORG}', '${CONVERSA_2}', '${CONTATO_2}', 'respondida', 4, now(), now() + interval '1 day');
      insert into public.satisfacao_do_atendimento
        (organization_id, conversation_id, contact_id, status, expira_em)
      values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_CONTACT_1}', 'sem_nota', now() - interval '1 day');
    `);

    const resumo = resumoDaSatisfacao();
    expect(Number(resumo.respostas)).toBe(1);
    expect(Number(resumo.media)).toBe(4);
    expect(Number(resumo.sem_nota)).toBe(1);

    const vencidos = Number(sql(`select public.fn_satisfacao_fechar_vencidas('${GOV_ORG}');`));
    expect(vencidos).toBe(0); // o único aguardando ainda está dentro da janela

    sql(`
      update public.satisfacao_do_atendimento
         set expira_em = now() - interval '1 minute'
       where status = 'aguardando' and organization_id = '${GOV_ORG}';
    `);
    expect(Number(sql(`select public.fn_satisfacao_fechar_vencidas('${GOV_ORG}');`))).toBe(1);
    expect(
      sql(`select status from public.satisfacao_do_atendimento
            where organization_id = '${GOV_ORG}' and status = 'sem_nota' and expira_em < now() limit 1;`),
    ).toBeTruthy();
  });

  it("só manager lê a nota — agent e vizinho leem ZERO linhas", () => {
    const comoManager = countAs(
      GOV_MANAGER,
      `select count(*) from public.satisfacao_do_atendimento where organization_id = '${GOV_ORG}';`,
    );
    const comoAgent = countAs(
      GOV_AGENT_A,
      `select count(*) from public.satisfacao_do_atendimento where organization_id = '${GOV_ORG}';`,
    );
    // O vizinho é `admin` da PRÓPRIA organização: a policy abre para ele lá,
    // e é isso que faz o zero aqui ser isolamento, não falta de privilégio.
    const comoVizinha = countAs(
      VIZINHA_ADMIN,
      `select count(*) from public.satisfacao_do_atendimento where organization_id = '${GOV_ORG}';`,
    );
    expect(comoManager).toBeGreaterThan(0);
    expect(comoAgent).toBe(0);
    expect(comoVizinha).toBe(0);
  });
});

describe("#4026 — a quarentena no banco", () => {
  it("a linha de quarentena não toca a mensagem, e o contador de perda é 0", () => {
    const antes = Number(
      sql(`select count(*) from public.messages where organization_id = '${GOV_ORG}';`),
    );
    sql(`
      insert into public.quarentena_de_entrada
        (organization_id, conversation_id, contact_id, message_id, channel_session_id,
         veredito, confianca, sinais)
      values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_CONTACT_1}', '${MENSAGEM_1}', '${GOV_SESSION}',
              'link_encurtado', 0.9, '["link_encurtado","premio_nao_pedido"]'::jsonb);
    `);

    const depois = Number(
      sql(`select count(*) from public.messages where organization_id = '${GOV_ORG}';`),
    );
    expect(depois).toBe(antes);

    const resumo = resumoDaQuarentena();
    expect(Number(resumo.em_quarentena)).toBe(1);
    expect(Number(resumo.perdidas)).toBe(0);
  });

  it("uma mensagem só entra uma vez na quarentena (reentrega não duplica)", () => {
    expect(() =>
      sql(`
        insert into public.quarentena_de_entrada
          (organization_id, conversation_id, contact_id, message_id, veredito, confianca)
        values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_CONTACT_1}', '${MENSAGEM_1}',
                'link_encurtado', 0.9);
      `),
    ).toThrow();
  });

  it("o contador ACUSA perda quando a mensagem retida deixa de existir", () => {
    sql(`
      insert into public.quarentena_de_entrada
        (organization_id, conversation_id, contact_id, message_id, veredito, confianca)
      values ('${GOV_ORG}', '${CONVERSA_2}', '${CONTATO_2}', '${MENSAGEM_2}',
              'falso_suporte', 0.55);
    `);
    expect(Number(resumoDaQuarentena().perdidas)).toBe(0);

    sql(`delete from public.messages where id = '${MENSAGEM_2}';`);
    expect(Number(resumoDaQuarentena().perdidas)).toBe(1);
  });

  it("a fila é da organização: quem atende vê a sua, o vizinho não vê a nossa", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.quarentena_de_entrada where organization_id = '${GOV_ORG}';`,
      ),
    ).toBe(2);
    expect(
      countAs(
        VIZINHA_ADMIN,
        `select count(*) from public.quarentena_de_entrada where organization_id = '${GOV_ORG}';`,
      ),
    ).toBe(0);
  });

  it("a organização sem filtro ligado não tem nada retido (nada nasce ligado)", () => {
    expect(Number(resumoDaQuarentena(VIZINHA_ORG).em_quarentena)).toBe(0);
    expect(
      sql(`select coalesce((settings -> 'filtro_de_spam' ->> 'ligado')::boolean, false)
             from public.organizations where id = '${GOV_ORG}';`),
    ).toBe("f");
  });
});

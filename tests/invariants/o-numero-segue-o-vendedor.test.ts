/**
 * #3642 — o NÚMERO segue o vendedor: a troca de dono leva a conversa para o
 * número do vendedor novo.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * Numa empresa com um número por vendedor, `fn_conversation_assign` (a porta
 * única de escrita da atribuição: Transferir um e em lote, Assumir, MCP,
 * automação) trocava só `assigned_to_user_id`. A conversa continuava com o
 * `channel_session_id` do vendedor ANTERIOR, e o envio sai pela sessão da
 * conversa — o vendedor novo respondia pelo WhatsApp do colega.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * 1. Transferir de A para B (cada um com o seu número) grava a sessão de B na
 *    conversa, e zera `provider_conversation_id` (a thread do number antigo não
 *    viaja).
 * 2. Número COMPARTILHADO (os dois na lista de responsáveis do mesmo número):
 *    nada muda — é o caso legítimo.
 * 3. Dono novo SEM número conectado: nada muda (a transferência não falha; quem
 *    recusa, com erro claro, é o ENVIO humano — `lib/channels/numero-do-atendente.ts`).
 * 4. O número atual não é de ninguém (sem policy — o número geral da empresa):
 *    nada muda, mesmo que o dono novo tenha número próprio.
 * 4b. Número próprio do dono novo de OUTRO canal (`provider`): nada muda.
 * 5. O contato já tem conversa no número do vendedor novo: o dono muda e o
 *    número não (re-apontar estouraria `uniq_conversations_1to1_per_contact_session`
 *    e a transferência inteira falharia).
 * 6. A troca de CARTEIRA (`fn_definir_carteira_do_cliente`) leva as conversas
 *    abertas do dono anterior ao novo dono, pela mesma porta — e o número junto.
 * 7. A carteira NÃO rouba conversa que já é de outra pessoa.
 * 8. A carteira NÃO tira da IA a conversa que ela está atendendo (doc 237, 3-B)
 *    — a `open` sem dono, que é o caso comum, e a rara `ai_handling`. A parada
 *    (IA silenciada) vai para o dono novo: o filtro é o comando, não o status.
 * 9. A prévia do diálogo (`fn_numero_da_transferencia`) diz o número que a troca
 *    grava, e só `service_role` a executa.
 *
 * Organização própria (namespace `ffffffff-`) para não encostar nas governanças
 * que rodam no mesmo banco.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "ffffffff-0000-4000-8000-000000000001";
const VENDEDOR_A = "ffffffff-1111-4000-8000-000000000001"; // número A, dono original
const VENDEDOR_B = "ffffffff-1111-4000-8000-000000000002"; // número B
const VENDEDOR_C = "ffffffff-1111-4000-8000-000000000003"; // divide o número A
const SEM_NUMERO = "ffffffff-1111-4000-8000-000000000004"; // nenhum número conectado
const GESTOR = "ffffffff-1111-4000-8000-000000000005"; // manager (só ele muda carteira)

const SESSAO_A = "ffffffff-2222-4000-8000-000000000001";
const SESSAO_B = "ffffffff-2222-4000-8000-000000000002";
const SESSAO_SEM_POLICY = "ffffffff-2222-4000-8000-000000000003";
const SESSAO_A_OFICIAL = "ffffffff-2222-4000-8000-000000000004"; // outro canal, também de A

const POLITICA_A = "ffffffff-3333-4000-8000-000000000001";
const POLITICA_B = "ffffffff-3333-4000-8000-000000000002";
const POLITICA_A_OFICIAL = "ffffffff-3333-4000-8000-000000000003";

const CONTATO = "ffffffff-4444-4000-8000-000000000001";
const CONTATO_DA_CARTEIRA = "ffffffff-4444-4000-8000-000000000002";
const CONTATO_DO_COLEGA = "ffffffff-4444-4000-8000-000000000003";
// Contatos SÓ deste caso: o controle não pode passar por colisão com a conversa
// que um caso anterior deixou no número de B.
const CONTATO_DO_NUMERO_GERAL = "ffffffff-4444-4000-8000-000000000004";
const CONTATO_DO_OUTRO_CANAL = "ffffffff-4444-4000-8000-000000000005";
const CONTATO_DA_IA = "ffffffff-4444-4000-8000-000000000006";
const CONTATO_DA_PREVIA = "ffffffff-4444-4000-8000-000000000007";
const CONTATO_DA_IA_ABERTA = "ffffffff-4444-4000-8000-000000000008";
const CONTATO_PARADO = "ffffffff-4444-4000-8000-000000000009";
// #3732: o contato do retorno A→B→A e o da conversa que a terceira pessoa assumiu.
const CONTATO_DO_RETORNO = "ffffffff-4444-4000-8000-000000000010";
const CONTATO_ASSUMIDO_NO_MEIO = "ffffffff-4444-4000-8000-000000000011";
// #3732 + doc 237 (3-B): a conversa no número novo que a IA está atendendo.
const CONTATO_DA_IA_NO_RETORNO = "ffffffff-4444-4000-8000-000000000012";

/** Chama a RPC como a rota chama: `service_role`. */
function transfere(conversa: string, para: string | null, motivo = "transfer"): void {
  sql(`
    set role service_role;
    select public.fn_conversation_assign(
      '${ORG}', '${conversa}', ${para ? `'${para}'` : "null"}, '${motivo}');
  `);
}

/** A carteira, pela porta da ficha (`service_role`, ator explícito). */
function defineCarteira(contato: string, dono: string): void {
  sql(`
    set role service_role;
    select public.fn_definir_carteira_do_cliente('${ORG}', '${GESTOR}', '${contato}', '${dono}', 'manual');
  `);
}

function sessaoDe(conversa: string): string {
  return lastLine(
    sql(`select channel_session_id::text from public.conversations where id = '${conversa}';`),
  );
}

function donoDe(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'NULL') from public.conversations where id = '${conversa}';`),
  );
}

/** Uma conversa nova por caso, para um caso não contaminar o outro. */
function conversaNova(
  id: string,
  contato: string,
  sessao: string,
  dono: string | null,
  status = "claimed",
): string {
  sql(`
    delete from public.conversations where id = '${id}';
    -- Um contato por conversa e por sessão (0027): o caso anterior desta suíte
    -- pode ter deixado uma no mesmo par.
    delete from public.conversations
     where organization_id = '${ORG}' and contact_id = '${contato}' and channel_session_id = '${sessao}';
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, provider_conversation_id)
    values ('${id}', '${ORG}', '${contato}', '${sessao}', '${status}',
            ${dono ? `'${dono}'` : "null"}, 'thread-do-numero-antigo');
  `);
  return id;
}

describe("#3642 — a conversa segue o número do vendedor novo", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${VENDEDOR_A}', 'numero-a@invariant.test'),
        ('${VENDEDOR_B}', 'numero-b@invariant.test'),
        ('${VENDEDOR_C}', 'numero-c@invariant.test'),
        ('${SEM_NUMERO}', 'numero-sem@invariant.test'),
        ('${GESTOR}', 'numero-gestor@invariant.test')
      on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'numero-do-vendedor-inv', 'Numero Invariant Org', 'Numero Inv')
        on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${VENDEDOR_A}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_B}', '${ORG}', 'agent', now()),
        ('${VENDEDOR_C}', '${ORG}', 'agent', now()),
        ('${SEM_NUMERO}', '${ORG}', 'agent', now()),
        ('${GESTOR}', '${ORG}', 'manager', now())
      on conflict (user_id, organization_id) do update
        set role = excluded.role, revoked_at = null, accepted_at = now();

      -- Três números: A e B com policy própria; o terceiro sem policy (legado).
      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name)
      values
        ('${SESSAO_A}', '${ORG}', 'waha', 'numero-inv-a', '\\x00'::bytea, 'WORKING', 'Numero A'),
        ('${SESSAO_B}', '${ORG}', 'waha', 'numero-inv-b', '\\x00'::bytea, 'WORKING', 'Numero B'),
        ('${SESSAO_SEM_POLICY}', '${ORG}', 'waha', 'numero-inv-legado', '\\x00'::bytea, 'WORKING', 'Numero Legado')
      on conflict (id) do update
        set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

      -- Um número de A em OUTRO canal (Cloud API): B só tem WhatsApp via WAHA.
      insert into public.channel_sessions
        (id, organization_id, provider, meta_phone_number_id, webhook_secret_encrypted, status, display_name)
      values
        ('${SESSAO_A_OFICIAL}', '${ORG}', 'meta_cloud', 'numero-inv-oficial', '\\x00'::bytea, 'WORKING', 'Numero A Oficial')
      on conflict (id) do update
        set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

      insert into public.channel_routing_policies (id, organization_id, channel_session_id) values
        ('${POLITICA_A}', '${ORG}', '${SESSAO_A}'),
        ('${POLITICA_B}', '${ORG}', '${SESSAO_B}'),
        ('${POLITICA_A_OFICIAL}', '${ORG}', '${SESSAO_A_OFICIAL}')
      on conflict (id) do nothing;

      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
        ('${ORG}', '${POLITICA_A}', '${VENDEDOR_A}'),
        ('${ORG}', '${POLITICA_A}', '${VENDEDOR_C}'),  -- número COMPARTILHADO
        ('${ORG}', '${POLITICA_B}', '${VENDEDOR_B}'),
        ('${ORG}', '${POLITICA_A_OFICIAL}', '${VENDEDOR_A}')
      on conflict do nothing;

      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO}', '${ORG}', 'Contato Numero'),
        ('${CONTATO_DA_CARTEIRA}', '${ORG}', 'Contato Carteira'),
        ('${CONTATO_DO_COLEGA}', '${ORG}', 'Contato Do Colega'),
        ('${CONTATO_DO_NUMERO_GERAL}', '${ORG}', 'Contato Numero Geral'),
        ('${CONTATO_DO_OUTRO_CANAL}', '${ORG}', 'Contato Outro Canal'),
        ('${CONTATO_DA_IA}', '${ORG}', 'Contato Da IA'),
        ('${CONTATO_DA_PREVIA}', '${ORG}', 'Contato Da Previa'),
        ('${CONTATO_DA_IA_ABERTA}', '${ORG}', 'Contato Da IA Aberta'),
        ('${CONTATO_PARADO}', '${ORG}', 'Contato Parado'),
        ('${CONTATO_DO_RETORNO}', '${ORG}', 'Contato Do Retorno'),
        ('${CONTATO_ASSUMIDO_NO_MEIO}', '${ORG}', 'Contato Assumido No Meio'),
        ('${CONTATO_DA_IA_NO_RETORNO}', '${ORG}', 'Contato Da IA No Retorno')
      on conflict (id) do update
        set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null;
    `);
  });

  afterAll(() => {
    sql(`
      delete from public.conversations where organization_id = '${ORG}';
      delete from public.channel_routing_responsibles where organization_id = '${ORG}';
      delete from public.channel_routing_policies where organization_id = '${ORG}';
      delete from public.channel_sessions where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id in
        ('${VENDEDOR_A}', '${VENDEDOR_B}', '${VENDEDOR_C}', '${SEM_NUMERO}', '${GESTOR}');
    `);
  });

  it("transferir de A para B (cada um com o seu número) leva a conversa para o número de B", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000001", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);
    // A thread do número antigo não viaja: ela pertence ao número anterior.
    expect(
      lastLine(
        sql(`select coalesce(provider_conversation_id, 'NULL') from public.conversations where id = '${conversa}';`),
      ),
    ).toBe("NULL");
  });

  it("número COMPARTILHADO: transferir para quem já responde por ele mantém o número", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000002", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_C);

    expect(donoDe(conversa)).toBe(VENDEDOR_C);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });

  it("dono novo SEM número conectado: a transferência acontece e o número fica (quem recusa é o envio)", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000003", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, SEM_NUMERO);

    expect(donoDe(conversa)).toBe(SEM_NUMERO);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });

  it("o número geral da empresa (sem policy) não vira o número do vendedor — controle", () => {
    // Contato SEM conversa no número de B: se o número mudasse, nada o impediria.
    // (Com o contato dos outros casos, a conversa que o caso 1 deixou no número
    // de B barrava a troca por colisão, e o controle passava pelo motivo errado.)
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000004", CONTATO_DO_NUMERO_GERAL, SESSAO_SEM_POLICY, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_SEM_POLICY);
  });

  it("número próprio do dono novo em OUTRO canal: a conversa não troca de canal", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000009", CONTATO_DO_OUTRO_CANAL, SESSAO_A_OFICIAL, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_A_OFICIAL);
  });

  it("o contato já tem conversa no número do vendedor novo: o dono muda e o número não", () => {
    // A conversa anterior do contato NO NÚMERO DE B é o que impede o re-apontamento.
    // Dona: a terceira pessoa — é o caso em que a conversa de lá NÃO é adotada.
    const jaExiste = conversaNova(
      "ffffffff-5555-4000-8000-000000000005", CONTATO, SESSAO_B, VENDEDOR_C);
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000006", CONTATO, SESSAO_A, VENDEDOR_A);

    transfere(conversa, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
    // E a conversa que já estava lá, e já era de outra pessoa, não foi tomada.
    expect(sessaoDe(jaExiste)).toBe(SESSAO_B);
    expect(donoDe(jaExiste)).toBe(VENDEDOR_C);
  });

  /**
   * #3732 — o caso A→B→A que o @hudson-souza-mkt mediu no #3658.
   *
   * Medido no baseline da 9054 (psql, org de teste): a conversa antiga C1 volta
   * para A no número de B e o envio de A dá 409 — "transfira para você", o que
   * já foi feito —, enquanto a conversa C2, no número de A, fica com outra
   * pessoa. Depois da 9054, C2 passa para A (é onde ele responde) e C1 continua
   * presa no número de B: ela está no nome dele e o aviso do envio aponta a C2.
   */
  it("A→B→A: a conversa que ficou no número de A passa para A (e a antiga, presa, é do A)", () => {
    const antiga = conversaNova(
      "ffffffff-5555-4000-8000-000000000020", CONTATO_DO_RETORNO, SESSAO_A, VENDEDOR_A);
    transfere(antiga, VENDEDOR_B);
    expect(sessaoDe(antiga)).toBe(SESSAO_B);

    // O cliente volta a escrever no número de A: nasce a conversa nova ali, e ela
    // ficou com o dono anterior (B) — o caso "ficou com outra pessoa".
    const nova = conversaNova(
      "ffffffff-5555-4000-8000-000000000021", CONTATO_DO_RETORNO, SESSAO_A, VENDEDOR_B);

    transfere(antiga, VENDEDOR_A);

    // A conversa NOVA está no número de A e passa para A…
    expect(donoDe(nova)).toBe(VENDEDOR_A);
    expect(sessaoDe(nova)).toBe(SESSAO_A);
    // …e a antiga fica no nome dele, presa no número de B (o número não pode ter
    // duas conversas do mesmo contato).
    expect(donoDe(antiga)).toBe(VENDEDOR_A);
    expect(sessaoDe(antiga)).toBe(SESSAO_B);
  });

  it("#3732, CONTROLE: a conversa no número novo que uma TERCEIRA pessoa assumiu não é tomada", () => {
    const antiga = conversaNova(
      "ffffffff-5555-4000-8000-000000000022", CONTATO_ASSUMIDO_NO_MEIO, SESSAO_A, VENDEDOR_A);
    transfere(antiga, VENDEDOR_B);
    const daTerceira = conversaNova(
      "ffffffff-5555-4000-8000-000000000023", CONTATO_ASSUMIDO_NO_MEIO, SESSAO_A, VENDEDOR_C);

    transfere(antiga, VENDEDOR_A);

    // Quem assumiu no meio continua com ela, e o número dela não muda.
    expect(donoDe(daTerceira)).toBe(VENDEDOR_C);
    expect(sessaoDe(daTerceira)).toBe(SESSAO_A);
  });

  it("#3732, doc 237 3-B: a conversa no número novo que a IA está atendendo NÃO é adotada", () => {
    // Sem dono, aberta e com a IA ativa: `comando_da_conversa` diz 'automatico'.
    // A adoção a atribuiria e gravaria `bot_silenced_until = 'infinity'` — a IA
    // calada sem prazo, o que a 3-B proíbe também na troca de carteira.
    const antiga = conversaNova(
      "ffffffff-5555-4000-8000-000000000024", CONTATO_DA_IA_NO_RETORNO, SESSAO_A, VENDEDOR_A);
    transfere(antiga, VENDEDOR_B);
    const daIa = conversaNova(
      "ffffffff-5555-4000-8000-000000000025", CONTATO_DA_IA_NO_RETORNO, SESSAO_A, null, "open");
    expect(
      lastLine(sql(`select public.comando_da_conversa(c) from public.conversations c where id = '${daIa}';`)),
    ).toBe("automatico");

    transfere(antiga, VENDEDOR_A);

    expect(donoDe(antiga)).toBe(VENDEDOR_A);
    expect(donoDe(daIa)).toBe("NULL");
    expect(
      lastLine(sql(`select coalesce(bot_silenced_until::text, 'NULL') from public.conversations where id = '${daIa}';`)),
    ).toBe("NULL");
  });

  it("trocar a CARTEIRA leva as conversas abertas do dono anterior para o novo — e o número junto", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000007", CONTATO_DA_CARTEIRA, SESSAO_A, VENDEDOR_A);
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DA_CARTEIRA}';`);

    defineCarteira(CONTATO_DA_CARTEIRA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);
  });

  it("a carteira NÃO rouba a conversa que já é de outra pessoa", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000008", CONTATO_DO_COLEGA, SESSAO_A, VENDEDOR_C);
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DO_COLEGA}';`);

    defineCarteira(CONTATO_DO_COLEGA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_C);
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
  });

  it("doc 237, 3-B: a carteira NÃO tira da IA a conversa que ela está atendendo", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000010", CONTATO_DA_IA, SESSAO_A, null, "ai_handling");
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DA_IA}';`);

    defineCarteira(CONTATO_DA_IA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe("NULL");
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
    expect(
      lastLine(sql(`select status from public.conversations where id = '${conversa}';`)),
    ).toBe("ai_handling");
    // E a carteira mudou de verdade — o controle de que a função rodou.
    expect(
      lastLine(sql(`select carteira_user_id::text from public.contacts where id = '${CONTATO_DA_IA}';`)),
    ).toBe(VENDEDOR_B);
  });

  it("doc 237, 3-B, caso comum: a conversa `open` sem dono que a IA atende fica com a IA", () => {
    // É assim que a IA atende em produção: `ai_handling` quase não é escrito, e
    // o motor responde conversa `open` sem dono. Filtrar por status deixava esta
    // conversa ir para B, `claimed`, com a IA calada sem prazo.
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000012", CONTATO_DA_IA_ABERTA, SESSAO_A, null, "open");
    sql(`update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_DA_IA_ABERTA}';`);
    expect(
      lastLine(sql(`select public.comando_da_conversa(c) from public.conversations c where id = '${conversa}';`)),
    ).toBe("automatico");

    defineCarteira(CONTATO_DA_IA_ABERTA, VENDEDOR_B);

    expect(donoDe(conversa)).toBe("NULL");
    expect(sessaoDe(conversa)).toBe(SESSAO_A);
    expect(
      lastLine(sql(`select status from public.conversations where id = '${conversa}';`)),
    ).toBe("open");
    expect(
      lastLine(sql(`select carteira_user_id::text from public.contacts where id = '${CONTATO_DA_IA_ABERTA}';`)),
    ).toBe(VENDEDOR_B);
  });

  it("doc 237, 3-B, controle: a conversa `open` sem dono PARADA (IA silenciada) vai para o dono novo", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000013", CONTATO_PARADO, SESSAO_A, null, "open");
    sql(`update public.conversations set bot_silenced_until = now() + interval '1 day' where id = '${conversa}';
         update public.contacts
            set carteira_user_id = '${VENDEDOR_A}', carteira_origem = 'manual', carteira_definida_em = now()
          where id = '${CONTATO_PARADO}';`);

    defineCarteira(CONTATO_PARADO, VENDEDOR_B);

    expect(donoDe(conversa)).toBe(VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);
  });

  it("a prévia do diálogo diz o número que a troca grava — e só service_role a executa", () => {
    const conversa = conversaNova(
      "ffffffff-5555-4000-8000-000000000011", CONTATO_DA_PREVIA, SESSAO_A, VENDEDOR_A);

    const previa = (para: string) =>
      lastLine(
        sql(`
          set role service_role;
          select coalesce(public.fn_numero_da_transferencia('${ORG}', '${conversa}', '${para}')::text, 'NULL');
        `),
      );
    expect(previa(VENDEDOR_C)).toBe("NULL"); // número compartilhado: fica
    expect(previa(SEM_NUMERO)).toBe("NULL"); // sem número: fica
    expect(previa(VENDEDOR_B)).toBe(SESSAO_B);

    transfere(conversa, VENDEDOR_B);
    expect(sessaoDe(conversa)).toBe(SESSAO_B);

    for (const papel of ["anon", "authenticated"]) {
      expect(
        lastLine(
          sql(`select has_function_privilege('${papel}',
                 'public.fn_numero_da_transferencia(uuid, uuid, uuid)', 'execute');`),
        ),
      ).toBe("f");
    }
  });
});

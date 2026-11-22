import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A BUSCA DO INBOX USA O ÍNDICE — E CONTINUA RESPEITANDO A ORGANIZAÇÃO
 * (issue #4326, fatia 1, ponto b).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 * A fatia troca a consulta que o handler montava (`or=(busca_sem_acento.like…,
 * phone_number.ilike…)` direto em `contacts`) por uma chamada a
 * `fn_contatos_da_busca`. Os testes de unidade provam só a FORMA: que o handler
 * chama a função, com quais argumentos. Duas afirmações ficam fora do alcance de
 * um dublê, e são as que dão sentido à fatia:
 *
 *   1. a busca CHEGA no índice de trigrama — o motivo de existir da função, já
 *      que com RLS na tabela `like`/`ilike` não são `leakproof` e o planejador
 *      não os usa como condição de índice (o plano virava varredura da
 *      organização inteira);
 *   2. a função, que roda `security definer` e portanto FORA da política de
 *      linha, NÃO amplia visibilidade: quem não é membro da organização recebe
 *      zero, anonimizado não casa, ficha pessoal não casa.
 *
 * A prova do índice é dupla, de propósito: o PLANO (`EXPLAIN`, que mostra o
 * `Bitmap Index Scan`) e o CONTADOR do próprio Postgres
 * (`pg_stat_user_indexes.idx_scan`, que mostra que a chamada de verdade passou
 * por ele). Um índice criado e não usado tem a mesma definição do usado, e é
 * justamente esse o defeito que a fatia conserta — por isso a definição sozinha
 * não serve de prova. Sabotagem: apagar o índice deixa o EXPLAIN em seq scan e
 * o contador sem crescer, e este arquivo fica vermelho.
 */

const ORG_A = "43260000-0000-4000-8000-0000000000a1";
const ORG_B = "43260000-0000-4000-8000-0000000000b1";
const USER_A = "43260000-1111-4000-8000-0000000000a1";
const USER_B = "43260000-1111-4000-8000-0000000000b1";

/**
 * Os telefones são sintéticos e DESENHADOS para o teste medir o que promete:
 * o número buscado usa só os dígitos 4/7/9/8, e o enchimento usa 0/1/3. Assim o
 * termo raro não compartilha trigrama com o enchimento (num telefone de
 * verdade o `000` aparece em tudo, e o GIN devolveria a tabela inteira como
 * candidata — mediria a falta de seletividade, não a falta de índice).
 */
const TEL_BUSCADO = "+5547988887777"; // casa o contato 2
const TEL_EXTRA = "+5599777776666"; // só o telefone EXTRA do contato 3
const TEL_ORG_B = "+5599555554444";

/** Um contato por caso, na org A; o da org B existe só para provar isolamento. */
const CONTATOS = [
  // Casa por nome sem acento (digitado "joao").
  { id: "43260000-2222-4000-8000-000000000001", display: "João Pereira", tel: "+5521333331111" },
  // Casa pelo telefone principal.
  { id: "43260000-2222-4000-8000-000000000002", display: "Marcos Lima", tel: TEL_BUSCADO },
  // Só o telefone EXTRA casa este.
  { id: "43260000-2222-4000-8000-000000000003", display: "Beatriz Alves", tel: "+5521333333333" },
  // Anonimizado: existe na tabela, mas não pode ser encontrado.
  { id: "43260000-2222-4000-8000-000000000004", display: "Carlos Souza", tel: "+5521333334444" },
  // Ficha pessoal (spec 21): fora da busca do Inbox.
  { id: "43260000-2222-4000-8000-000000000005", display: "Débora Nunes", tel: "+5521333335555" },
  // O `%` digitado tem de continuar LITERAL, não curinga.
  { id: "43260000-2222-4000-8000-000000000006", display: "100% Fidelidade", tel: "+5521333336666" },
];

const CONTATO_DA_ORG_B = "43260000-2222-4000-8000-0000000000b1";

/** Chama a função como o usuário, pelo mesmo caminho de `auth.uid()` da produção. */
function buscarComo(usuario: string, argumentos: string): number {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    select count(*) from public.fn_contatos_da_busca(${argumentos});
  `);
  return Number(lastLine(saida));
}

/** Os ids devolvidos, para afirmar QUAL ficha casou e não só quantas. */
function idsComo(usuario: string, argumentos: string): string[] {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    select coalesce(string_agg(contact_id::text, ',' order by contact_id::text), '')
      from public.fn_contatos_da_busca(${argumentos});
  `);
  const linha = lastLine(saida);
  return linha === "" ? [] : linha.split(",");
}

beforeAll(() => {
  // O anonimizado entra em comando próprio: `contacts_anonymized_locked` exige
  // `anonymized_at` preenchido quando `is_anonymized` é true, e a lista abaixo
  // não carrega essa coluna.
  const anonimizado = CONTATOS.find((c) => c.id.endsWith("004"))!;
  const contatos = CONTATOS.filter((c) => c.id !== anonimizado.id)
    .map(
      (c) => `('${c.id}', '${ORG_A}', '${c.display}', null, null, '${c.tel}',
             false,
             ${c.id.endsWith("005") ? "true" : "false"})`,
    )
    .join(",\n    ");

  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG_A}', 'invariante-4326-a', 'Invariante 4326 A', 'Inv 4326 A'),
           ('${ORG_B}', 'invariante-4326-b', 'Invariante 4326 B', 'Inv 4326 B')
    on conflict (id) do nothing;

    insert into auth.users (id, email)
    values ('${USER_A}', 'agente.a.4326@invariant.test'),
           ('${USER_B}', 'agente.b.4326@invariant.test')
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${USER_A}', '${ORG_A}', 'agent', now()),
           ('${USER_B}', '${ORG_B}', 'agent', now())
    on conflict do nothing;

    insert into public.contacts
      (id, organization_id, display_name, name, email, phone_number, is_anonymized, is_personal)
    values
    ${contatos},
    ('${CONTATO_DA_ORG_B}', '${ORG_B}', 'João Pereira', null, null, '${TEL_ORG_B}', false, false)
    on conflict (id) do update set
      display_name = excluded.display_name,
      phone_number = excluded.phone_number,
      is_anonymized = excluded.is_anonymized,
      is_personal = excluded.is_personal;

    -- Volume para o planejador ter MOTIVO de usar o GIN (o enchimento entra
    -- depois deste bloco, em lotes — ver o laço abaixo).
    insert into public.contact_phones (id, organization_id, contact_id, phone_number, tipo, whatsapp)
    values ('43260000-3333-4000-8000-000000000003', '${ORG_A}',
            '43260000-2222-4000-8000-000000000003', '${TEL_EXTRA}', 'celular', 'nao_sei')
    on conflict (id) do update set phone_number = excluded.phone_number;

    -- #4434: a aba Pessoal inverte o sinal, e o dono acompanha. A Débora é da
    -- USER_A; a "Débora do colega" tem o MESMO nome buscável e outro dono, para
    -- o caso abaixo provar que p_dono filtra de verdade (e não só o booleano).
    update public.contacts
       set is_personal = true, personal_owner_user_id = '${USER_A}'
     where id = '43260000-2222-4000-8000-000000000005';

    insert into public.contacts
      (id, organization_id, display_name, name, phone_number, is_anonymized, is_personal,
       personal_owner_user_id)
    values ('43260000-2222-4000-8000-000000000007', '${ORG_A}', 'Débora Nunes (colega)', null,
            '+5511977770007', false, true, '${USER_B}')
    on conflict (id) do update set
      display_name = excluded.display_name,
      is_personal = excluded.is_personal,
      personal_owner_user_id = excluded.personal_owner_user_id;

    insert into public.contacts
      (id, organization_id, display_name, phone_number, is_anonymized, anonymized_at)
    values ('${anonimizado.id}', '${ORG_A}', '${anonimizado.display}', '${anonimizado.tel}', true, now())
    on conflict (id) do nothing;
  `);

  // ─── 40.000 fichas de enchimento, em lotes ──────────────────────────────────
  //
  // Em lotes de 4.000 e uma SESSÃO por lote, por dois motivos medidos:
  //
  //   · volume: com poucos milhares de linhas a tabela cabe em poucas páginas e a
  //     varredura sequencial é mais barata de verdade (medido: 6.000 linhas ainda
  //     dá `Seq Scan` mesmo como dono da tabela). A asserção do índice mediria o
  //     tamanho da tabela, não o defeito. 40 mil é a ordem em que o índice ganha;
  //   · um único `insert … select` acima de ~6.000 linhas estoura o lock table do
  //     container de teste (`out of shared memory / max_locks_per_transaction`),
  //     então cada lote é um comando e uma transação.
  for (let lote = 0; lote < 10; lote++) {
    const de = lote * 4000 + 1;
    sql(`
      insert into public.contacts (id, organization_id, display_name, name, email, phone_number)
      select ('43260000-4444-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             '${ORG_A}', 'Filler ' || g || ' Teste', null, null,
             '+55113' || lpad(g::text, 6, '0')
        from generate_series(${de}, ${de + 3999}) g
      on conflict (id) do nothing;
    `);
  }

  // ─── A LISTA PENDENTE DO GIN TEM DE ESTAR LIMPA ─────────────────────────────
  //
  // O GIN nasce com `fastupdate = on`: as linhas novas vão para uma lista
  // pendente, e o planejador cobra a varredura DELA ao estimar o custo do
  // índice. Com 40 mil linhas recém-inseridas a lista fica grande o bastante
  // para o índice perder para a varredura sequencial — medido: 668 de custo com
  // a lista suja, 76 depois de limpar, para o MESMO plano. Em produção isso é o
  // autovacuum quem resolve; aqui, sem limpar, a asserção de uso do índice
  // mediria a idade da lista em vez do índice, e ficaria instável.
  sql(`
    do $limpa$
    begin
      -- Sem o índice, o teste tem de falhar na ASSERÇÃO (o plano e o contador),
      -- que é onde o defeito do #4326 aparece — não na preparação.
      if to_regclass('idx_contacts_phone_trgm') is not null then
        perform gin_clean_pending_list('idx_contacts_phone_trgm');
      end if;
      if to_regclass('idx_contacts_busca_sem_acento_trgm') is not null then
        perform gin_clean_pending_list('idx_contacts_busca_sem_acento_trgm');
      end if;
    end
    $limpa$;
    vacuum analyze public.contacts;
    vacuum analyze public.contact_phones;
  `);
});

describe("fn_contatos_da_busca — o índice e a cerca", () => {
  it("⭐ o PLANO da busca de telefone é `Bitmap Index Scan` no índice de trigrama", () => {
    // A prova que o item do #4326 promete: o índice deixa de ser enfeite. Roda
    // como dono da tabela (é o papel da função, `security definer`), porque é
    // exatamente essa a razão de a função existir — sob `set role authenticated`
    // o mesmo SQL volta a `Seq Scan` (o teste seguinte mostra o contraste).
    const plano = sql(`
      explain (format text, costs off)
      select c.id from public.contacts c
       where c.organization_id = '${ORG_A}'
         and c.is_anonymized = false
         and c.is_personal = false
         and c.phone_number like '%${TEL_BUSCADO.slice(1)}%'
       limit 120;
    `);

    expect(plano, `o plano não usa o índice de trigrama:\n${plano}`).toContain(
      "idx_contacts_phone_trgm",
    );
    expect(plano, `o plano não é de índice:\n${plano}`).toMatch(/Bitmap Index Scan|Index Scan/);
  });

  it("⛔ a MESMA consulta sob RLS NÃO usa o índice — é o defeito que a função contorna", () => {
    // Contraste que justifica a troca de forma. `like` não é `leakproof`: com a
    // política de linha no caminho, o planejador não pode empurrá-lo para o
    // índice, e o plano vira varredura da organização. Se algum dia o plano
    // passar a usar o índice sob RLS, este caso fica vermelho — e aí a função
    // pode ser simplificada de volta para uma consulta direta.
    const plano = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      explain (format text, costs off)
      select c.id from public.contacts c
       where c.organization_id = '${ORG_A}'
         and c.is_anonymized = false
         and c.is_personal = false
         and c.phone_number like '%${TEL_BUSCADO.slice(1)}%'
       limit 120;
    `);

    expect(plano, `o plano sob RLS passou a usar o índice:\n${plano}`).not.toContain(
      "idx_contacts_phone_trgm",
    );
  });

  it("⭐ a chamada de verdade passa pelo índice (contador do Postgres, não a definição)", () => {
    const contador = () => {
      const saida = sql(`
        select pg_stat_force_next_flush();
        select coalesce(sum(idx_scan), 0) from pg_stat_user_indexes
         where indexrelname in ('idx_contacts_phone_trgm', 'idx_contact_phones_phone_trgm');
      `);
      return Number(lastLine(saida));
    };

    const antes = contador();
    // Telefone que casa UMA ficha: é o caso em que o índice rende.
    expect(buscarComo(USER_A, `p_org => '${ORG_A}', p_digitos => array['${TEL_BUSCADO.slice(1)}']`)).toBe(1);
    const depois = contador();

    expect(
      depois - antes,
      "a função não usou nenhum índice de trigrama de telefone — o plano voltou a " +
        "varrer a organização. Sem o índice a busca continua CORRETA e fica LENTA, " +
        "que é o defeito do #4326.",
    ).toBeGreaterThan(0);
  });

  it("os índices são de trigrama, na coluna de telefone e na de prévia", () => {
    const definicoes = sql(`
      select string_agg(indexdef, ' | ' order by indexname)
        from pg_indexes
       where schemaname = 'public'
         and indexname in ('idx_contacts_phone_trgm', 'idx_contact_phones_phone_trgm');
    `);

    expect(definicoes, "faltou índice de telefone").toContain("idx_contacts_phone_trgm");
    expect(definicoes, "faltou índice no telefone extra").toContain(
      "idx_contact_phones_phone_trgm",
    );
    // `gin_trgm_ops` é o único operador que atende `'%termo%'`; um btree na
    // coluna existe desde antes e NÃO serve para curinga à esquerda.
    expect(definicoes.match(/gin_trgm_ops/g)?.length ?? 0).toBe(2);
  });

  it("⭐ o nome casa sem acento (a coluna gerada continua sendo quem casa)", () => {
    expect(idsComo(USER_A, `p_org => '${ORG_A}', p_termo => 'joao'`)).toEqual([
      "43260000-2222-4000-8000-000000000001",
    ]);
  });

  it("⭐ quem não é membro da organização recebe ZERO, e não erro", () => {
    // USER_B é membro SÓ da org B. Pedir a org A tem de devolver nada.
    expect(buscarComo(USER_B, `p_org => '${ORG_A}', p_termo => 'joao'`)).toBe(0);
    // E o inverso: o termo existe na org B, e o USER_A não pode vê-lo.
    expect(buscarComo(USER_A, `p_org => '${ORG_B}', p_termo => 'joao'`)).toBe(0);
  });

  it("⭐ o service role (auth.uid() nulo) continua achando — é o caminho do MCP", () => {
    // A guarda de organização vale para quem chega com SESSÃO. Sem `sub` a
    // chamada vem do servidor, que já bypassa RLS em todo o schema; gatear ali
    // quebraria `crm_list_conversations` sem fechar nada.
    const saida = sql(`
      set role service_role;
      select count(*) from public.fn_contatos_da_busca(
        p_org => '${ORG_A}', p_termo => 'joao');
    `);
    expect(Number(lastLine(saida))).toBe(1);
  });

  it("a organização do parâmetro não pode ser furada pelo termo", () => {
    // O termo é dado do usuário. Se ele subisse para o SQL como fragmento — ou
    // se a função esquecesse o `where organization_id` — este é o caso que
    // carregaria a org B para dentro da resposta.
    expect(
      buscarComo(USER_A, `p_org => '${ORG_A}', p_termo => 'joao pereira'`),
    ).toBe(1);
    // O telefone também: o número da org B não pode aparecer para quem é da A.
    expect(
      buscarComo(USER_A, `p_org => '${ORG_A}', p_digitos => array['${TEL_ORG_B.slice(1)}']`),
    ).toBe(0);
  });

  it("anonimizado não volta a ser encontrável (LGPD)", () => {
    expect(buscarComo(USER_A, `p_org => '${ORG_A}', p_termo => 'carlos'`)).toBe(0);
    expect(
      buscarComo(USER_A, `p_org => '${ORG_A}', p_digitos => array['${CONTATOS[3]!.tel.slice(1)}']`),
    ).toBe(0);
  });

  it("ficha pessoal não é achada pela busca do Inbox (spec 21)", () => {
    expect(buscarComo(USER_A, `p_org => '${ORG_A}', p_termo => 'debora'`)).toBe(0);
  });

  it("dentro da aba Pessoal o sinal INVERTE, e só a ficha do dono casa (#4434)", () => {
    // O mesmo termo, o mesmo usuário: fora da aba, ZERO (caso acima). Dentro
    // dela, `p_pessoal` inverte — mas o dono vai junto, então a ficha de mesmo
    // nome do colega (USER_B) continua fora. Sem `p_dono`, o parâmetro abriria
    // a ficha pessoal de todo mundo, que é o vazamento que o #4434 fechou.
    expect(
      idsComo(
        USER_A,
        `p_org => '${ORG_A}', p_termo => 'debora', p_pessoal => true, p_dono => '${USER_A}'`,
      ),
    ).toEqual(["43260000-2222-4000-8000-000000000005"]);
  });

  it("o telefone EXTRA acha a ficha", () => {
    expect(idsComo(USER_A, `p_org => '${ORG_A}', p_digitos => array['${TEL_EXTRA.slice(1)}']`)).toEqual([
      "43260000-2222-4000-8000-000000000003",
    ]);
  });

  it("o `%` digitado continua LITERAL, não curinga", () => {
    // "100% Fidelidade" existe. Escapado (`\%`), o termo casa essa ficha; sem o
    // escape, `%` é curinga e casa a organização inteira (o teto de 120 ids).
    expect(buscarComo(USER_A, `p_org => '${ORG_A}', p_termo => '100\\% fid'`)).toBe(1);
    expect(buscarComo(USER_A, `p_org => '${ORG_A}', p_termo => '%'`)).toBe(120);
  });

  it("termo vazio não devolve a organização inteira", () => {
    expect(buscarComo(USER_A, `p_org => '${ORG_A}'`)).toBe(0);
  });

  it("os grants fecham `anon` e abrem só a sessão e o servidor", () => {
    const linha = lastLine(
      sql(`
        select has_function_privilege('anon', 'public.fn_contatos_da_busca(uuid,text,text[],integer,boolean,uuid)', 'execute')::text
            || ',' ||
               has_function_privilege('authenticated', 'public.fn_contatos_da_busca(uuid,text,text[],integer,boolean,uuid)', 'execute')::text
            || ',' ||
               has_function_privilege('service_role', 'public.fn_contatos_da_busca(uuid,text,text[],integer,boolean,uuid)', 'execute')::text;
      `),
    );
    expect(linha).toBe("false,true,true");
  });
});

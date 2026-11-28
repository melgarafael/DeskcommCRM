import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  indexExists,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * A BUSCA DO INBOX USA O ÍNDICE DE TRIGRAMA — COMO `authenticated`
 * (#1355, fatia 1, item 1 do parecer de 14/11).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 * O índice `idx_messages_body_trgm` (migration 9349) foi criado para tirar
 * `body ILIKE '%termo%'` do seq scan, e o número que o justificou (0,62 ms)
 * tinha sido medido como DONO da tabela. Sob RLS — o papel da rota — o plano é
 * outro: `ilike` não é `leakproof`, e o planejador não pode empurrá-lo para o
 * índice antes de avaliar a política. Medido com 200.000 mensagens: 2.110 ms,
 * 197.753 avaliações de `messages_select`, para devolver 3 linhas.
 *
 * A fatia conserta isso com `fn_mensagens_da_busca` (migration 9458), no molde
 * de `fn_contatos_da_busca` (#4326): o casamento de texto roda `security
 * definer`, fora da política, confere a organização contra `fn_user_org_ids()`,
 * devolve SÓ ids; o módulo relê as linhas com o client da SESSÃO por
 * `id in (...)`, e igualdade de uuid é `leakproof` — então a RLS continua
 * decidindo o que a pessoa vê. Este arquivo mede as duas metades:
 *
 *   1. o casamento CHEGA no índice (plano e contador do Postgres, não a
 *      definição do índice — um índice não usado tem a mesma definição);
 *   2. a leitura final NÃO amplia visibilidade: a função devolve os ids que
 *      casam na ORGANIZAÇÃO, e quem filtra por pessoa é a policy, na releitura.
 *
 * Sabotagem: devolver a função para `security invoker` (o desenho antigo, com o
 * `ilike` de volta dentro da RLS) deixa o caso do contador VERMELHO; apagar o
 * índice deixa o caso do plano VERMELHO.
 */

const TERMO = "xilofone-lunar-9458";

const MSG_DA_FILA = "94580000-aaaa-4000-8000-000000000001"; // conversa sem dono
const MSG_DO_B = "94580000-aaaa-4000-8000-000000000002"; // conversa do AGENT_B
const MSG_REVOGADA = "94580000-aaaa-4000-8000-000000000003";
const MSG_OCULTA = "94580000-aaaa-4000-8000-000000000004";
const MSG_CEM_POR_CENTO = "94580000-aaaa-4000-8000-000000000005";
const MSG_DUAS_PALAVRAS = "94580000-aaaa-4000-8000-000000000006";

/** Outra organização: existe só para provar que o termo não atravessa tenant. */
const ORG_B = "94580000-0000-4000-8000-0000000000b1";
const USER_ORG_B = "94580000-1111-4000-8000-0000000000b1";
const CONTACT_ORG_B = "94580000-3333-4000-8000-0000000000b1";
const SESSION_ORG_B = "94580000-2222-4000-8000-0000000000b1";
const CONV_ORG_B = "94580000-4444-4000-8000-0000000000b1";
const MSG_ORG_B = "94580000-aaaa-4000-8000-0000000000b1";

/** O predicado da função, sem plpgsql — é ele que o plano abaixo mede. */
function casamento(org: string, padrao: string, limite = 150): string {
  return `
    select m.id from public.messages m
     where m.organization_id = '${org}'
       and m.body ilike '${padrao}'
       and m.revoked_at is null
       and m.metadata->>'crm_hidden_at' is null
     order by m.sent_at desc
     limit ${limite};`;
}

/** Chama a função como a pessoa, pelo mesmo caminho de `auth.uid()` da produção. */
function idsComo(usuario: string, argumentos: string): string[] {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    select coalesce(string_agg(message_id::text, ','), '-')
      from public.fn_mensagens_da_busca(${argumentos});
  `);
  const linha = lastLine(saida);
  return linha === "-" ? [] : linha.split(",");
}

/**
 * A RELEITURA que o módulo faz: ids da função, linhas pelo client da sessão.
 * `countAs` roda como `authenticated`, então é a policy quem responde.
 */
function releituraComo(usuario: string, org: string, padrao: string): number {
  return countAs(
    usuario,
    `select count(*) from public.messages m
      where m.id = any (select f.message_id from public.fn_mensagens_da_busca(
              p_org => '${org}', p_termo => '${padrao}', p_limite => 150) f)
        and m.revoked_at is null
        and m.metadata->>'crm_hidden_at' is null;`,
  );
}

beforeAll(() => {
  seedGov();

  const scriptDoSeed = `
    -- Os eventos de mensagem (trg_messages_emit_event) não interessam a este
    -- arquivo: o que se mede é PLANO. Desligá-los evita 20 mil eventos no
    -- enchimento, e é o mesmo recurso que o seed de medição do PR usa.
    set session_replication_role = replica;

    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG_B}', 'invariante-9458-b', 'Invariante 9458 B', 'Inv 9458 B')
    on conflict (id) do nothing;

    insert into auth.users (id, email)
    values ('${USER_ORG_B}', 'agente.b.9458@invariant.test')
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${USER_ORG_B}', '${ORG_B}', 'manager', now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${SESSION_ORG_B}', '${ORG_B}', 'inv-9458-b', '\\x00'::bytea)
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name)
    values ('${CONTACT_ORG_B}', '${ORG_B}', 'Contato 9458 B')
    on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
    values ('${CONV_ORG_B}', '${ORG_B}', '${CONTACT_ORG_B}', '${SESSION_ORG_B}', 'open')
    on conflict (id) do nothing;

    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body, metadata, revoked_at)
    values
      ('${MSG_DA_FILA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}',
       '${GOV_CONTACT_1}', 'text', 'inbound', 'a fila tambem fala de ${TERMO}', '{}'::jsonb, null),
      ('${MSG_DO_B}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${GOV_SESSION}',
       '${GOV_CONTACT_2}', 'text', 'inbound', 'so falo disso com o dono: ${TERMO}', '{}'::jsonb, null),
      -- Revogada e oculta: existem na tabela, o fio não as mostra, a busca
      -- também não pode devolvê-las pela porta dos fundos.
      ('${MSG_REVOGADA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}',
       '${GOV_CONTACT_1}', 'text', 'inbound', 'revogada mas ainda com ${TERMO}', '{}'::jsonb, now()),
      ('${MSG_OCULTA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}',
       '${GOV_CONTACT_1}', 'text', 'inbound', 'oculta no CRM mas ainda com ${TERMO}',
       '{"crm_hidden_at":"2026-01-01T00:00:00Z"}'::jsonb, null),
      -- O "%" digitado tem de continuar LITERAL; o "*" vira "%" no módulo, e é
      -- o formato que chega aqui. (Nada de crase dentro deste template: crase
      -- fecha o literal e o script do seed vira NaN — foi medido.)
      ('${MSG_CEM_POR_CENTO}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}',
       '${GOV_CONTACT_1}', 'text', 'inbound', 'desconto de 100% fechado no mes', '{}'::jsonb, null),
      ('${MSG_DUAS_PALAVRAS}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}',
       '${GOV_CONTACT_1}', 'text', 'inbound', 'pedido de orcamento urgente', '{}'::jsonb, null),
      ('${MSG_ORG_B}', '${ORG_B}', '${CONV_ORG_B}', '${SESSION_ORG_B}',
       '${CONTACT_ORG_B}', 'text', 'inbound', 'outra empresa falando de ${TERMO}', '{}'::jsonb, null)
    on conflict (id) do nothing;
  `;
  sql(scriptDoSeed);

  // ─── 20.000 mensagens de enchimento, em lotes ───────────────────────────────
  //
  // O volume é o que dá ao planejador motivo de preferir o GIN. Medido nesta
  // forma (corpo de ~200 caracteres, ordem por `sent_at`): 20 mil já invertem o
  // plano para `Bitmap Index Scan`; abaixo de ~5 mil a tabela cabe em poucas
  // páginas e o seq scan é mais barato DE VERDADE — a asserção mediria o tamanho
  // da tabela, não o defeito. Em lotes de 5.000 porque um `insert ... select`
  // grande demais estoura o lock table do container de teste.
  for (let lote = 0; lote < 4; lote++) {
    const de = lote * 5000 + 1;
    sql(`
      set session_replication_role = replica;
      insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      select gen_random_uuid(), '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}',
             '${GOV_SESSION}', '${GOV_CONTACT_1}', 'text', 'inbound',
             'enchimento ' || g || ' ' || repeat('palavra comum do dia a dia ', 8)
        from generate_series(${de}, ${de + 4999}) g;
    `);
  }

  // Leitura de conferência do próprio seed: se a preparação não plantou as
  // linhas, a asserção do índice mediria uma tabela sem o termo e passaria por
  // engano (índice usado para devolver zero). Um número fora do esperado aqui
  // falha com o retrato na mão, em vez de virar um vermelho confuso adiante.
  const retrato = lastLine(
    sql(`select (select count(*) from public.messages where id in
                    ('${MSG_DA_FILA}','${MSG_DO_B}','${MSG_REVOGADA}','${MSG_OCULTA}',
                     '${MSG_CEM_POR_CENTO}','${MSG_DUAS_PALAVRAS}'))
                || '/' || (select count(*) from public.messages where organization_id = '${GOV_ORG}')
                || '/' || (select count(*) from public.conversations where organization_id = '${GOV_ORG}')
                || '/' || (select count(*) from public.messages where organization_id = '${GOV_ORG}' and body ilike '%${TERMO}%')
                || '/' || (select count(*) from public.messages where id::text like '94580000-aaaa%');`),
  );
  expect(
    retrato,
    `seed não plantou o que os casos medem: esperado 6 ids 9458 na org A / 20.006 mensagens / 3 conversas / 4 com o termo / 7 ids 9458 no total`,
  ).toBe(
    "6/20006/3/4/7",
  );

  // A LISTA PENDENTE DO GIN TEM DE ESTAR LIMPA — o GIN nasce com `fastupdate` e
  // o planejador cobra a varredura da lista ao estimar o custo do índice. Sem
  // limpar, a asserção mediria a idade da lista, não o índice (é o mesmo
  // cuidado do invariante da busca de contatos).
  sql(`
    do $limpa$
    begin
      if to_regclass('idx_messages_body_trgm') is not null then
        perform gin_clean_pending_list('idx_messages_body_trgm');
      end if;
    end
    $limpa$;
    vacuum analyze public.messages;
    set session_replication_role = origin;
  `);
});

describe("a busca do Inbox usa o índice de trigrama", () => {
  it("⭐ o PLANO do casamento é `Bitmap Index Scan` em `idx_messages_body_trgm`", () => {
    // Roda como dono da tabela porque é o papel da função (`security definer`)
    // — é exatamente essa a razão de a função existir. O caso seguinte mostra o
    // contraste sob RLS.
    const plano = sql(`explain (format text, costs off) ${casamento(GOV_ORG, `%${TERMO}%`)}`);

    expect(plano, `o plano não usa o índice de trigrama:\n${plano}`).toContain(
      "idx_messages_body_trgm",
    );
    expect(plano, `o plano não é de índice:\n${plano}`).toMatch(/Bitmap Index Scan|Index Scan/);
  });

  it("⛔ a MESMA consulta sob `authenticated` NÃO usa o índice — o defeito que a função contorna", () => {
    // `ilike` não é `leakproof`: com a política no caminho, o planejador não
    // pode empurrá-lo para o índice e o plano vira varredura da organização.
    // Se algum dia o plano passar a usar o índice sob RLS, este caso fica
    // vermelho — e aí a função pode ser dispensada.
    const plano = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
      explain (format text, costs off) ${casamento(GOV_ORG, `%${TERMO}%`)};
    `);

    expect(plano, `o plano sob RLS passou a usar o índice:\n${plano}`).not.toContain(
      "idx_messages_body_trgm",
    );
    expect(plano, `o plano deixou de ser varredura — reveja o desenho:\n${plano}`).toContain(
      "Seq Scan",
    );
  });

  it("⭐ a chamada de verdade, como `authenticated`, passa pelo índice (contador do Postgres)", () => {
    const contador = () => {
      const saida = sql(`
        select pg_stat_force_next_flush();
        select coalesce(sum(idx_scan), 0) from pg_stat_user_indexes
         where indexrelname = 'idx_messages_body_trgm';
      `);
      return Number(lastLine(saida));
    };

    const antes = contador();
    const ids = idsComo(GOV_AGENT_A, `p_org => '${GOV_ORG}', p_termo => '${TERMO}'`);
    const depois = contador();

    expect(ids.length).toBe(2);
    expect(
      depois - antes,
      "a função não passou pelo idx_messages_body_trgm — o casamento voltou a varrer a " +
        "organização. Sem o índice a busca continua CORRETA e fica LENTA: é o defeito do parecer.",
    ).toBeGreaterThan(0);
  });

  it("⭐ a função devolve os ids da ORGANIZAÇÃO inteira; quem filtra por pessoa é a RLS", () => {
    // O contrato da fatia, explícito: a função não decide visibilidade fina —
    // ela só acelera QUAIS ids podem casar. O AGENT_A recebe os dois ids...
    expect(idsComo(GOV_AGENT_A, `p_org => '${GOV_ORG}', p_termo => '${TERMO}'`)).toHaveLength(2);

    // ...e a releitura por id, que é o que o módulo faz, devolve só o que ele
    // pode abrir: a conversa da fila (sem dono). A do AGENT_B fica de fora.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.messages m
          where m.id = any (select f.message_id from public.fn_mensagens_da_busca(
                  p_org => '${GOV_ORG}', p_termo => '${TERMO}') f);`,
      ),
    ).toBe(1);

    // O dono vê a dele e a da fila; o manager vê as duas.
    expect(
      countAs(
        GOV_AGENT_B,
        `select count(*) from public.messages m
          where m.id = any (select f.message_id from public.fn_mensagens_da_busca(
                  p_org => '${GOV_ORG}', p_termo => '${TERMO}') f);`,
      ),
    ).toBe(2);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.messages m
          where m.id = any (select f.message_id from public.fn_mensagens_da_busca(
                  p_org => '${GOV_ORG}', p_termo => '${TERMO}') f);`,
      ),
    ).toBe(2);
  });

  it("⭐ quem não é membro da organização recebe ZERO, e não erro", () => {
    expect(idsComo(GOV_AGENT_A, `p_org => '${ORG_B}', p_termo => '${TERMO}'`)).toEqual([]);
    expect(idsComo(USER_ORG_B, `p_org => '${GOV_ORG}', p_termo => '${TERMO}'`)).toEqual([]);
  });

  it("⭐ o termo não atravessa organização: a mensagem da org B só sai para a org B", () => {
    expect(idsComo(USER_ORG_B, `p_org => '${ORG_B}', p_termo => '${TERMO}'`)).toEqual([MSG_ORG_B]);
    // A prova de que ela existe e casaria: o mesmo termo, medido como dono.
    expect(
      lastLine(sql(`select count(*) from public.messages where id = '${MSG_ORG_B}' and body ilike '%${TERMO}%';`)),
    ).toBe("1");
  });

  it("⭐ o service role (auth.uid() nulo) continua achando — é o caminho do MCP", () => {
    const saida = sql(`
      set role service_role;
      select count(*) from public.fn_mensagens_da_busca(
        p_org => '${GOV_ORG}', p_termo => '${TERMO}');
    `);
    expect(lastLine(saida)).toBe("2");
  });

  it("mensagem revogada e mensagem oculta no CRM ficam fora", () => {
    // As duas existem e casam o termo; o fio não as mostra, então a busca não
    // as devolve — nem pela função, nem pela releitura.
    expect(
      lastLine(sql(`select count(*) from public.messages
                     where id in ('${MSG_REVOGADA}', '${MSG_OCULTA}') and body ilike '%${TERMO}%';`)),
    ).toBe("2");
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}', p_termo => '${TERMO}'`)).toHaveLength(2);
    expect(releituraComo(GOV_MANAGER, GOV_ORG, `%${TERMO}%`)).toBe(2);
  });

  it("o `%` digitado continua LITERAL e o `*` vira `%` (o módulo traduz)", () => {
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}', p_termo => '100\\%'`)).toEqual([
      MSG_CEM_POR_CENTO,
    ]);
    // Duas palavras: o módulo manda `pedido%orcamento` (era `pedido*orcamento`
    // no `ilike` do PostgREST, que traduz `*` para `%`).
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}', p_termo => 'pedido%orcamento'`)).toEqual([
      MSG_DUAS_PALAVRAS,
    ]);
  });

  it("termo vazio não devolve a organização inteira", () => {
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}'`)).toEqual([]);
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}', p_termo => ''`)).toEqual([]);
  });

  it("o teto de linhas é respeitado", () => {
    // Com 20 mil mensagens de enchimento, `%` casa tudo — e a função devolve no
    // máximo o que o chamador pediu.
    expect(idsComo(GOV_MANAGER, `p_org => '${GOV_ORG}', p_termo => '%', p_limite => 120`)).toHaveLength(
      120,
    );
  });

  it("os grants fecham `anon` e abrem só a sessão e o servidor", () => {
    const linha = lastLine(
      sql(`
        select has_function_privilege('anon', 'public.fn_mensagens_da_busca(uuid,text,integer)', 'execute')::text
            || ',' ||
               has_function_privilege('authenticated', 'public.fn_mensagens_da_busca(uuid,text,integer)', 'execute')::text
            || ',' ||
               has_function_privilege('service_role', 'public.fn_mensagens_da_busca(uuid,text,integer)', 'execute')::text;
      `),
    );
    expect(linha).toBe("false,true,true");
  });

  it("o índice é GIN de trigrama sobre `body` (não é outro índice com nome parecido)", () => {
    expect(indexExists("idx_messages_body_trgm")).toBe(true);
    const definicao = sql(`select pg_get_indexdef('public.idx_messages_body_trgm'::regclass);`);
    expect(definicao).toContain("USING gin");
    expect(definicao).toContain("gin_trgm_ops");
    expect(definicao).toContain("body");
  });
});

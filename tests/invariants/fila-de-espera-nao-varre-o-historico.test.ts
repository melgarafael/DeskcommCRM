import { beforeAll, describe, expect, it } from "vitest";

import { comPreFiltroDoComando, comandosDaFila, preFiltroDoComando } from "@/lib/inbox/comando-da-conversa";

import { sql } from "./psql-transporte";

/**
 * A FILA DE ESPERA NÃO PODE VARRER O HISTÓRICO ENCERRADO (issue #4325, item 2).
 *
 * A aba Fila pede `comando_da_conversa in ('aguardando','ninguem')` e ordena por
 * `ORDEM_DA_ESPERA` (`awaiting_since asc, id asc`, lib/inbox/comando-da-conversa.ts).
 * O pré-filtro do item 1 (commit b64b3c4f64) já impede `comando_da_conversa` de rodar
 * em linha que ela recusaria — mas nenhum índice servia o conjunto que sobra:
 * `idx_conversations_open_unassigned` é da Fila antiga (`status = 'open'`, ordem por
 * `last_inbound_at`) e `conversations_org_sector_awaiting` é parcial em `sector_id`.
 * O plano era Seq Scan da organização inteira mais `Sort`.
 *
 * Medido neste repositório (pg15, banco deste harness, o cenário abaixo — 60.000
 * conversas, 48.000 delas no histórico, 120 na fila):
 *
 *     lista da Fila (limit 51)   Seq Scan,  60.000 linhas lidas,  2.714 buffers
 *     lista da Fila (limit 51)   Bitmap no índice, 120 linhas,      686 buffers
 *     contagem da Fila           Seq Scan,  60.000 linhas lidas,  2.310 buffers
 *     contagem da Fila           Bitmap no índice, 120 linhas,      486 buffers
 *
 * E o "depois" NÃO cresce com o histórico: com 120.000 conversas o mesmo plano mediu
 * 685 buffers, enquanto o "antes" subiu para 4.343. Custo proporcional ao tamanho da
 * FILA (dezenas de linhas) em vez do histórico (que cresce sem limite) é o que a
 * issue pede; é essa propriedade que este arquivo guarda.
 *
 * ## Por que a consulta é montada a partir do fonte de produção, e não copiada
 *
 * Copiar o texto do `where` mediria a cópia. Aqui os dois predicados que importam —
 * a lista de comandos e os status encerrados — vêm de `comandosDaFila` e
 * `preFiltroDoComando`, os MESMOS que a lista e as contagens chamam. Se alguém
 * mexer na régua (tirar `resolved`, acrescentar um comando), a consulta medida muda
 * junto e o índice deixa de casar — que é exatamente o defeito que esta cerca existe
 * para pegar. `comando_da_conversa` é `stable security definer` e o Postgres não a
 * abre em predicado: o índice só é usável porque os predicados equivalentes estão
 * escritos na consulta.
 *
 * ## Segunda ponta: o índice tem de vir do `baseline.sql`
 *
 * O banco desta suíte é construído SÓ do `supabase/baseline.sql` — que é o que o
 * self-host aplica. Migration que ficasse só em `migrations/` não chegaria a
 * ninguém, e aqui isso aparece como índice ausente.
 */

const ORG = "f9357000-0000-4000-8000-000000000001";
const SESSAO = "f9357000-0000-4000-8000-0000000000c1";
const ATENDENTE = "f9357000-1111-4000-8000-000000000001";

/** Histórico encerrado — a maior parte das linhas, e o que o índice tira da frente. */
const NO_HISTORICO = 48_000;
/** Conversas abertas COM dono (humano): também fora da fila. */
const COM_DONO = 11_880;
/** A fila de verdade: "poucas dezenas de conversas", como no relato da issue. */
const NA_FILA = 120;

/** `q.limit + 1` — o handler pede um a mais para saber se há próxima página. */
const LIMITE_DA_TELA = 51;

/** O teto do "depois", folgado sobre os 686 medidos (fillfactor/visibility map variam). */
const TETO_DE_BUFFERS = 1_200;
/** Nenhuma linha do histórico pode aparecer como descartada pelo filtro. */
const TETO_DE_DESCARTADAS = 1_000;

function idDeContato(i: number): string {
  return `f9357000-2222-4000-8000-${String(i).padStart(12, "0")}`;
}

/** `where` da aba Fila como os dois consumidores o montam, com ou sem o pré-filtro. */
function filtroDaFila(comPreFiltro: boolean): { lista: string; preFiltro: string } {
  const comandos = comandosDaFila(true);
  const pre = preFiltroDoComando(comandos);
  if (!pre) {
    throw new Error(
      "preFiltroDoComando devolveu null para os comandos da Fila — o item 1 (#4325) regrediu e o índice não tem como ser usado",
    );
  }
  const lista = comandos.map((c) => `'${c}'`).join(", ");
  const fechados = pre.statusEncerrados.map((s) => `'${s}'`).join(", ");
  const preFiltro = comPreFiltro
    ? `and assigned_to_user_id is null
   and status not in (${fechados})`
    : "";
  return { lista, preFiltro };
}

/** A consulta da LISTA da Fila: mesmas colunas de ordem/limite do `_handler`. */
function consultaDaLista(comPreFiltro: boolean): string {
  const { lista, preFiltro } = filtroDaFila(comPreFiltro);
  return `select id, organization_id, status, assigned_to_user_id, awaiting_since,
       last_message_at, unread_count_for_assignee, created_at,
       public.comando_da_conversa(conversations) as comando
  from public.conversations
 where organization_id = '${ORG}'
   ${preFiltro}
   and public.comando_da_conversa(conversations) in (${lista})
 order by awaiting_since asc nulls last, id asc
 limit ${LIMITE_DA_TELA}`;
}

/** A contagem da aba Fila (`count: 'exact'`, `head: true` → `count(*)` sem ordem). */
function consultaDaContagem(comPreFiltro: boolean): string {
  const { lista, preFiltro } = filtroDaFila(comPreFiltro);
  return `select count(*) from (
    select 1 from public.conversations
     where organization_id = '${ORG}'
       ${preFiltro}
       and public.comando_da_conversa(conversations) in (${lista})
  ) t`;
}

/** Soma `hit=`/`read=` da PRIMEIRA linha `Buffers:` — a do nó de topo. */
function buffersDoTopo(plano: string): number {
  const linha = plano.split("\n").find((l) => l.includes("Buffers:")) ?? "";
  return [...linha.matchAll(/(?:hit|read)=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
}

/** Maior `Rows Removed by Filter` do plano — quantas linhas o filtro descartou. */
function descartadasPeloFiltro(plano: string): number {
  const valores = [...plano.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1]));
  return valores.length === 0 ? 0 : Math.max(...valores);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings)
    values ('${ORG}', 'f9357-fila', 'Org 9357 Fila', 'Org 9357 Fila', '{}'::jsonb)
    on conflict (id) do nothing;

    insert into auth.users (id, email)
    values ('${ATENDENTE}', 'atendente-f9357@invariant.test')
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${ATENDENTE}', '${ORG}', 'agent', now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
    values ('${SESSAO}', '${ORG}', 'f9357', '\\x00'::bytea)
    on conflict (id) do nothing;

    -- Um contato por conversa: \`uniq_conversations_1to1_per_contact_session\` impede
    -- duas conversas do mesmo contato no mesmo canal.
    insert into public.contacts (id, organization_id, display_name)
    select ('f9357000-2222-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
           '${ORG}', 'Contato 9357 ' || i
      from generate_series(1, ${NO_HISTORICO + COM_DONO + NA_FILA}) i
    on conflict (id) do nothing;

    -- Abertas COM dono (humano).
    insert into public.conversations
      (organization_id, contact_id, channel_session_id, status, assigned_to_user_id,
       assigned_at, awaiting_since, last_message_at, created_at, last_inbound_at)
    select '${ORG}',
           ('f9357000-2222-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
           '${SESSAO}', 'claimed', '${ATENDENTE}',
           now() - (i || ' minutes')::interval,
           now() - (i || ' minutes')::interval,
           now() - (i || ' minutes')::interval,
           now() - ((i + 5000) || ' minutes')::interval,
           now() - ((i + 5000) || ' minutes')::interval
      from generate_series(1, ${COM_DONO}) i;

    -- O histórico encerrado, com e sem dono — o que o índice deixa de fora.
    insert into public.conversations
      (organization_id, contact_id, channel_session_id, status, assigned_to_user_id,
       assigned_at, awaiting_since, last_message_at, created_at, last_inbound_at)
    select '${ORG}',
           ('f9357000-2222-4000-8000-' || lpad((i + ${COM_DONO})::text, 12, '0'))::uuid,
           '${SESSAO}',
           (array['closed','archived','resolved'])[1 + (i % 3)],
           case when i % 4 = 0 then null else '${ATENDENTE}'::uuid end,
           now() - ((i + 30) || ' days')::interval,
           now() - ((i + 30) || ' days')::interval,
           now() - ((i + 30) || ' days')::interval,
           now() - ((i + 60) || ' days')::interval,
           now() - ((i + 60) || ' days')::interval
      from generate_series(1, ${NO_HISTORICO}) i;

    -- A fila: sem dono, abertas, esperando. Metade calada (\`aguardando\`), metade
    -- atendida pelo automático (\`automatico\`).
    insert into public.conversations
      (organization_id, contact_id, channel_session_id, status, assigned_to_user_id,
       awaiting_since, last_message_at, created_at, last_inbound_at, bot_silenced_until)
    select '${ORG}',
           ('f9357000-2222-4000-8000-' || lpad((i + ${COM_DONO + NO_HISTORICO})::text, 12, '0'))::uuid,
           '${SESSAO}', 'open', null,
           now() - ((i % 300) || ' minutes')::interval,
           now() - ((i % 300) || ' minutes')::interval,
           now() - ((i + 1000) || ' minutes')::interval,
           now() - ((i % 300) || ' minutes')::interval,
           case when i % 2 = 0 then now() + interval '1 day' else null end
      from generate_series(1, ${NA_FILA}) i;

    analyze public.conversations;
    analyze public.contacts;
  `);
});

describe("fila de espera × índice do histórico", () => {
  it("controle: o cenário tem o volume que este arquivo promete", () => {
    const [total = "", naFila = ""] = sql(`
      select count(*),
             count(*) filter (where assigned_to_user_id is null
                                and status not in ('closed','archived','resolved'))
        from public.conversations
       where organization_id = '${ORG}';
    `).split("|");
    expect(Number(total)).toBe(NO_HISTORICO + COM_DONO + NA_FILA);
    // Exatamente a fila: as linhas do histórico que estão sem dono também estão
    // `resolved`/`archived`/`closed`, então o conjunto do pré-filtro é o da aba.
    expect(Number(naFila)).toBe(NA_FILA);
  });

  it("o pré-filtro do produto é o predicado do índice: mesmas colunas, mesmos status", () => {
    const pre = preFiltroDoComando(comandosDaFila(true));
    expect(pre, "o pré-filtro sumiu para os comandos da Fila").not.toBeNull();
    expect(pre?.semDono).toBe(true);
    expect([...(pre?.statusEncerrados ?? [])]).toEqual(["closed", "archived", "resolved"]);

    const definicao = sql(`
      select pg_get_indexdef(c.oid)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'idx_conversations_fila_espera';
    `);
    expect(definicao, "idx_conversations_fila_espera não existe no banco vindo do baseline").toContain(
      "USING btree (organization_id, awaiting_since, id)",
    );
    expect(definicao, "o índice deixou de ser parcial no pré-filtro do comando").toContain(
      "WHERE ((assigned_to_user_id IS NULL) AND (status <> ALL (",
    );
    for (const status of pre?.statusEncerrados ?? []) {
      expect(definicao, `o índice não exclui '${status}', que o pré-filtro exclui`).toContain(
        `'${status}'::text`,
      );
    }
  });

  it("o índice chegou pelo baseline, com o COMMENT delator", () => {
    const comentario = sql(`
      select coalesce(obj_description(c.oid, 'pg_class'), '')
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'idx_conversations_fila_espera';
    `);
    // Sem o índice, este COMMENT levanta "relation does not exist" no `update.sh`;
    // apagá-lo por parecer enfeite devolve o modo de falha silencioso.
    expect(comentario, "o COMMENT delator do índice sumiu do espelho").toContain(
      "Fila de espera do Inbox",
    );
  });

  it("a lista da Fila lê só a fila — o histórico não entra no plano", () => {
    const plano = sql(`explain (analyze, buffers) ${consultaDaLista(true)}`);

    expect(plano, "a lista da Fila voltou a varrer `conversations` inteira").not.toMatch(
      /Seq Scan on conversations/,
    );
    expect(plano).toMatch(/(Bitmap )?Index (Only )?Scan (using|on) idx_conversations_fila_espera\b/);
    expect(descartadasPeloFiltro(plano), `linhas descartadas pelo filtro:\n${plano}`).toBeLessThan(
      TETO_DE_DESCARTADAS,
    );
    // 2.714 buffers é o Seq Scan medido; 686 é o índice. O teto guarda a ORDEM DE
    // GRANDEZA — o número exato depende de fillfactor e do visibility map.
    expect(buffersDoTopo(plano), `buffers do nó de topo:\n${plano}`).toBeLessThan(TETO_DE_BUFFERS);
  });

  it("a contagem da Fila também — as seis contagens param de ler o histórico", () => {
    const plano = sql(`explain (analyze, buffers) ${consultaDaContagem(true)}`);

    expect(plano).not.toMatch(/Seq Scan on conversations/);
    expect(plano).toMatch(/(Bitmap )?Index (Only )?Scan (using|on) idx_conversations_fila_espera\b/);
    expect(buffersDoTopo(plano), `buffers do nó de topo:\n${plano}`).toBeLessThan(TETO_DE_BUFFERS);
  });

  it("o pré-filtro não muda a RESPOSTA — só o plano", () => {
    // A equivalência é a premissa do índice: `assigned_to_user_id is null` e
    // `status not in (...)` são condição NECESSÁRIA de 'aguardando'/'automatico'
    // (fn_comando_da_conversa, baseline.sql). Se algum dia deixarem de ser, este
    // caso cai — e o índice passaria a esconder conversa da fila.
    const comFiltro = Number(sql(consultaDaContagem(true)));
    const semFiltro = Number(sql(consultaDaContagem(false)));
    expect(semFiltro).toBeGreaterThan(0);
    expect(comFiltro).toBe(semFiltro);
  });

  it("controle: SEM o pré-filtro o índice não é usado — a função é opaca ao planner", () => {
    // Prova que o ganho do índice está amarrado ao item 1 (b64b3c4f64), e não ao
    // índice sozinho. Se este caso ficar com plano indexado, ou o Postgres passou a
    // abrir a função, ou a consulta deixou de ser a de produção.
    const plano = sql(`explain (analyze, buffers) ${consultaDaLista(false)}`);
    expect(plano, "a consulta sem pré-filtro deixou de varrer a tabela").toMatch(
      /Seq Scan on conversations/,
    );
  });
});

import { beforeAll, describe, expect, it } from "vitest";

import { mediana } from "@/lib/metrics/mediana-e-recorte-por-etiqueta";

import { sql } from "./gov-helpers";

/**
 * #3212 — a MEDIANA da 1ª resposta e o RECORTE por ETIQUETA DO CONTATO, contra
 * o banco REAL do baseline (o que nenhum teste de texto alcança).
 *
 * Três provas, e uma delas é a que a issue pede explicitamente:
 *
 *   1. **A MÉDIA NÃO MUDOU.** A função nova e a régua de referência
 *      (`ref_fn_attendant_metrics`, criada aqui com o corpo de `origin/main`)
 *      devolvem a MESMA média, para o mesmo recorte e o mesmo atendente. A
 *      mediana entra como campo NOVO — a referência não tem esse campo, e é
 *      isso que prova que ele nasceu nesta migration, não que já existia.
 *
 *   2. **A MEDIANA é a do módulo puro.** `mediana()` de
 *      `lib/metrics/mediana-e-recorte-por-etiqueta.ts` e o
 *      `percentile_cont(0.5)` do Postgres são postos lado a lado sobre a MESMA
 *      amostra: 60/120/180/300/600/900 s. Se as duas réguas divergirem — o
 *      caminho por onde uma "segunda versão da verdade" entra —, é aqui.
 *
 *   3. **O RECORTE por etiqueta tira da conta o que tem de tirar.** Dois
 *      contatos carregam a etiqueta, um deles com ` Fornecedor ` (espaço e
 *      caixa do jeito que o operador digitou): os dois saem — a normalização
 *      `lower(btrim(...))` é a mesma do par TS. E o total excluído é DECLARADO.
 *
 * E o não-caso, medido junto: atendente com conversa contada mas SEM par
 * válido devolve mediana `null` — NUNCA `0`, que diria "respondeu na hora zero".
 *
 * Namespace c3212… (exclusivo deste arquivo). Sem PII: @invariant.test.
 * Timestamps LITERAIS para agregações determinísticas.
 */

const ORG = "c3212000-0000-4000-8000-000000000001";
const AGENT = "c3212111-0000-4000-8000-000000000001";
const OUTRO = "c3212111-0000-4000-8000-000000000002";
const MANAGER = "c3212111-0000-4000-8000-000000000003";
const SESSION = "c3212222-0000-4000-8000-000000000001";

/**
 * UM CONTATO POR CONVERSA: `uniq_conversations_1to1_per_contact_session` recusa
 * duas conversas do MESMO contato na MESMA sessão (medido: com dois contatos só o
 * `insert` caía nessa constraint e o arquivo inteiro virava SKIP — verde sem
 * medir nada, o pior dos mundos). Dois destes contatos carregam a etiqueta — um
 * deles com espaço e caixa do jeito que o operador digita.
 */
const CT_60 = "c3212444-0000-4000-8000-000000000001";
const CT_120 = "c3212444-0000-4000-8000-000000000002";
const CT_180 = "c3212444-0000-4000-8000-000000000003";
const CT_300 = "c3212444-0000-4000-8000-000000000004";
const CT_600 = "c3212444-0000-4000-8000-000000000005";
const CT_900 = "c3212444-0000-4000-8000-000000000006";
const CT_BOT = "c3212444-0000-4000-8000-000000000007";

/** Conversas do AGENT: 6 pares válidos, um por linha de amostra. */
const CV_60 = "c3212555-0000-4000-8000-000000000001";
const CV_120 = "c3212555-0000-4000-8000-000000000002";
const CV_180 = "c3212555-0000-4000-8000-000000000003";
const CV_300 = "c3212555-0000-4000-8000-000000000004";
const CV_600 = "c3212555-0000-4000-8000-000000000005";
const CV_900 = "c3212555-0000-4000-8000-000000000006";
/** CONVERSAS DO OUTRO: uma contada, sem par válido (só a IA respondeu). */
const CV_OUTRO_BOT = "c3212555-0000-4000-8000-000000000007";

const DE = "2026-07-15T00:00:00+00";
const ATE = "2026-07-16T00:00:00+00";

/**
 * A RÉGUA DE REFERÊNCIA — o corpo de `fn_attendant_metrics` em `origin/main`
 * (0037/0235/0266/0596), sem a mediana e sem o recorte por etiqueta. É a
 * comparação que a issue pede: a média tem de ser a MESMA.
 */
const REF_ATENDENTES = `
create or replace function public.ref_fn_attendant_metrics(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $ref$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (
        where status = 'lost'
          and coalesce(lost_reason, '') <> 'moved_to_another_pipeline'
      ) as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  voice_agg as (
    select
      owner_user_id as user_id,
      count(*) as calls_answered,
      coalesce(sum(duration_ms), 0)::bigint as call_ms
    from public.voice_calls
    where organization_id = p_org
      and owner_user_id is not null
      and answered_at is not null
      and answered_at >= p_from and answered_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
    union select user_id from voice_agg
  )
  select jsonb_build_object(
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds,
          'calls_answered', coalesce(va.calls_answered, 0),
          'call_seconds', (coalesce(va.call_ms, 0) / 1000)::bigint
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
      left join voice_agg va on va.user_id = a.user_id
    ), '[]'::jsonb)
  );
$ref$;
`;

/** A amostra do AGENT, em segundos — a MESMA que as seeds abaixo produzem. */
const AMOSTRA = [60, 120, 180, 300, 600, 900];

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT}',   'm3212-agent@invariant.test'),
      ('${OUTRO}',   'm3212-outro@invariant.test'),
      ('${MANAGER}', 'm3212-manager@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'm3212-mediana', 'M3212 Mediana Org', 'M3212 Mediana')
    on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT}',   '${ORG}', 'agent',   now()),
      ('${OUTRO}',   '${ORG}', 'agent',   now()),
      ('${MANAGER}', '${ORG}', 'manager', now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, display_name) values
      ('${SESSION}', '${ORG}', 'm3212-s1', '\\\\x00'::bytea, 'Numero 3212');

    -- Dois contatos carregam a etiqueta — um deles com espaço e caixa do jeito
    -- que o operador digita (" Fornecedor "). Os outros não a carregam.
    insert into public.contacts (id, organization_id, display_name, tags) values
      ('${CT_60}',  '${ORG}', 'M3212 Cliente 60s',     array['cliente']),
      ('${CT_120}', '${ORG}', 'M3212 Fornecedor 120s', array['fornecedor']),
      ('${CT_180}', '${ORG}', 'M3212 Fornecedor 180s', array['cliente', ' Fornecedor ']),
      ('${CT_300}', '${ORG}', 'M3212 Cliente 300s',    '{}'::text[]),
      ('${CT_600}', '${ORG}', 'M3212 Cliente 600s',    array['cliente']),
      ('${CT_900}', '${ORG}', 'M3212 Cliente 900s',    '{}'::text[]),
      ('${CT_BOT}', '${ORG}', 'M3212 Contato do bot',  '{}'::text[]);

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
    values
      ('${CV_60}',        '${ORG}', '${CT_60}',       '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      ('${CV_120}',       '${ORG}', '${CT_120}',          '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      ('${CV_180}',       '${ORG}', '${CT_180}', '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      ('${CV_300}',       '${ORG}', '${CT_300}',     '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      ('${CV_600}',       '${ORG}', '${CT_600}',       '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      ('${CV_900}',       '${ORG}', '${CT_900}',     '${SESSION}', 'claimed', '${AGENT}', '${DE}', 'user'),
      -- Contada, mas SEM par válido: só a IA respondeu (bot fica de fora da
      -- régua) — é a linha que prova mediana nula, nunca zero.
      ('${CV_OUTRO_BOT}', '${ORG}', '${CT_BOT}',       '${SESSION}', 'claimed', '${OUTRO}', '${DE}', 'user');

    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at)
    values
      ('${ORG}', '${CV_60}',  '${SESSION}', '${CT_60}',       'text', 'inbound',  'crm',  null,       '2026-07-15T10:00:00+00'),
      ('${ORG}', '${CV_60}',  '${SESSION}', '${CT_60}',       'text', 'outbound', 'user', '${AGENT}', '2026-07-15T10:01:00+00'),
      ('${ORG}', '${CV_120}', '${SESSION}', '${CT_120}',          'text', 'inbound',  'crm',  null,       '2026-07-15T11:00:00+00'),
      ('${ORG}', '${CV_120}', '${SESSION}', '${CT_120}',          'text', 'outbound', 'user', '${AGENT}', '2026-07-15T11:02:00+00'),
      ('${ORG}', '${CV_180}', '${SESSION}', '${CT_180}', 'text', 'inbound',  'crm',  null,       '2026-07-15T12:00:00+00'),
      ('${ORG}', '${CV_180}', '${SESSION}', '${CT_180}', 'text', 'outbound', 'user', '${AGENT}', '2026-07-15T12:03:00+00'),
      ('${ORG}', '${CV_300}', '${SESSION}', '${CT_300}',     'text', 'inbound',  'crm',  null,       '2026-07-15T13:00:00+00'),
      ('${ORG}', '${CV_300}', '${SESSION}', '${CT_300}',     'text', 'outbound', 'user', '${AGENT}', '2026-07-15T13:05:00+00'),
      ('${ORG}', '${CV_600}', '${SESSION}', '${CT_600}',       'text', 'inbound',  'crm',  null,       '2026-07-15T14:00:00+00'),
      ('${ORG}', '${CV_600}', '${SESSION}', '${CT_600}',       'text', 'outbound', 'user', '${AGENT}', '2026-07-15T14:10:00+00'),
      ('${ORG}', '${CV_900}', '${SESSION}', '${CT_900}',     'text', 'inbound',  'crm',  null,       '2026-07-15T15:00:00+00'),
      ('${ORG}', '${CV_900}', '${SESSION}', '${CT_900}',     'text', 'outbound', 'user', '${AGENT}', '2026-07-15T15:15:00+00'),
      ('${ORG}', '${CV_OUTRO_BOT}', '${SESSION}', '${CT_BOT}', 'text', 'inbound',  'crm',  null,       '2026-07-15T16:00:00+00'),
      ('${ORG}', '${CV_OUTRO_BOT}', '${SESSION}', '${CT_BOT}', 'text', 'outbound', 'ai',   null,       '2026-07-15T16:00:30+00');

    ${REF_ATENDENTES}
  `);
});

function como(actor: string): string {
  return `set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actor}"}', false); end $c$;`;
}

/**
 * A linha do atendente na saída da função — `null` quando ele não aparece.
 * `alvo` é QUEM a linha procurada representa (por padrão, o próprio `owner`) —
 * antes ele era o AGENT fixo, e a linha do OUTRO nunca era encontrada.
 */
function linhaDe(
  func: string,
  owner: string | null,
  etiqueta: string | null,
  alvo: string = owner ?? AGENT,
): Record<string, unknown> | null {
  const args = owner === null ? "null" : `'${owner}'`;
  // A régua de REFERÊNCIA tem QUATRO argumentos (é o corpo de `origin/main`): a
  // etiqueta só existe na função nova.
  const quinto =
    func === "fn_attendant_metrics" ? `, ${etiqueta === null ? "null::text" : `'${etiqueta}'`}` : "";
  const out = sql(`
    ${como(MANAGER)}
    with r as (
      select public.${func}('${ORG}', '${DE}', '${ATE}', ${args}${quinto}) as j
    )
    select coalesce(
      (select x::text from r, jsonb_array_elements(r.j -> 'attendants') x
        where x ->> 'user_id' = '${alvo}'),
      'NULO');
  `);
  // O psql com `-tA` imprime o command tag das instruções anteriores ("SET",
  // "DO"): o valor do SELECT é a ÚLTIMA linha não vazia — pegar a PRIMEIRA
  // devolveria "SET" e o JSON.parse estourava.
  const linhas = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const linha = linhas[linhas.length - 1] ?? "NULO";
  return linha === "NULO" ? null : (JSON.parse(linha) as Record<string, unknown>);
}

function campo(linha: Record<string, unknown> | null, chave: string): unknown {
  return linha === null ? "SEM_LINHA" : linha[chave];
}

function totalExcluido(etiqueta: string | null): number {
  const tag = etiqueta === null ? "null::text" : `'${etiqueta}'`;
  const out = sql(`
    ${como(MANAGER)}
    select public.fn_attendant_metrics('${ORG}', '${DE}', '${ATE}', null, ${tag})
             ->> 'excluded_conversations';
  `);
  return Number(out.trim().split("\n").filter(Boolean).pop());
}

function etiquetaDeclarada(etiqueta: string | null): string | null {
  const tag = etiqueta === null ? "null::text" : `'${etiqueta}'`;
  const out = sql(`
    ${como(MANAGER)}
    select coalesce(public.fn_attendant_metrics('${ORG}', '${DE}', '${ATE}', null, ${tag})
             ->> 'excluded_tag', 'NULO');
  `);
  const v = out.trim().split("\n").filter(Boolean).pop() ?? "NULO";
  return v === "NULO" ? null : v;
}

describe("#3212 — mediana da 1ª resposta e recorte por etiqueta", () => {
  it("a MEDIANA do banco é a do módulo puro, e a MÉDIA não mudou um byte", () => {
    const novo = linhaDe("fn_attendant_metrics", AGENT, null);
    // A média: o MESMO número da régua de `origin/main`.
    expect(campo(novo, "avg_first_response_seconds")).toBe(360);
    expect(campo(linhaDe("ref_fn_attendant_metrics", AGENT, null), "avg_first_response_seconds")).toBe(
      360,
    );
    // A mediana: o campo NOVO, e igual à definição do módulo puro.
    expect(campo(novo, "median_first_response_seconds")).toBe(mediana(AMOSTRA));
    expect(campo(novo, "median_first_response_seconds")).toBe(240);
    // ...e NÃO é a média, que é o defeito que esta fatia fecha.
    expect(campo(novo, "median_first_response_seconds")).not.toBe(
      campo(novo, "avg_first_response_seconds"),
    );
  });

  it("o campo da mediana NÃO existia em origin/main — nasceu nesta migration", () => {
    const ref = linhaDe("ref_fn_attendant_metrics", AGENT, null);
    expect(ref).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(ref, "median_first_response_seconds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ref, "excluded_conversations")).toBe(false);
  });

  it("sem etiqueta não há recorte: total 0, etiqueta nula e as 6 conversas contadas", () => {
    const linha = linhaDe("fn_attendant_metrics", AGENT, null);
    expect(campo(linha, "conversations_handled")).toBe(6);
    expect(totalExcluido(null)).toBe(0);
    expect(etiquetaDeclarada(null)).toBeNull();
  });

  it("a etiqueta tira da conta as DUAS conversas de fornecedor — inclusive a digitada ' Fornecedor '", () => {
    // A amostra que sobra: 60, 300, 600, 900 s.
    const restante = [60, 300, 600, 900];
    const linha = linhaDe("fn_attendant_metrics", AGENT, "fornecedor");
    expect(campo(linha, "conversations_handled")).toBe(4);
    expect(campo(linha, "avg_first_response_seconds")).toBe(465);
    expect(campo(linha, "median_first_response_seconds")).toBe(mediana(restante));
    expect(campo(linha, "median_first_response_seconds")).toBe(450);
    // O total excluído é DECLARADO, e a etiqueta usada também.
    expect(totalExcluido("fornecedor")).toBe(2);
    expect(etiquetaDeclarada("fornecedor")).toBe("fornecedor");

    // A normalização é dos DOIS lados: com espaço e caixa do operador, o corte é
    // o MESMO — `lower(btrim(...))` no SQL, `trim().toLowerCase()` no módulo TS.
    const sujo = linhaDe("fn_attendant_metrics", AGENT, " Fornecedor ");
    expect(campo(sujo, "conversations_handled")).toBe(4);
    expect(totalExcluido(" Fornecedor ")).toBe(2);
  });

  it("amostra sem par válido devolve mediana NULA, nunca zero", () => {
    // O OUTRO tem uma conversa contada (a da IA) e nenhum par válido: a média e a
    // mediana dele são nulas — "não medido", nunca "respondeu na hora zero".
    const linha = linhaDe("fn_attendant_metrics", OUTRO, null);
    expect(campo(linha, "conversations_handled")).toBe(1);
    expect(campo(linha, "avg_first_response_seconds")).toBeNull();
    expect(campo(linha, "median_first_response_seconds")).toBeNull();
    expect(campo(linha, "median_first_response_seconds")).not.toBe(0);

    // E o recorte não inventa linha: a conversa do OUTRO não carrega a etiqueta,
    // então ele continua na conta com os mesmos números.
    const comRecorte = linhaDe("fn_attendant_metrics", OUTRO, "fornecedor");
    expect(campo(comRecorte, "conversations_handled")).toBe(1);
    expect(campo(comRecorte, "median_first_response_seconds")).toBeNull();
  });
});

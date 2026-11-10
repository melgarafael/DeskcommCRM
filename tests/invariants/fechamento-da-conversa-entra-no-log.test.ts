/**
 * O ENCERRAMENTO DA CONVERSA VIRA FATO NO `event_log` (#4023).
 *
 * ## O defeito que este arquivo prende
 *
 * `fn_service_status(…, 'closed')` mudava o status e o encerramento não existia
 * no barramento: a rota gravava só a auditoria `conversation.closed`, e auditoria
 * não é evento — nenhuma automação podia reagir ao fim do atendimento. Sem o
 * fato, não existe pesquisa de satisfação nem qualquer fluxo pós-atendimento.
 *
 * O caso 1 é o RED literal: fechar uma conversa e ler o `event_log` devolvia
 * ZERO linhas de `conversation.closed`.
 *
 * ## O que este arquivo mede, além do caminho feliz
 *
 *   2. IDEMPOTÊNCIA: fechar duas vezes não duplica o fato (duas execuções).
 *   3. CONVERSA JÁ ENCERRADA: nem `fn_service_status` nem `UPDATE` direto para
 *      `closed` geram linha nova.
 *   4. OUTRA ORGANIZAÇÃO: o fato nasce com a organização DA conversa e a
 *      vizinha não ganha nada.
 *   5. LOTE: três conversas fechadas na mesma chamada = três fatos (um por
 *      conversa), nunca um só.
 *   6. FALHA AO EMITIR NÃO DERRUBA O FECHAMENTO: com `emit_event` sabotado
 *      dentro de uma transação desfeita no fim, o fechamento acontece e nenhuma
 *      linha é gravada.
 *
 * ## Por que o emissor é gatilho, e não a rota
 *
 * O fechamento tem três escritores (rota de fechamento — que o lote reusa —,
 * `PATCH` de status e a marcação de contato pessoal). Cada um deles fecha por
 * `fn_service_status` ou por `UPDATE` de `status`; o gatilho cobre os três e o
 * próximo que aparecer. É o mesmo desenho de `ai.case_closed` (0148).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const VIZINHA = "dddddddd-0000-4000-8000-000000000002";
const AGENTE = "dddddddd-1111-4000-8000-000000000001";
const SESSAO = "dddddddd-2222-4000-8000-000000000001";

/** Uma conversa por caso, para um caso não consumir o cenário do vizinho. */
const CONV = {
  feliz: "dddddddd-4444-4000-8000-000000000001",
  idempotente: "dddddddd-4444-4000-8000-000000000002",
  jaFechada: "dddddddd-4444-4000-8000-000000000003",
  lote1: "dddddddd-4444-4000-8000-000000000004",
  lote2: "dddddddd-4444-4000-8000-000000000005",
  lote3: "dddddddd-4444-4000-8000-000000000006",
  falha: "dddddddd-4444-4000-8000-000000000007",
} as const;
const CONTATO = {
  feliz: "dddddddd-3333-4000-8000-000000000001",
  idempotente: "dddddddd-3333-4000-8000-000000000002",
  jaFechada: "dddddddd-3333-4000-8000-000000000003",
  lote1: "dddddddd-3333-4000-8000-000000000004",
  lote2: "dddddddd-3333-4000-8000-000000000005",
  lote3: "dddddddd-3333-4000-8000-000000000006",
  falha: "dddddddd-3333-4000-8000-000000000007",
} as const;
const CONV_VIZINHA = "dddddddd-4444-4000-8000-0000000000fe";
const CONTATO_VIZINHO = "dddddddd-3333-4000-8000-0000000000fe";

/** Quantas linhas de `conversation.closed` a organização tem. */
function fatos(org: string = ORG): number {
  return Number(
    sql(
      `select count(*) from public.event_log where organization_id = '${org}' and event_type = 'conversation.closed';`,
    ),
  );
}

/** O status instalado da conversa, lido do banco. */
function status(conversa: string): string {
  return sql(`select status from public.conversations where id = '${conversa}';`);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${AGENTE}', 'fechamento-inv@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'fechamento-inv', 'Fechamento Invariant', 'Fechamento Inv'),
             ('${VIZINHA}', 'fechamento-inv-vizinha', 'Vizinha Invariant', 'Vizinha Inv')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${AGENTE}', '${ORG}', 'agent', now()) on conflict do nothing;
    do $fec$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'fechamento-inv', '\\x00'::bytea);
    exception when unique_violation then null; end $fec$;
    insert into public.contacts (id, organization_id, display_name)
      values ${Object.values(CONTATO)
        .map((c, i) => `('${c}', '${ORG}', 'Contato Fechamento ${i + 1}')`)
        .join(",\n             ")},
             ('${CONTATO_VIZINHO}', '${VIZINHA}', 'Contato da Vizinha')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ${Object.entries(CONV)
        .map(
          ([caso, c]) =>
            `('${c}', '${ORG}', '${CONTATO[caso as keyof typeof CONTATO]}', '${SESSAO}', ` +
            `'${caso === "jaFechada" ? "closed" : "open"}')`,
        )
        .join(",\n             ")}
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_VIZINHA}', '${VIZINHA}', '${CONTATO_VIZINHO}', '${SESSAO}', 'open')
      on conflict do nothing;
    -- Estado limpo mesmo se o arquivo rodar duas vezes no mesmo banco: as
    -- conversas voltam a 'open' (menos a do caso 3, que nasce encerrada) e os
    -- fatos desta organização são apagados. A vizinha não é tocada — o caso 4
    -- depende de ela nunca ganhar um fato.
    update public.conversations set status = 'open', service_closed_at = null
      where organization_id = '${ORG}' and id <> '${CONV.jaFechada}';
    update public.conversations set status = 'closed'
      where organization_id = '${ORG}' and id = '${CONV.jaFechada}';
    delete from public.event_log
      where organization_id = '${ORG}' and event_type = 'conversation.closed';
  `);
});

describe("encerrar a conversa emite conversation.closed no event_log", () => {
  it("RED/GREEN: fechar grava EXATAMENTE uma linha, com org, entidade e payload do fechamento", () => {
    expect(fatos()).toBe(0);

    sql(`select public.fn_service_status('${ORG}', '${CONV.feliz}', 'closed');`);

    expect(fatos()).toBe(1);
    const linha = sql(`
      select event_type || '|' || entity_kind || '|' || entity_id || '|' || organization_id
             || '|' || coalesce(payload->>'conversation_id', '-')
             || '|' || coalesce(payload->>'contact_id', '-')
             || '|' || coalesce(payload->>'closed_at', '-')
             || '|' || coalesce(metadata->>'actor_type', '-')
        from public.event_log
       where organization_id = '${ORG}' and event_type = 'conversation.closed'
         and entity_id = '${CONV.feliz}';
    `);
    const [tipo, entidade, entidadeId, org, conversa, contato, fechadoEm, ator] = linha.split("|");
    expect(tipo).toBe("conversation.closed");
    expect(entidade).toBe("conversation");
    expect(entidadeId).toBe(CONV.feliz);
    expect(org).toBe(ORG);
    // O QUE A ISSUE PEDE: a conversa. O contato e o instante do fechamento
    // poupam o consumidor de uma ida ao banco para achar de quem é o telefone.
    expect(conversa).toBe(CONV.feliz);
    expect(contato).toBe(CONTATO.feliz);
    expect(fechadoEm === "-" || fechadoEm === "").toBe(false);
    // O fechamento não tem "quem fechou" no banco (a rota grava isso na
    // auditoria); o evento se identifica como do sistema, nunca como de um
    // usuário inventado.
    expect(ator).toBe("system");

    // A linha nasce FECHADA, não `pending`: o tipo está na lista de registro
    // (`fn_event_log_e_registro`) porque ninguém o consome ainda. Sem isso todo
    // encerramento deixaria uma linha `pending` para sempre — o defeito da #753,
    // indistinguível de fila entupida.
    expect(
      sql(
        `select status from public.event_log where entity_id = '${CONV.feliz}' and event_type = 'conversation.closed';`,
      ),
    ).toBe("done");

    // E o fechamento em si continua acontecendo: status e instante gravados.
    expect(status(CONV.feliz)).toBe("closed");
    expect(
      sql(
        `select (service_closed_at is not null)::text from public.conversations where id = '${CONV.feliz}';`,
      ),
    ).toBe("true");
  });

  it("IDEMPOTÊNCIA: fechar duas vezes não duplica o fato", () => {
    const antes = fatos();
    sql(`select public.fn_service_status('${ORG}', '${CONV.idempotente}', 'closed');`);
    const depoisDaPrimeira = fatos();
    expect(depoisDaPrimeira).toBe(antes + 1);

    sql(`select public.fn_service_status('${ORG}', '${CONV.idempotente}', 'closed');`);
    expect(fatos()).toBe(depoisDaPrimeira);
    expect(status(CONV.idempotente)).toBe("closed");
  });

  it("CONVERSA JÁ ENCERRADA não gera fato novo, nem por UPDATE direto", () => {
    const antes = fatos();

    // O caminho canônico devolve a linha como está, sem UPDATE.
    sql(`select public.fn_service_status('${ORG}', '${CONV.jaFechada}', 'closed');`);
    expect(fatos()).toBe(antes);

    // E um UPDATE direto que regrava o MESMO status também não: o gatilho olha
    // a TRANSIÇÃO, não o valor.
    sql(`update public.conversations set status = 'closed' where id = '${CONV.jaFechada}';`);
    expect(fatos()).toBe(antes);
  });

  it("OUTRA ORGANIZAÇÃO: o fato nasce na org da conversa e a vizinha não ganha linha", () => {
    const antesDaVizinha = fatos(VIZINHA);
    const antesDaCasa = fatos();

    sql(`select public.fn_service_status('${ORG}', '${CONV.lote1}', 'closed');`);

    expect(fatos()).toBe(antesDaCasa + 1);
    expect(fatos(VIZINHA)).toBe(antesDaVizinha);

    // Fechar na VIZINHA grava lá, e só lá.
    sql(`select public.fn_service_status('${VIZINHA}', '${CONV_VIZINHA}', 'closed');`);
    expect(fatos(VIZINHA)).toBe(antesDaVizinha + 1);
    expect(
      sql(
        `select organization_id from public.event_log where event_type = 'conversation.closed' and entity_id = '${CONV_VIZINHA}';`,
      ),
    ).toBe(VIZINHA);
    expect(fatos()).toBe(antesDaCasa + 1);
  });

  it("LOTE: três conversas fechadas na mesma chamada geram três fatos, um por conversa", () => {
    const antes = fatos();

    // O lote da Inbox reusa a rota de fechamento item a item, que é a mesma
    // transição daqui — três chamadas na MESMA transação.
    sql(`
      begin;
      select public.fn_service_status('${ORG}', '${CONV.lote2}', 'closed');
      select public.fn_service_status('${ORG}', '${CONV.lote3}', 'closed');
      commit;
    `);

    expect(fatos()).toBe(antes + 2);
    const entidades = sql(`
      select string_agg(distinct entity_id::text, ',' order by entity_id::text)
        from public.event_log
       where organization_id = '${ORG}' and event_type = 'conversation.closed';
    `).split(",");
    // Nenhum fato agregado: cada conversa tem o seu.
    expect(entidades).toContain(CONV.lote1);
    expect(entidades).toContain(CONV.lote2);
    expect(entidades).toContain(CONV.lote3);
  });

  it("FALHA AO EMITIR não derruba o fechamento (emit_event sabotado na transação)", () => {
    // A sabotagem roda DENTRO de uma transação desfeita no fim: o emit_event de
    // verdade é renomeado e um dublê que sempre levanta ocupa o nome. É o unico
    // jeito de provar o `exception when others` sem depender de um defeito real
    // de banco — e o rollback devolve a função original.
    const saida = sql(`
      begin;
      alter function public.emit_event(text, text, uuid, jsonb, jsonb, uuid)
        rename to emit_event_sabotado_pelo_teste;
      create function public.emit_event(
        p_event_type text, p_entity_kind text, p_entity_id uuid,
        p_payload jsonb default '{}'::jsonb, p_metadata jsonb default '{}'::jsonb,
        p_organization_id uuid default null
      ) returns uuid language plpgsql as $sab$
      begin
        raise exception 'sabotagem: o barramento esta fora do ar';
      end $sab$;
      select public.fn_service_status('${ORG}', '${CONV.falha}', 'closed');
      select 'fechou=' || (select status from public.conversations where id = '${CONV.falha}')
             || '|fatos=' || (select count(*) from public.event_log
                               where entity_id = '${CONV.falha}'
                                 and event_type = 'conversation.closed')::text;
      rollback;
    `);

    // A linha do marcador é a última antes do ROLLBACK.
    const marcador = saida.split("\n").filter((l) => l.startsWith("fechou=")).pop();
    expect(marcador).toBe("fechou=closed|fatos=0");

    // Depois do rollback, a conversa continua aberta e o emit_event original
    // está de volta: a sabotagem não vazou para os outros casos.
    expect(status(CONV.falha)).toBe("open");
    expect(
      sql(
        `select count(*) from pg_proc where proname = 'emit_event_sabotado_pelo_teste' and pronamespace = 'public'::regnamespace;`,
      ),
    ).toBe("0");
  });
});

import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * ANONIMIZAR UM CONTATO APAGA O TEXTO DAS MENSAGENS AGENDADAS PARA ELE — E O
 * QUE AINDA NÃO SAIU NÃO SAI MAIS.
 *
 * `mensagens_agendadas` (migration 9336, #3118) guarda o texto que a empresa
 * vai mandar para a pessoa — "Oi Maria, lembrete da sua consulta". A entrada em
 * `DIVIDA_LGPD_CONHECIDA` afirma que o gatilho da virada de `is_anonymized` a
 * protege; este arquivo é a prova de COMPORTAMENTO dessa frase.
 *
 * Três metades: o texto some; o pendente vira `cancelada` (senão o cron mandaria
 * '[redigido]' a um contato anonimizado); e o histórico do que JÁ saiu fica
 * (status e horário são a trilha da empresa, não dado da pessoa).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "9336a000-0000-4000-8000-00000000000a";
const SESS = "9336a000-5555-4000-8000-000000000001";
const ALVO = "9336a000-2222-4000-8000-000000000001";
const VIZINHO = "9336a000-2222-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'agendada-lgpd', 'Agendada LGPD', 'Agendada LGPD') on conflict (id) do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESS}', '${ORG}', 'agendada-lgpd', '\\x00'::bytea) on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${ALVO}',    '${ORG}', 'Maria Silva'),
      ('${VIZINHO}', '${ORG}', 'Joao Pereira')
      on conflict (id) do nothing;
  `);
  for (const contato of [ALVO, VIZINHO]) {
    sql(`
      with conv as (
        insert into public.conversations (organization_id, contact_id, channel_session_id)
        select '${ORG}', '${contato}', '${SESS}'
         where not exists (select 1 from public.conversations where contact_id = '${contato}')
        returning id
      ), c as (
        select id from conv union all select id from public.conversations where contact_id = '${contato}'
      )
      insert into public.mensagens_agendadas
        (organization_id, conversation_id, contact_id, channel_session_id, title, body, scheduled_at, status)
      select '${ORG}', (select id from c limit 1), '${contato}', '${SESS}', t.title, t.body, t.quando, t.status
        from (values
          ('Lembrete', 'Oi ' || (select name from public.contacts where id = '${contato}') || ', lembrete da consulta', now() + interval '1 day', 'agendada'),
          ('Saiu', 'Oi ' || (select name from public.contacts where id = '${contato}') || ', obrigado', now() - interval '1 day', 'encaminhada')
        ) as t(title, body, quando, status)
       where not exists (select 1 from public.mensagens_agendadas where contact_id = '${contato}');
    `);
  }
});

/** `pendente` = a linha do futuro (semeada `agendada`); senão, a que já saiu. */
function linha(contato: string, pendente: boolean): string {
  return sql(`select coalesce(title, '<null>') || '|' || body || '|' || status
                from public.mensagens_agendadas
               where contact_id = '${contato}' and scheduled_at ${pendente ? ">" : "<"} now();`);
}

describe("a anonimização de LGPD alcança as mensagens agendadas do contato", () => {
  it("ANTES: o nome está legível no texto agendado (controle positivo)", () => {
    // Sem isto, um seed que falhasse em silêncio deixaria o resto verde por ausência de linha.
    expect(linha(ALVO, true)).toBe("Lembrete|Oi Maria Silva, lembrete da consulta|agendada");
    expect(linha(ALVO, false)).toBe("Saiu|Oi Maria Silva, obrigado|encaminhada");
  });

  it("anonimizar pela cascata real apaga o texto e cancela o que ainda não saiu", () => {
    // A FUNÇÃO REAL da cascata, não um `update is_anonymized` à mão: é por onde a
    // anonimização passa, e o gatilho dispara dentro da transação dela.
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    expect(linha(ALVO, true)).toBe("<null>|[redigido]|cancelada");
    expect(sql(`select motivo from public.mensagens_agendadas where contact_id = '${ALVO}' and status = 'cancelada';`)).toBe(
      "contato_anonimizado",
    );
  });

  it("...e o que já saiu fica com o status que tinha, só sem o texto", () => {
    expect(linha(ALVO, false)).toBe("<null>|[redigido]|encaminhada");
  });

  it("o agendamento de OUTRO contato não é tocado", () => {
    expect(linha(VIZINHO, true)).toBe("Lembrete|Oi Joao Pereira, lembrete da consulta|agendada");
  });
});

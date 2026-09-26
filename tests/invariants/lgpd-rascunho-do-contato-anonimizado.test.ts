import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * ANONIMIZAR UM CONTATO APAGA OS RASCUNHOS SUGERIDOS DAS CONVERSAS DELE.
 *
 * `conversation_drafts` (migration 0419, #1611) guarda o texto que uma
 * integração escreveu PARA a pessoa ("Oi Maria, seu boleto venceu"). A tabela
 * não tem FK para `contacts` — aponta para a conversa —, então fica fora de
 * `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts`, que deriva o escopo dessa
 * FK. Sem o trigger `trg_apagar_rascunhos_ao_anonimizar`, a anonimização
 * devolveria sucesso e o texto seguiria legível. Este arquivo é o único gate que
 * vê essa tabela pelo lado da LGPD.
 *
 * As duas metades importam: um trigger que apagasse por organização (e não por
 * contato) deixaria a primeira verde e apagaria o trabalho de outro cliente.
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

const ORG = "7a5f0000-0000-4000-8000-00000000041a";
const SESSAO = "7a5f0000-5555-4000-8000-000000000419";
const ALVO = "7a5f0000-2222-4000-8000-000000000419";
const VIZINHO = "7a5f0000-2222-4000-8000-00000000041b";
const CONV_ALVO = "7a5f0000-4444-4000-8000-000000000419";
const CONV_VIZINHO = "7a5f0000-4444-4000-8000-00000000041b";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'rascunho-lgpd', 'Rascunho LGPD', 'Rascunho LGPD') on conflict (id) do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'rascunho-lgpd', '\\x00'::bytea) on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${ALVO}',    '${ORG}', 'Maria Silva'),
      ('${VIZINHO}', '${ORG}', 'Joao Pereira')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV_ALVO}',    '${ORG}', '${ALVO}',    '${SESSAO}', 'open'),
      ('${CONV_VIZINHO}', '${ORG}', '${VIZINHO}', '${SESSAO}', 'open')
      on conflict (id) do nothing;
    insert into public.conversation_drafts (organization_id, conversation_id, body, source, expires_at)
    select '${ORG}', c.id, 'Oi ' || ct.name || ', seu boleto venceu', 'erp', now() + interval '24 hours'
      from public.conversations c join public.contacts ct on ct.id = c.contact_id
     where c.id in ('${CONV_ALVO}', '${CONV_VIZINHO}')
       and not exists (select 1 from public.conversation_drafts d where d.conversation_id = c.id);
  `);
});

function rascunhos(conversa: string): string {
  return sql(`select coalesce(string_agg(body, '|'), '<vazio>') from public.conversation_drafts
               where conversation_id = '${conversa}';`);
}

describe("a anonimização de LGPD alcança os rascunhos sugeridos do contato", () => {
  it("ANTES: o nome está legível no rascunho (controle positivo)", () => {
    expect(rascunhos(CONV_ALVO)).toContain("Maria");
  });

  it("anonimizar o contato apaga os rascunhos das conversas dele", () => {
    // A função REAL da cascata, não um `update is_anonymized` à mão: o trigger
    // tem de disparar pelo caminho que a produção usa.
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    expect(rascunhos(CONV_ALVO)).toBe("<vazio>");
  });

  it("o rascunho da conversa de OUTRO contato não é tocado", () => {
    expect(rascunhos(CONV_VIZINHO)).toContain("Joao");
  });
});

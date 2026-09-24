import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * ANONIMIZAR PELA TELA REDIGE A CONVERSA, NÃO SÓ A FICHA (migration 0391).
 *
 * Há dois caminhos que anonimizam um contato:
 *
 *   fn_lgpd_cascade_redact_contact   o pedido formal de redact
 *   fn_lgpd_anonymize_contact        o botão "Anonimizar contato" da ficha
 *
 * O formal redigia mensagens e conversas; o botão só reescrevia o contato. Pela
 * tela, o nome e o CPF que a pessoa escreveu ficavam no corpo das mensagens, no
 * `last_message_preview` (o cabeçalho da ficha anonimizada) e no resumo do
 * agente (`lead_checkpoints`) — que nenhum dos dois caminhos alcançava.
 *
 * O caso da tela NÃO chama a RPC do botão (ela exige sessão com MFA provado):
 * reproduz o UPDATE que ela faz, como `lgpd-alcanca-campos-personalizados-do-contato`
 * já faz. É o fato `is_anonymized` virar true que precisa redigir, seja quem for
 * que o vire.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "03910000-0000-4000-8000-00000000000a";
const SESSAO = "03910000-0000-4000-8000-0000000000c5";
const VIA_TELA = "03910000-1111-4000-8000-000000000001";
const VIA_PEDIDO = "03910000-1111-4000-8000-000000000002";
const VIZINHO = "03910000-1111-4000-8000-000000000003";
const CONVERSA: Record<string, string> = {
  [VIA_TELA]: "03910000-2222-4000-8000-000000000001",
  [VIA_PEDIDO]: "03910000-2222-4000-8000-000000000002",
  [VIZINHO]: "03910000-2222-4000-8000-000000000003",
};

const NOME = "Bruno Almeida Feliz";
const CPF = "52998224725";

beforeAll(() => {
  const porContato = [VIA_TELA, VIA_PEDIDO, VIZINHO]
    .map(
      (c, i) => `
    insert into public.contacts (id, organization_id, name, display_name)
      values ('${c}', '${ORG}', '${NOME}', '${NOME}');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, last_message_preview, metadata)
      values ('${CONVERSA[c]}', '${ORG}', '${c}', '${SESSAO}', 'open', 'meu cpf é ${CPF}', '{"push_name":"${NOME}"}'::jsonb);
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_storage_path)
    values
      ('${ORG}', '${CONVERSA[c]}', '${SESSAO}', '${c}', 'text', 'inbound', 'received', 'crm', 'sou ${NOME}, cpf ${CPF}', null),
      ('${ORG}', '${CONVERSA[c]}', '${SESSAO}', '${c}', 'image', 'inbound', 'received', 'crm', 'foto do documento', '${ORG}/doc-${i}.jpg');
    insert into public.lead_checkpoints (organization_id, contact_id, rolling_summary, commitments, next_action)
      values ('${ORG}', '${c}', '${NOME} informou o CPF ${CPF}', '["ligar para ${NOME}"]'::jsonb, 'confirmar com ${NOME}');`,
    )
    .join("\n");
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-conversas-0391', 'LGPD Conversas', 'LGPD Conversas');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'lgpd-conversas-0391', '\\x00'::bytea);
    ${porContato}
  `);
});

/** Tudo que, sobre este contato, ainda contém o nome ou o CPF. */
function residuo(contato: string): string {
  return sql(`
    select string_agg(onde, ',' order by onde) from (
      select 'messages' as onde from public.messages
       where conversation_id = '${CONVERSA[contato]}'
         and (body ilike '%${CPF}%' or body ilike '%Bruno%' or media_storage_path is not null)
      union
      select 'conversations' from public.conversations
       where id = '${CONVERSA[contato]}'
         and (last_message_preview is not null or metadata <> '{}'::jsonb)
      union
      select 'lead_checkpoints' from public.lead_checkpoints
       where contact_id = '${contato}'
         and (rolling_summary ilike '%Bruno%' or commitments::text ilike '%Bruno%' or next_action is not null)
    ) r;
  `);
}

function fila(contato: string): string {
  const i = [VIA_TELA, VIA_PEDIDO, VIZINHO].indexOf(contato);
  return sql(`
    select count(*) from public.storage_redaction_queue
     where bucket = 'whatsapp-media' and object_path = '${ORG}/doc-${i}.jpg' and status = 'pending';
  `);
}

describe("anonimizar redige mensagens, conversa e resumo do agente", () => {
  it("ANTES: nome e CPF estão nos três lugares, nos três contatos (controle positivo)", () => {
    for (const c of [VIA_TELA, VIA_PEDIDO, VIZINHO]) {
      expect(residuo(c)).toBe("conversations,lead_checkpoints,messages");
    }
  });

  it("⭐ pela TELA: o mesmo UPDATE de fn_lgpd_anonymize_contact redige tudo e enfileira a mídia", () => {
    sql(`
      update public.contacts set
        name = null,
        display_name = 'Contato Anonimizado #03910000',
        email = null, phone_number = null, cpf_encrypted = null, cpf_hash = null, birthdate = null,
        is_anonymized = true, anonymized_at = now(), updated_at = now()
      where organization_id = '${ORG}' and id = '${VIA_TELA}';
    `);
    expect(residuo(VIA_TELA)).toBe("");
    // O arquivo da foto não pode perder o único ponteiro que o levava ao expurgo.
    expect(fila(VIA_TELA)).toBe("1");
  });

  it("⭐ pelo PEDIDO formal: o resumo do agente também é redigido (antes, nenhum caminho o alcançava)", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${VIA_PEDIDO}', null);`);
    expect(residuo(VIA_PEDIDO)).toBe("");
    expect(fila(VIA_PEDIDO)).toBe("1");
  });

  it("a mensagem continua existindo — redige, não apaga (a conversa mantém a linha do tempo)", () => {
    expect(
      sql(`select count(*) from public.messages where conversation_id = '${CONVERSA[VIA_TELA]}';`),
    ).toBe("2");
  });

  it("edição normal do contato NÃO redige — o gatilho é da virada, não de todo UPDATE", () => {
    sql(`update public.contacts set display_name = 'Bruno A. Feliz' where id = '${VIZINHO}';`);
    expect(residuo(VIZINHO)).toBe("conversations,lead_checkpoints,messages");
    expect(fila(VIZINHO)).toBe("0");
  });
});

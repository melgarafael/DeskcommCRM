/**
 * A poda de mídia (migration 0432) NÃO apaga arquivo que outra mensagem ainda usa.
 *
 * A foto de catálogo tem caminho FIXO por conversa e é reaproveitada a cada
 * reenvio (`lib/agent-engine/agent/fotos-do-produto.ts`): a mesma foto enviada
 * há 100 e há 10 dias é UM arquivo só. Sem a guarda, a mensagem vencida levava
 * o arquivo para a fila e a de 10 dias ficava apontando para nada.
 *
 * Arquivo à parte de `poda-de-midia.test.ts` porque `tests/invariants/**` é
 * congelado: invariante novo entra em arquivo novo.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "43200000-0000-4000-8000-000000000001";
const CONTATO = "43200000-0000-4000-8000-000000000002";
const SESSAO = "43200000-0000-4000-8000-000000000003";
const CONVERSA = "43200000-0000-4000-8000-000000000004";
const MSG_VELHA = "43200000-0000-4000-8000-000000000010";
const MSG_RECENTE = "43200000-0000-4000-8000-000000000011";

const FOTO = `${ORG}/${CONVERSA}/catalogo-camiseta.jpg`;

const naFila = (p: string) =>
  Number(
    lastLine(
      sql(`select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`),
    ),
  );
const caminhoDe = (id: string) =>
  lastLine(sql(`select coalesce(media_storage_path, 'NULO') from messages where id = '${id}'`));

function mensagem(id: string, idadeDias: number): string {
  return `('${id}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'image', 'outbound', 'delivered',
           null, 'external_device', now() - interval '${idadeDias} days', now() - interval '${idadeDias} days', '${FOTO}')`;
}

beforeEach(() => {
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media') on conflict (id) do nothing;
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from storage.objects where name like '${ORG}/%';
    delete from messages where organization_id = '${ORG}';
    delete from conversations where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name, media_retention_days)
      values ('${ORG}', 'org-midia-432', 'Org Midia 432 LTDA', 'Org Midia 432', 30)
      on conflict (id) do update set media_retention_days = 30;
    insert into contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Cliente', '+5511900000432');
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'midia-432', 'WORKING', '\\x00'::bytea);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open', false);
    insert into storage.objects (bucket_id, name, metadata, created_at)
      values ('whatsapp-media', '${FOTO}', '{"size": 1000}'::jsonb, now() - interval '100 days');
  `);
});

describe("fn_enfileirar_midia_vencida com caminho compartilhado", () => {
  it("controle: sozinha, a mensagem vencida leva o arquivo para a fila", () => {
    sql(`
      insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                            type, direction, status, body, sent_via, sent_at, created_at, media_storage_path)
        values ${mensagem(MSG_VELHA, 100)};
    `);
    sql(`select public.fn_enfileirar_midia_vencida(500)`);
    expect(naFila(FOTO)).toBe(1);
    expect(caminhoDe(MSG_VELHA)).toBe("NULO");
  });

  it("com outra mensagem ainda na retenção, o arquivo fica e só a vencida perde a referência", () => {
    sql(`
      insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                            type, direction, status, body, sent_via, sent_at, created_at, media_storage_path)
        values ${mensagem(MSG_VELHA, 100)}, ${mensagem(MSG_RECENTE, 10)};
    `);
    sql(`select public.fn_enfileirar_midia_vencida(500)`);
    expect(naFila(FOTO)).toBe(0);
    expect(caminhoDe(MSG_VELHA)).toBe("NULO");
    expect(caminhoDe(MSG_RECENTE)).toBe(FOTO);
  });
});

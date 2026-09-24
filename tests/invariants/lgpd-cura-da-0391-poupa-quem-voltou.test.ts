import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A cura da migration 0391 redige o que contatos anonimizados PELA TELA tinham
 * antes do gatilho existir — e é reaplicada a cada `update.sh`, porque o kit
 * reaplica o baseline inteiro. Um contato anonimizado que volta a escrever
 * (religado pelo LID) tem conversa NOVA: a reaplicação não pode redigi-la nem
 * mandar a mídia dela para o apagamento, que não tem volta. A régua é
 * `anonymized_at`. Achado da revisão adversarial do #1501.
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

const ORG = "03911000-0000-4000-8000-00000000000a";
const SESSAO = "03911000-0000-4000-8000-0000000000c5";
const CONTATO = "03911000-1111-4000-8000-000000000001";
const CONVERSA = "03911000-2222-4000-8000-000000000001";

function cura(): void {
  const dir = join(process.cwd(), "supabase/migrations");
  const arquivo = readdirSync(dir).find((n) => /_0391_/.test(n));
  if (!arquivo) throw new Error("migration 0391 não encontrada");
  const migration = readFileSync(join(dir, arquivo), "utf8");
  sql(migration.slice(migration.indexOf("-- Cura:")));
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-cura-0391', 'LGPD Cura', 'LGPD Cura');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'lgpd-cura-0391', '\\x00'::bytea);
    insert into public.contacts (id, organization_id, name, display_name)
      values ('${CONTATO}', '${ORG}', 'Carla Nunes', 'Carla Nunes');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, last_message_preview)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open', 'sou a Carla');
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_storage_path)
    values ('${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'image', 'inbound', 'received', 'crm', 'sou a Carla', '${ORG}/antiga.jpg');
    update public.contacts set name = null, display_name = 'Contato Anonimizado #03911000',
           is_anonymized = true, anonymized_at = now(), updated_at = now()
     where id = '${CONTATO}';
  `);
  // Ela volta pelo WhatsApp DEPOIS da anonimização.
  sql(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, media_storage_path, created_at)
    values ('${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'image', 'inbound', 'received', 'crm',
            'voltei, quero orçamento', '${ORG}/nova.jpg', now() + interval '1 minute');
    update public.conversations set last_message_preview = 'voltei, quero orçamento',
           last_message_at = now() + interval '1 minute'
     where id = '${CONVERSA}';
  `);
});

describe("a cura da 0391 para em anonymized_at", () => {
  it("controle: a mensagem de ANTES da anonimização já está redigida (pelo gatilho)", () => {
    expect(sql(`select count(*) from public.messages where conversation_id = '${CONVERSA}' and body = 'sou a Carla';`)).toBe("0");
  });

  it("⭐ reaplicar a cura (update.sh) poupa a mensagem, o preview e a mídia de DEPOIS", () => {
    cura();
    cura();
    expect(
      sql(`select count(*) from public.messages where conversation_id = '${CONVERSA}' and body = 'voltei, quero orçamento' and media_storage_path = '${ORG}/nova.jpg';`),
    ).toBe("1");
    expect(sql(`select last_message_preview from public.conversations where id = '${CONVERSA}';`)).toBe("voltei, quero orçamento");
    expect(sql(`select count(*) from public.storage_redaction_queue where object_path = '${ORG}/nova.jpg';`)).toBe("0");
  });
});

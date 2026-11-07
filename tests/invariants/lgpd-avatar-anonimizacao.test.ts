import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Invariantes da foto de perfil sob anonimização LGPD (migration 0099).
 *
 * Este arquivo existe porque a foto de perfil é DADO PESSOAL e o repo já perdeu
 * uma cascata de redação inteira por um defeito que um teste com RPC mockado não
 * viu — o teste conferia a própria mentira. Aqui NADA é mockado: a
 * `fn_lgpd_cascade_redact_contact` roda de verdade, no Postgres de verdade, e as
 * asserções são sobre o estado que ela deixa.
 *
 * A divisão de responsabilidade com `tests/unit/lgpd-redact-avatar.test.ts` é
 * deliberada: aqui provamos o que é do BANCO (o que a RPC faz e o que não faz, a
 * constraint que sustenta a idempotência, o escopo que o cron enxerga); lá
 * provamos o que é do APP (a ordem das operações e a remoção do objeto). O caminho
 * do app usa o client do Supabase via PostgREST, que nesta suíte aponta de
 * propósito para uma porta fechada — por isso ele não pode ser exercitado daqui.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "afa00000-0000-4000-8000-000000000001";
const ORG_VIZINHA = "afa00000-0000-4000-8000-0000000000ff";
const REQ = "afa00000-0000-4000-8000-000000000002";

/** Caminho no mesmo formato que o cron grava: `{org}/avatars/{contato}.jpg`. */
const caminhoAvatar = (contatoId: string) => `${ORG}/avatars/${contatoId}.jpg`;

/**
 * Cria um contato com foto. `phone_number` importa: `wa_identity` é uma coluna
 * GERADA a partir dele, e é ela que o cron usa para decidir quem varrer.
 */
async function criarContatoComFoto(id: string, telefone: string, org = ORG): Promise<string> {
  await pool.query(
    `insert into contacts (id, organization_id, display_name, phone_number, avatar_storage_path, avatar_updated_at)
     values ($1, $2, 'Contato Com Foto', $3, $4, now())
     on conflict (id) do update set
       avatar_storage_path = excluded.avatar_storage_path,
       phone_number        = excluded.phone_number,
       is_anonymized       = false,
       anonymized_at       = null`,
    [id, org, telefone, `${org}/avatars/${id}.jpg`],
  );
  return `${org}/avatars/${id}.jpg`;
}

/** A sequência que `cascadeRedactContact` executa, na ordem em que a executa. */
async function anonimizarComoOApp(contatoId: string): Promise<void> {
  const { rows } = await pool.query<{ avatar_storage_path: string | null }>(
    `select avatar_storage_path from contacts where id = $1 and organization_id = $2`,
    [contatoId, ORG],
  );
  const caminho = rows[0]?.avatar_storage_path ?? null;

  if (caminho) {
    // `on conflict do nothing` espelha o 23505 que o app captura: a fila é
    // idempotente por (bucket, object_path).
    await pool.query(
      `insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
       values ($1, $2, 'whatsapp-media', $3)
       on conflict (bucket, object_path) do nothing`,
      [ORG, REQ, caminho],
    );
    await pool.query(
      `update contacts set avatar_storage_path = null, avatar_updated_at = now()
       where id = $1 and organization_id = $2`,
      [contatoId, ORG],
    );
  }

  await pool.query(`select fn_lgpd_cascade_redact_contact($1, $2, $3)`, [ORG, contatoId, REQ]);
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "avatar-lgpd-proof"],
    [ORG_VIZINHA, "avatar-lgpd-vizinha"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  await pool.query(
    `insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
     values ($1, $2, 'redact', 'manual', 'contact', now() + interval '15 days')
     on conflict (id) do nothing`,
    [REQ, ORG],
  );
});

afterAll(async () => {
  await pool.query(`delete from storage_redaction_queue where organization_id = any($1::uuid[])`, [
    [ORG, ORG_VIZINHA],
  ]);
  await pool.query(`delete from contacts where organization_id = any($1::uuid[])`, [
    [ORG, ORG_VIZINHA],
  ]);
  await pool.query(`delete from lgpd_requests where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = any($1::uuid[])`, [[ORG, ORG_VIZINHA]]);
  await pool.end();
});

describe("foto de perfil sob anonimização LGPD", () => {
  it("a RPC de cascata solta o caminho do avatar e põe o arquivo na fila", async () => {
    // Soltar o ponteiro sem enfileirar é o cenário do arquivo órfão: o contato
    // vira anônimo e o rosto fica no bucket sem ninguém saber o caminho (9243).
    const id = "afa00000-0000-4000-8000-00000000000a";
    const caminho = await criarContatoComFoto(id, "+5511900000001");

    await pool.query(`select fn_lgpd_cascade_redact_contact($1, $2, $3)`, [ORG, id, REQ]);

    const { rows } = await pool.query<{ avatar_storage_path: string | null; is_anonymized: boolean }>(
      `select avatar_storage_path, is_anonymized from contacts where id = $1`,
      [id],
    );
    expect(rows[0]?.is_anonymized).toBe(true);
    expect(rows[0]?.avatar_storage_path).toBeNull();
    const fila = await pool.query<{ status: string }>(
      `select status from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $1`,
      [caminho],
    );
    expect(fila.rows[0]?.status).toBe("pending");
  });

  it("depois de anonimizado o contato sai do escopo do cron — o rosto não é rebaixado", async () => {
    // Duas defesas independentes, e o teste cobra as duas: o filtro explícito
    // `is_anonymized = false` do cron E `wa_identity`, que é GERADA de
    // phone_number/source_metadata e vira NULL porque a RPC zera os dois.
    const id = "afa00000-0000-4000-8000-00000000000b";
    await criarContatoComFoto(id, "+5511900000002");

    await anonimizarComoOApp(id);

    const { rows } = await pool.query<{ wa_identity: string | null; is_anonymized: boolean }>(
      `select wa_identity, is_anonymized from contacts where id = $1`,
      [id],
    );
    expect(rows[0]?.is_anonymized).toBe(true);
    expect(rows[0]?.wa_identity).toBeNull();

    // A query do cron, literalmente.
    const { rows: varridos } = await pool.query(
      `select id from contacts
        where wa_identity is not null
          and is_anonymized = false
          and (avatar_updated_at is null or avatar_updated_at < now() - interval '7 days')
          and id = $1`,
      [id],
    );
    expect(varridos).toHaveLength(0);
  });

  it("a fila recusa o mesmo objeto duas vezes — a idempotência é do banco, não do app", async () => {
    const objeto = `${ORG}/avatars/duplicata-proposital.jpg`;
    await pool.query(
      `insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
       values ($1, $2, 'whatsapp-media', $3)`,
      [ORG, REQ, objeto],
    );

    // Sem `on conflict`: queremos ver a constraint agir, não o app contorná-la.
    await expect(
      pool.query(
        `insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
         values ($1, $2, 'whatsapp-media', $3)`,
        [ORG, REQ, objeto],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("anonimizar duas vezes deixa UMA linha na fila, não duas", async () => {
    const id = "afa00000-0000-4000-8000-00000000000c";
    const caminho = await criarContatoComFoto(id, "+5511900000003");

    await anonimizarComoOApp(id);
    // Segunda passada: a RPC devolve already_anonymized e não faz nada; o
    // enfileiramento do app roda de novo e não pode duplicar.
    await anonimizarComoOApp(id);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from storage_redaction_queue
        where bucket = 'whatsapp-media' and object_path = $1`,
      [caminho],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("anonimizar contato de uma organização não enfileira o avatar de outra", async () => {
    const alvo = "afa00000-0000-4000-8000-00000000000d";
    const vizinho = "afa00000-0000-4000-8000-00000000000e";
    await criarContatoComFoto(alvo, "+5511900000004");
    await criarContatoComFoto(vizinho, "+5511900000005", ORG_VIZINHA);

    await anonimizarComoOApp(alvo);

    const { rows } = await pool.query<{ avatar_storage_path: string | null; is_anonymized: boolean }>(
      `select avatar_storage_path, is_anonymized from contacts where id = $1`,
      [vizinho],
    );
    expect(rows[0]?.is_anonymized).toBe(false);
    expect(rows[0]?.avatar_storage_path).toBe(`${ORG_VIZINHA}/avatars/${vizinho}.jpg`);

    const { rows: fila } = await pool.query(
      `select id from storage_redaction_queue where organization_id = $1`,
      [ORG_VIZINHA],
    );
    expect(fila).toHaveLength(0);
  });

  it("o índice do cron é o PARCIAL — um composto por organização não serve à varredura global", async () => {
    // O cron varre a plataforma inteira, sem filtrar organização. Com
    // organization_id na coluna líder o planner não percorre em ordem de
    // avatar_updated_at e cai em seq scan + top-N sort. Este teste é o que
    // impede alguém de "padronizar" o índice de volta.
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'idx_contacts_avatar_refresh'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/\(avatar_updated_at/);
    expect(def).toMatch(/WHERE .*wa_identity IS NOT NULL/i);
    expect(def).toMatch(/is_anonymized = false/i);
    expect(def).not.toMatch(/\(organization_id/);
  });
});

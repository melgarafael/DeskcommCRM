import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { GOV_MANAGER, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * #3315 — o caminho em SQL que preenche telefone de ficha vazia
 * (`fn_upsert_wa_contact`) passa a emitir `contact.phone_added`, e só na
 * TRANSIÇÃO; a junção de fichas (`fn_mesclar_contatos`) NÃO emite.
 *
 * Os caminhos em TypeScript estão cobertos pelos dublês em
 * `lib/channels/zernio/` e `tests/unit/contacts/`. Os do banco, dublê nenhum
 * alcança: este arquivo é o único lugar onde a emissão real — a linha em
 * `event_log` — pode ser medida.
 *
 * O que ele prende, caminho por caminho:
 *
 *   1. `fn_upsert_wa_contact` preenche a ficha vazia → UM `contact.phone_added`,
 *      com o contato e a org certos e o número canônico no payload.
 *   2. A SEGUNDA chamada com o mesmo número não emite — a ficha já não estava
 *      vazia (é o lado "não emitir" que um contador de emissões não pegaria).
 *   3. A PROMOÇÃO de grafia (12 → 13 dígitos do MESMO número) não é ganho de
 *      telefone: o contato já era alcançável naquele número, e a issue nomeia o
 *      evento como "ganhar um telefone", não "mudar a escrita dele".
 *   4. Contato NOVO não emite: ninguém ganhou nada — nasceu com o número.
 *   5. `fn_mesclar_contatos` com o vencedor VAZIO herda o número do perdedor e
 *      NÃO emite: as duas fichas já existiam e o número já estava no CRM, então
 *      emitir repetiria a automação para a mesma pessoa e o mesmo número. A
 *      junção roda sob a SESSÃO do usuário (rota `/api/v1/contacts/merge`), e o
 *      `emit_event` recusa `contact.phone_added` vindo de `authenticated`
 *      (0670) — por isso o caso chama a função como gerente autenticado: sem
 *      sessão, um `emit_event` reintroduzido ali passaria despercebido.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "e3315000-0000-4000-8000-000000000001";

/**
 * Números SINTÉTICOS do teste. NUNCA copiados de log: a saída das ferramentas
 * do repo REDIGE telefone, e o literal copiado chega em asteriscos — que o CHECK
 * de E.164 reprova.
 */
const NUMERO_DA_FICHA_VAZIA = "+5541991234567";
/** Mesmo número, escrito SEM o nono dígito: é o formato que a RPC promove. */
const GRAFIA_CURTA = "+554198765432";
const NUMERO_PROMOVIDO = "+5541998765432";
const NUMERO_DO_PERDEDOR = "+5541977776666";

const LID_VAZIA = "3315001";
const ID_VAZIA = "e3315000-0000-4000-8000-000000000101";
const ID_PROMOCAO = "e3315000-0000-4000-8000-000000000102";
/** A junção mora em GOV_ORG: é lá que o gerente da sessão é membro. */
const ID_VENCEDOR_VAZIO = "e3315000-0000-4000-8000-000000000104";
const ID_PERDEDOR = "e3315000-0000-4000-8000-000000000106";

async function contato(
  id: string,
  campos: { telefone?: string | null; lid?: string | null; org?: string } = {},
): Promise<string> {
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number, source_metadata, is_anonymized)
     values ($1, $2, $3, $4, $5, false)`,
    [
      id,
      campos.org ?? ORG,
      "Ficha 3315",
      campos.telefone ?? null,
      campos.lid ? JSON.stringify({ waha_lid: campos.lid }) : "{}",
    ],
  );
  return id;
}

/** O que a ficha ficou — a gravação que o evento descreve. */
async function telefoneDe(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ phone_number: string | null }>(
    "select phone_number from contacts where id = $1",
    [id],
  );
  return rows[0]?.phone_number ?? null;
}

/** As emissões de `contact.phone_added` deste contato, na ordem em que saíram. */
async function eventosDe(
  id: string,
  org: string = ORG,
): Promise<Array<{ entity_kind: string; entity_id: string; organization_id: string; payload: Record<string, unknown>; metadata: Record<string, unknown> }>> {
  const { rows } = await pool.query(
    `select entity_kind, entity_id, organization_id, payload, metadata
       from event_log
      where organization_id = $1 and entity_id = $2 and event_type = 'contact.phone_added'
      order by created_at`,
    [org, id],
  );
  return rows;
}

async function upsertWaContato(
  kind: string,
  phone: string | null,
  lid: string | null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "select public.fn_upsert_wa_contact($1, $2, $3, $4, $5, $6) as id",
    [ORG, kind, phone, lid, "chat-3315", "Ficha 3315"],
  );
  return rows[0]!.id;
}

/** Como a rota `/api/v1/contacts/merge` chama: sessão autenticada de gerente. */
async function mesclarComoGerente(principal: string, secundarios: string[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: GOV_MANAGER, role: "authenticated", aal: "aal1" }),
    ]);
    const { rows } = await c.query<{ r: Record<string, unknown> }>(
      "select public.fn_mesclar_contatos($1, $2, $3) as r",
      [GOV_ORG, principal, secundarios],
    );
    await c.query("commit");
    return rows[0]!.r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  seedGov();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-3315-telefone', 'Telefone LTDA', 'Telefone')
     on conflict (id) do nothing`,
    [ORG],
  );
  await contato(ID_VAZIA, { lid: LID_VAZIA });
  await contato(ID_PROMOCAO, { telefone: GRAFIA_CURTA });
  await contato(ID_VENCEDOR_VAZIO, { org: GOV_ORG });
  await contato(ID_PERDEDOR, { telefone: NUMERO_DO_PERDEDOR, org: GOV_ORG });
});

afterAll(async () => {
  await pool.end();
});

describe("#3315 — `fn_upsert_wa_contact` emite na transição", () => {
  it("a ficha SEM número que ganha um emite UMA vez, com o contato e o número canônicos", async () => {
    const id = await upsertWaContato("lid", NUMERO_DA_FICHA_VAZIA, LID_VAZIA);
    expect(id).toBe(ID_VAZIA);
    // O evento descreve uma gravação que aconteceu.
    expect(await telefoneDe(ID_VAZIA)).toBe(NUMERO_DA_FICHA_VAZIA);

    const eventos = await eventosDe(ID_VAZIA);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      entity_kind: "contact",
      entity_id: ID_VAZIA,
      organization_id: ORG,
      payload: { phone_number: NUMERO_DA_FICHA_VAZIA },
    });
  });

  it("a SEGUNDA chamada com o mesmo número NÃO emite — a ficha já não estava vazia", async () => {
    await upsertWaContato("lid", NUMERO_DA_FICHA_VAZIA, LID_VAZIA);
    expect(await eventosDe(ID_VAZIA)).toHaveLength(1);
  });

  it("CONTROLE: sem número no payload não há ganho nem evento", async () => {
    const id = await upsertWaContato("lid", null, LID_VAZIA);
    expect(id).toBe(ID_VAZIA);
    expect(await eventosDe(ID_VAZIA)).toHaveLength(1);
  });

  it("a PROMOÇÃO de grafia (12→13 do MESMO número) NÃO é ganho de telefone", async () => {
    const id = await upsertWaContato("phone", GRAFIA_CURTA, null);
    expect(id).toBe(ID_PROMOCAO);
    // A grafia curta virou a canônica — e o contato continua alcançável no MESMO
    // número: ele não ganhou nenhum.
    expect(await telefoneDe(ID_PROMOCAO)).toBe(NUMERO_PROMOVIDO);
    expect(await eventosDe(ID_PROMOCAO)).toHaveLength(0);
  });

  it("contato NOVO não emite — ninguém ganhou um telefone, ele nasceu com um", async () => {
    const id = await upsertWaContato("phone", "+5541955554444", null);
    // O id é gerado pela função: o que importa é que NÃO caiu numa ficha que já existia.
    expect(id).not.toBe(ID_VAZIA);
    expect(id).not.toBe(ID_PROMOCAO);
    expect(await telefoneDe(id)).toBe("+5541955554444");
    expect(await eventosDe(id)).toHaveLength(0);
  });
});

describe("#3315 — `fn_mesclar_contatos` NÃO emite", () => {
  it("junção sob sessão manager sucede e não emite — o vencedor vazio herda o número em silêncio", async () => {
    await expect(mesclarComoGerente(ID_VENCEDOR_VAZIO, [ID_PERDEDOR])).resolves.toBeTruthy();
    expect(await telefoneDe(ID_VENCEDOR_VAZIO)).toBe(NUMERO_DO_PERDEDOR);
    expect(await eventosDe(ID_VENCEDOR_VAZIO, GOV_ORG)).toHaveLength(0);
  });
});

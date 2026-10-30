import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A FICHA GUARDA VÁRIOS TELEFONES (Spec 31, parte B1 — migration 9043).
 *
 * O defeito medido: a mesma empresa fala por dois números. Juntar as duas fichas
 * deixava o número da absorvida só na lápide, e a próxima mensagem dele abria
 * uma TERCEIRA ficha — a duplicata que a junção tinha acabado de desfazer.
 *
 * Roda contra o Postgres do `scripts/test-db.sh`, com o `baseline.sql` aplicado:
 * o mesmo arquivo que o kit self-host instala. Se a mudança não chegou ao
 * apêndice, a tabela nem existe aqui.
 *
 * Cada caso usa números próprios: "um número, uma ficha" vale para a
 * organização inteira, e reaproveitar um número entre casos mediria a regra
 * pelo motivo errado.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "9041a000-0000-4000-8000-000000000001";
const ORG_B = "9041a000-0000-4000-8000-000000000002";

let seq = 0;
function uid(): string {
  seq += 1;
  return `9041c000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function contato(args: {
  org?: string;
  phone?: string | null;
  lid?: string | null;
  campos?: Record<string, unknown>;
  criadoEm?: string;
}): Promise<string> {
  const id = uid();
  await pool.query(
    `insert into contacts (id, organization_id, phone_number, source_metadata, custom_fields, created_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [
      id,
      args.org ?? ORG,
      args.phone ?? null,
      args.lid ? { waha_lid: args.lid } : {},
      args.campos ?? {},
      args.criadoEm ?? null,
    ],
  );
  return id;
}

async function extra(contactId: string, phone: string, opts: { org?: string; lid?: string } = {}) {
  await pool.query(
    `insert into contact_phones (organization_id, contact_id, phone_number, wa_lid)
     values ($1, $2, $3, $4)`,
    [opts.org ?? ORG, contactId, phone, opts.lid ?? null],
  );
}

async function upsert(args: { org?: string; phone?: string | null; lid?: string | null }) {
  const { rows } = await pool.query<{ id: string }>(
    "select public.fn_upsert_wa_contact($1, $2, $3, $4, $5, $6) as id",
    [args.org ?? ORG, args.lid ? "lid" : "phone", args.phone ?? null, args.lid ?? null, null, null],
  );
  return rows[0]!.id;
}

async function mesclar(principal: string, secundarios: string[]) {
  const { rows } = await pool.query<{ r: Record<string, unknown> }>(
    "select public.fn_mesclar_contatos($1, $2, $3) as r",
    [ORG, principal, secundarios],
  );
  return rows[0]!.r;
}

async function fichasVivas(org = ORG): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*) as n from contacts where organization_id = $1 and is_merged_into is null",
    [org],
  );
  return Number(rows[0]!.n);
}

async function codigoDoErro(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "sem_codigo";
  }
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-9041-telefones-a"],
    [ORG_B, "org-9041-telefones-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Telefones LTDA', 'Telefones') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  // Controle positivo: no banco sem o apêndice a tabela não existe e todo caso
  // abaixo cairia por "relation does not exist", não pela regra.
  const { rows } = await pool.query<{ t: string | null }>(
    "select to_regclass('public.contact_phones')::text as t",
  );
  if (rows[0]?.t !== "contact_phones") throw new Error("contact_phones não chegou ao banco");
});

afterAll(async () => {
  await pool.query("delete from organizations where id in ($1, $2)", [ORG, ORG_B]);
  await pool.end();
});

describe("o tipo do número", () => {
  // Sabotagem: trocar `[2-5]` por `[2-9]` em `fn_tipo_do_telefone` faz a
  // grafia antiga de celular virar fixo e o terceiro caso fica vermelho.
  it.each([
    ["+551533334444", "fixo"],
    ["+5515999998888", "celular"],
    ["+551599998888", "celular"],
    ["+14155550100", "outro"],
  ])("%s → %s", async (numero, tipo) => {
    const { rows } = await pool.query<{ t: string }>("select public.fn_tipo_do_telefone($1) as t", [numero]);
    expect(rows[0]!.t).toBe(tipo);
  });

  it("a ficha nova ganha o tipo e 'WhatsApp: não sei' sem ninguém pedir", async () => {
    const id = await contato({ phone: "+551533330001" });
    const { rows } = await pool.query<{ phone_type: string; phone_whatsapp: string }>(
      "select phone_type, phone_whatsapp from contacts where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ phone_type: "fixo", phone_whatsapp: "nao_sei" });
  });

  it("o preenchimento das fichas que já existiam não mexe em updated_at", async () => {
    const id = await contato({ phone: "+5515999990002" });
    // Simula a ficha de antes da migration: tipo vazio e uma data antiga.
    await pool.query("alter table contacts disable trigger trg_contacts_updated_at");
    try {
      await pool.query(
        "update contacts set phone_type = null, phone_whatsapp = null, updated_at = '2020-01-01T00:00:00Z' where id = $1",
        [id],
      );
    } finally {
      await pool.query("alter table contacts enable trigger trg_contacts_updated_at");
    }
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const blocos = sql.match(/do \$preencher_tipo\$[\s\S]*?\$preencher_tipo\$;/g);
    if (!blocos || blocos.length !== 1) {
      throw new Error(`esperava 1 bloco de preenchimento no baseline, achei ${blocos?.length ?? 0}`);
    }
    await pool.query(blocos[0]!);
    const { rows } = await pool.query<{ phone_type: string; updated_at: Date }>(
      "select phone_type, updated_at from contacts where id = $1",
      [id],
    );
    expect(rows[0]!.phone_type).toBe("celular");
    // Sabotagem: tirar o `disable trigger` do bloco faz o updated_at virar now().
    expect(rows[0]!.updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("um número, uma ficha viva", () => {
  it("o mesmo número como extra de duas fichas — também sem o nono dígito — é recusado", async () => {
    const a = await contato({ phone: "+5515999990101" });
    const b = await contato({ phone: "+5515999990102" });
    await extra(a, "+5515999990103");
    // Sabotagem: comparar o texto cru em vez da forma canônica deixa passar a grafia de 12.
    expect(await codigoDoErro(extra(b, "+551599990103"))).toBe("23505");
  });

  it("extra de uma ficha e principal de outra é recusado, nas duas ordens", async () => {
    const a = await contato({ phone: "+5515999990201" });
    await extra(a, "+5515999990202");
    expect(await codigoDoErro(contato({ phone: "+551599990202" }))).toBe("23505");

    const c = await contato({ phone: "+5515999990203" });
    const d = await contato({ phone: "+5515999990204" });
    expect(await codigoDoErro(extra(d, "+5515999990203"))).toBe("23505");
    expect(c).not.toBe(d);
  });

  it("o número da lápide não bloqueia", async () => {
    const fica = await contato({ phone: "+5515999990301" });
    const sai = await contato({ phone: "+5515999990302" });
    await mesclar(fica, [sai]);
    // O número da absorvida virou extra da que ficou; uma terceira ficha não o
    // pega, mas o número que SÓ a lápide tinha antes de virar extra é dela.
    const outra = await contato({ phone: "+5515999990303" });
    await pool.query("delete from contact_phones where organization_id = $1 and contact_id = $2", [ORG, fica]);
    await extra(outra, "+5515999990302");
    const { rows } = await pool.query<{ contact_id: string }>(
      "select contact_id from contact_phones where organization_id = $1 and phone_number = '+5515999990302'",
      [ORG],
    );
    expect(rows.map((r) => r.contact_id)).toEqual([outra]);
  });

  it("duas gravações ao mesmo tempo, uma com e outra sem o nono dígito: uma passa, a outra 23505", async () => {
    const a = await contato({ phone: "+5515999990401" });
    const b = await contato({ phone: "+5515999990402" });
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("begin");
      await c1.query(
        "insert into contact_phones (organization_id, contact_id, phone_number) values ($1, $2, '+5515999990403')",
        [ORG, a],
      );
      await c2.query("begin");
      // Fica preso na trava consultiva da forma canônica até a primeira terminar.
      const segunda = c2
        .query("update contacts set phone_number = '+551599990403' where id = $1", [b])
        .then(() => null)
        .catch((e: { code?: string }) => e.code ?? "sem_codigo");
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("commit");
      // Sabotagem: travar pelo texto exato (sem `fn_telefone_canonico`) deixa as duas passarem.
      expect(await segunda).toBe("23505");
      await c2.query("rollback");
    } finally {
      c1.release();
      c2.release();
    }
  });

  it("extra de uma organização não casa a mensagem de outra", async () => {
    const a = await contato({ phone: "+5515999990501" });
    await extra(a, "+5515999990502");
    const antesB = await fichasVivas(ORG_B);
    const id = await upsert({ org: ORG_B, phone: "+5515999990502" });
    expect(id).not.toBe(a);
    expect(await fichasVivas(ORG_B)).toBe(antesB + 1);
  });
});

describe("a mensagem que chega acha a ficha pelo extra", () => {
  it("pelo número extra, sem lid: a mesma ficha, e o lid do principal não muda", async () => {
    const id = await contato({ phone: "+5515999990601", lid: "90416010000001" });
    await extra(id, "+5515999990602");
    const antes = await fichasVivas();

    // Sabotagem: tirar o passo "extra" da busca de `fn_upsert_wa_contact` cria uma ficha nova.
    expect(await upsert({ phone: "+5515999990602" })).toBe(id);
    expect(await fichasVivas()).toBe(antes);
  });

  it("pelo extra com um lid novo: o lid fica com o extra, não com o principal", async () => {
    const id = await contato({ phone: "+5515999990701", lid: "90417010000001" });
    await extra(id, "+5515999990702");

    expect(await upsert({ phone: "+5515999990702", lid: "90417020000002@lid" })).toBe(id);

    const { rows } = await pool.query<{ wa_lid: string; extra_lid: string; whatsapp: string }>(
      `select c.wa_lid, t.wa_lid as extra_lid, t.whatsapp
         from contacts c join contact_phones t on t.contact_id = c.id
        where c.id = $1`,
      [id],
    );
    // Sabotagem: voltar a gravar `waha_lid` no principal troca o primeiro valor.
    expect(rows[0]).toEqual({ wa_lid: "90417010000001", extra_lid: "90417020000002", whatsapp: "sim" });
  });

  it("só com o lid de um extra já conhecido: a ficha dele", async () => {
    const id = await contato({ phone: "+5515999990801" });
    await extra(id, "+5515999990802", { lid: "90418020000002" });
    // Sabotagem: procurar o lid só em `contacts`.
    expect(await upsert({ lid: "90418020000002@lid" })).toBe(id);
  });

  it("o número que já é extra de OUTRA ficha vira telefone_em_conflito, não principal", async () => {
    const dona = await contato({ phone: "+5515999990901" });
    await extra(dona, "+5515999990902");
    const outra = await contato({ lid: "90419030000003" });

    expect(await upsert({ phone: "+5515999990902", lid: "90419030000003" })).toBe(outra);
    const { rows } = await pool.query<{ phone_number: string | null; conflito: string | null }>(
      "select phone_number, source_metadata->>'telefone_em_conflito' as conflito from contacts where id = $1",
      [outra],
    );
    expect(rows[0]).toEqual({ phone_number: null, conflito: "+5515999990902" });
  });
});

describe("a junção guarda os números e os campos", () => {
  it("o número da absorvida vira extra e a próxima mensagem dele cai na ficha que ficou", async () => {
    const fica = await contato({ phone: "+5515999991001", lid: "90411010000001", criadoEm: "2026-01-01" });
    const sai = await contato({ phone: "+5515999991002", criadoEm: "2026-02-01" });
    await mesclar(fica, [sai]);
    const antes = await fichasVivas();

    expect(await upsert({ phone: "+5515999991002" })).toBe(fica);
    expect(await fichasVivas()).toBe(antes);

    const { rows } = await pool.query<{ origem: string; tipo: string }>(
      "select origem, tipo from contact_phones where organization_id = $1 and contact_id = $2",
      [ORG, fica],
    );
    expect(rows).toEqual([{ origem: "fusao", tipo: "celular" }]);
  });

  it("as duas com lid próprio: o lid da absorvida vai junto com o número dela", async () => {
    const fica = await contato({ phone: "+5515999991101", lid: "90411110000001", criadoEm: "2026-01-01" });
    const sai = await contato({ phone: "+5515999991102", lid: "90411120000002", criadoEm: "2026-02-01" });
    await mesclar(fica, [sai]);

    // Sabotagem: não levar o lid junto com o extra (o passo 6b) — a mensagem só com o lid abre ficha nova.
    expect(await upsert({ lid: "90411120000002@lid" })).toBe(fica);
    const { rows } = await pool.query<{ wa_lid: string }>("select wa_lid from contacts where id = $1", [fica]);
    expect(rows[0]!.wa_lid).toBe("90411110000001");
  });

  it("a ficha que fica sem telefone: o da absorvida vira o principal, não um extra", async () => {
    const fica = await contato({ criadoEm: "2026-01-01" });
    const sai = await contato({ phone: "+5515999991202", lid: "90411220000002", criadoEm: "2026-02-01" });
    await mesclar(fica, [sai]);
    const { rows } = await pool.query<{ phone_number: string; wa_lid: string; extras: string }>(
      `select c.phone_number, c.wa_lid,
              (select count(*) from contact_phones t where t.organization_id = c.organization_id and t.contact_id = c.id)::text as extras
         from contacts c where c.id = $1`,
      [fica],
    );
    expect(rows[0]).toEqual({ phone_number: "+5515999991202", wa_lid: "90411220000002", extras: "0" });
  });

  it("o extra da absorvida vai para a que fica; o número repetido não fica na lápide nem em nao_repontado", async () => {
    const fica = await contato({ phone: "+5515999991301", criadoEm: "2026-01-01" });
    // A grafia antiga do MESMO número na absorvida — o par "gêmeo" de antes da
    // regra. A regra nova o recusaria, então o caso é montado com ela desligada.
    await pool.query("alter table contacts disable trigger trg_contacts_um_numero_uma_ficha");
    let sai: string;
    try {
      sai = await contato({ phone: "+551599991301", criadoEm: "2026-02-01" });
    } finally {
      await pool.query("alter table contacts enable trigger trg_contacts_um_numero_uma_ficha");
    }
    await extra(sai, "+5515999991303");

    const r = await mesclar(fica, [sai]);
    expect(r.nao_repontado).toEqual({});

    const { rows } = await pool.query<{ contact_id: string; phone_number: string }>(
      "select contact_id, phone_number from contact_phones where organization_id = $1 and contact_id in ($2, $3) order by phone_number",
      [ORG, fica, sai],
    );
    expect(rows).toEqual([{ contact_id: fica, phone_number: "+5515999991303" }]);
  });

  it("custom_fields: a chave que falta entra; a repetida fica com a ficha que fica", async () => {
    const fica = await contato({ phone: "+5515999991401", campos: { cidade: "A" }, criadoEm: "2026-01-01" });
    const sai1 = await contato({ phone: "+5515999991402", campos: { cidade: "B", porte: "grande" }, criadoEm: "2026-02-01" });
    const sai2 = await contato({ phone: "+5515999991403", campos: { porte: "pequeno", setor: "x" }, criadoEm: "2026-03-01" });
    await mesclar(fica, [sai1, sai2]);
    const { rows } = await pool.query<{ custom_fields: Record<string, string> }>(
      "select custom_fields from contacts where id = $1",
      [fica],
    );
    // Sabotagem: inverter o `||` faz a absorvida sobrescrever `cidade`.
    expect(rows[0]!.custom_fields).toEqual({ cidade: "A", porte: "grande", setor: "x" });
  });
});

describe("LGPD: anonimizar alcança os extras", () => {
  it("apaga os extras e o candidato da prospecção casado pelo número EXTRA", async () => {
    const alvo = await contato({ phone: "+5515999991501" });
    await extra(alvo, "+5515999991502");
    const campanha = uid();
    const cand = uid();
    await pool.query(
      `insert into prospecting_campaigns (id, organization_id, request_id, name, search)
       values ($1, $2, gen_random_uuid(), 'Campanha 9041', '{}'::jsonb)`,
      [campanha, ORG],
    );
    // Grafado sem o nono, como a prospecção às vezes traz.
    await pool.query(
      `insert into prospecting_candidates (id, organization_id, campaign_id, place_id, phone, data, status)
       values ($1, $2, $3, 'place-9041', '+551599991502', jsonb_build_object('key','place-9041','phone','+551599991502'), 'skipped')`,
      [cand, ORG, campanha],
    );

    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid())", [ORG, alvo]);

    const { rows: extras } = await pool.query(
      "select 1 from contact_phones where organization_id = $1 and contact_id = $2",
      [ORG, alvo],
    );
    expect(extras).toHaveLength(0);
    const { rows } = await pool.query<{ phone: string | null }>(
      "select phone from prospecting_candidates where id = $1",
      [cand],
    );
    // Sabotagem: calcular as variantes só do principal deixa o telefone do candidato.
    expect(rows[0]!.phone).toBeNull();
  });
});

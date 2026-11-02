import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * AO JUNTAR DUAS FICHAS, O NOME DA ABSORVIDA NÃO VIRA O TÍTULO DA QUE FICA (#3721).
 *
 * O defeito medido pelo mantenedor na tela: `fn_mesclar_contatos` herdava o
 * `name` do perdedor com `coalesce(name, v_nome)`. Caso: a ficha A "Ana Cliente
 * WhatsApp" (só `display_name`, chegou pela ingestão do WhatsApp) fica, a B
 * "Bruno Escritório Fixo" é absorvida — e o título de A passa a ser "Bruno",
 * embora o operador tenha escolhido A para ficar ("Ana Cliente WhatsApp fica.").
 *
 * O que este arquivo executa é a FUSÃO contra o Postgres do `scripts/test-db.sh`
 * (baseline aplicado, como o kit self-host instala), e lê o TÍTULO pela mesma
 * régua que a tela usa — `nomeDoContato`
 * (lib/contacts/rotulo-do-contato.ts:105): `name`, depois `display_name`, depois
 * o número. Medir só a coluna `name` deixaria passar a metade do defeito que
 * volta pelo `display_name`, quando a ficha que fica não tem rótulo nenhum.
 *
 * Comando:
 *     pnpm test:db tests/invariants/juntar-fichas-nao-herda-o-nome.test.ts
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

const ORG = "9046a000-0000-4000-8000-000000000001";

let seq = 0;
function uid(): string {
  seq += 1;
  return `9046c000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface Ficha {
  name: string | null;
  display_name: string | null;
  email: string | null;
  birthdate: string | null;
  social_identity: string | null;
  tags: string[] | null;
  source_metadata: Record<string, unknown> | null;
  is_merged_into: string | null;
}

async function contato(args: {
  nome?: string | null;
  apelido?: string | null;
  telefone?: string | null;
  email?: string | null;
  nascimento?: string | null;
  social?: string | null;
  tags?: string[];
}): Promise<string> {
  const id = uid();
  await pool.query(
    `insert into contacts
       (id, organization_id, name, display_name, phone_number, email, birthdate, social_identity, tags)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      ORG,
      args.nome ?? null,
      args.apelido ?? null,
      args.telefone ?? null,
      args.email ?? null,
      args.nascimento ?? null,
      args.social ?? null,
      args.tags ?? [],
    ],
  );
  return id;
}

async function ficha(id: string): Promise<Ficha> {
  const { rows } = await pool.query<Ficha>(
    `select name, display_name, email, birthdate::text as birthdate, social_identity, tags,
            source_metadata, is_merged_into
       from contacts where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function mesclar(principal: string, secundarios: string[]): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ r: Record<string, unknown> }>(
    "select public.fn_mesclar_contatos($1, $2, $3) as r",
    [ORG, principal, secundarios],
  );
  return rows[0]!.r;
}

/**
 * O título como a tela o mostra (`nomeDoContato`): `name`, depois
 * `display_name` — vazio conta como ausente. Sem os dois, quem rotula é o
 * número (`rotuloDoContato`), e é isso que "null" significa aqui.
 */
function titulo(f: { name: string | null; display_name: string | null }): string | null {
  const achado = [f.name, f.display_name].map((v) => (v ?? "").trim()).find((v) => v !== "");
  return achado ?? null;
}

function nomesAbsorvidos(f: Ficha): unknown {
  return (f.source_metadata ?? {})["nomes_absorvidos"];
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-9046-nome-na-fusao', 'Nome LTDA', 'Nome') on conflict (id) do nothing`,
    [ORG],
  );
  // Controle de vacuidade: a função tem de existir para os casos abaixo medirem
  // a fusão, e não um erro de "function does not exist". O CORPO não se compara
  // aqui de propósito — quem mede texto (cadeia × apêndice) é
  // `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts`; o que este
  // arquivo mede é o COMPORTAMENTO, e um `toContain` no corpo faria o caso
  // vermelho da sabotagem parar no instrumento em vez de no defeito.
  const { rows } = await pool.query<{ corpo: string }>(
    `select prosrc as corpo from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'fn_mesclar_contatos'`,
  );
  if (rows.length !== 1) throw new Error("fn_mesclar_contatos não está no banco");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("#3721 — o título da ficha é de quem fica", () => {
  it("o caso da issue: ficha do WhatsApp sem `name` fica e NÃO vira 'Bruno'", async () => {
    const ana = await contato({
      apelido: "Ana Cliente WhatsApp",
      telefone: "+5511970000001",
    });
    const bruno = await contato({
      nome: "Bruno Escritório Fixo",
      telefone: "+5511970000002",
    });

    const resultado = await mesclar(ana, [bruno]);

    const ficou = await ficha(ana);
    expect(ficou.name, "o vencedor herdou o `name` do perdedor").toBeNull();
    expect(ficou.display_name).toBe("Ana Cliente WhatsApp");
    expect(titulo(ficou), "o título é de quem o operador escolheu para ficar").toBe(
      "Ana Cliente WhatsApp",
    );

    // O perdedor não perdeu o nome: a lápide continua com ele...
    const lapide = await ficha(bruno);
    expect(lapide.is_merged_into).toBe(ana);
    expect(lapide.name).toBe("Bruno Escritório Fixo");
    // ...e a ficha que ficou guarda o rastro, em vez de usar o nome como título.
    expect(nomesAbsorvidos(ficou)).toEqual([{ contato_id: bruno, name: "Bruno Escritório Fixo" }]);
    expect(resultado.nomes_absorvidos).toEqual([
      { contato_id: bruno, name: "Bruno Escritório Fixo" },
    ]);
  });

  it("controle: o vencedor que já tinha nome continua com o dele", async () => {
    const ana = await contato({ nome: "Ana Silva", telefone: "+5511970000011" });
    const bruno = await contato({ nome: "Bruno Fixo", telefone: "+5511970000012" });

    await mesclar(ana, [bruno]);

    const ficou = await ficha(ana);
    expect(ficou.name).toBe("Ana Silva");
    expect(titulo(ficou)).toBe("Ana Silva");
    expect(nomesAbsorvidos(ficou)).toEqual([{ contato_id: bruno, name: "Bruno Fixo" }]);
  });

  it("nem quando a ficha que fica não tem nome NEM rótulo o nome do outro vira título", async () => {
    // O caminho do `display_name`: título é `name ?? display_name`, então herdar
    // o rótulo do perdedor trocaria o título exatamente igual ao `name`.
    const soNumero = await contato({ telefone: "+5511970000021" });
    const bruno = await contato({
      nome: "Bruno Fixo",
      apelido: "Bruno Zap",
      telefone: "+5511970000022",
    });

    await mesclar(soNumero, [bruno]);

    const ficou = await ficha(soNumero);
    expect(ficou.name).toBeNull();
    expect(ficou.display_name, "o rótulo do perdedor virou o título").toBeNull();
    expect(titulo(ficou), "sem nome e sem rótulo, quem rotula é o número").toBeNull();
    expect(nomesAbsorvidos(ficou)).toEqual([{ contato_id: bruno, name: "Bruno Fixo" }]);
  });

  it("o rótulo do canal continua sendo herdado quando a ficha que fica já tem nome", async () => {
    // Herança invisível: com `name` no lugar, o `display_name` herdado não vira
    // título. É a regra do arquivo — "o que ele não tem, vem dos perdedores".
    const ana = await contato({ nome: "Ana Silva", telefone: "+5511970000031" });
    const bruno = await contato({
      apelido: "Bruno Zap",
      telefone: "+5511970000032",
    });

    await mesclar(ana, [bruno]);

    const ficou = await ficha(ana);
    expect(ficou.name).toBe("Ana Silva");
    expect(ficou.display_name).toBe("Bruno Zap");
    expect(titulo(ficou)).toBe("Ana Silva");
  });

  it("o resto da herança segue igual, e a fusão sem nome não cria a chave de histórico", async () => {
    const ana = await contato({ nome: "Ana Silva", telefone: "+5511970000041" });
    const bruno = await contato({
      telefone: "+5511970000042",
      email: "bruno.9046@exemplo.test",
      nascimento: "1990-05-06",
      social: "instagram:account:9046004",
      tags: ["vip"],
    });

    await mesclar(ana, [bruno]);

    const ficou = await ficha(ana);
    expect(ficou.email).toBe("bruno.9046@exemplo.test");
    expect(ficou.birthdate).toBe("1990-05-06");
    expect(ficou.social_identity).toBe("instagram:account:9046004");
    expect(ficou.tags).toEqual(["vip"]);
    expect(ficou.name).toBe("Ana Silva");
    // Nenhum perdedor tinha nome: nada a historiar, e nenhuma chave inventada.
    expect(nomesAbsorvidos(ficou)).toBeUndefined();

    // O telefone do perdedor vira extra da ficha que fica (9043, intocado).
    const { rows } = await pool.query<{ phone_number: string }>(
      "select phone_number from contact_phones where contact_id = $1 order by phone_number",
      [ana],
    );
    expect(rows.map((r) => r.phone_number)).toEqual(["+5511970000042"]);
  });

  it("a fusão seguinte ACRESCENTA ao histórico em vez de apagar o anterior", async () => {
    const ana = await contato({ telefone: "+5511970000051" });
    const bruno = await contato({ nome: "Bruno Fixo", telefone: "+5511970000052" });
    const carla = await contato({ nome: "Carla Loja", telefone: "+5511970000053" });

    await mesclar(ana, [bruno]);
    await mesclar(ana, [carla]);

    const ficou = await ficha(ana);
    expect(nomesAbsorvidos(ficou)).toEqual([
      { contato_id: bruno, name: "Bruno Fixo" },
      { contato_id: carla, name: "Carla Loja" },
    ]);
    expect(titulo(ficou), "duas absorvidas com nome e o título continua vazio").toBeNull();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CHEGADA,
  CHEGADA_MS,
  CHEGADA_TEXTO,
  FORA_DA_LISTA,
  IDS_DO_CASO,
  linhasQueRamoamPorDate,
  reguasDeData,
  sitiosQueRamoamPorDate,
} from "./reguas-de-data";

/**
 * A CERCA DA CLASSE `Date` × `string` (#3849) — contra Postgres de VERDADE.
 *
 * ─── O que este arquivo mede, e por que precisa de banco ─────────────────────
 *
 * O defeito de origem (#3846): `midiaDerivavelPendente` exigia
 * `typeof quando === "string"` e respondia "nada pendente" contra o banco real,
 * porque o driver `pg` entrega `timestamptz` como `Date` (parser do OID 1184). O
 * dublê de pool dos testes de unidade devolve string, então NENHUM teste de
 * unidade podia ver. A guarda ficou inerte em produção.
 *
 * Aqui não há dublê: o caso monta uma linha `timestamptz` de verdade, mede a
 * forma em que ela chega e entrega a cada régua da lista ÚNICA
 * (`./reguas-de-data.ts`) o valor CRU — sem `toISOString()`, sem `new Date()`.
 * Passar uma string aqui seria o dublê de novo, com outro nome.
 *
 * O modo de falha da classe é MUDO: nada lança. A régua responde `null`, cai no
 * padrão, ou devolve "não vi" — e o turno, a fila, a presença ou a renovação de
 * token seguem com a decisão errada sem uma linha de erro. Só a medição contra o
 * driver vê, e é por isso que esta cerca roda em `pnpm test:db`.
 *
 * ─── O que a lista NÃO é ────────────────────────────────────────────────────
 *
 * Ela não substitui a catraca estática (`tests/unit/data-do-banco-nao-vira-texto.test.ts`),
 * que pega a FORMA `typeof`/`Date.parse` no commit. As duas se completam: a
 * catraca pega quem trata só string; esta pega quem ramifica por `Date` e não
 * está declarado, além de provar em runtime que cada régua declarada VÊ o valor
 * do driver.
 *
 * Roda com:
 *
 *     pnpm test:db tests/invariants/reguas-de-data-veem-o-date-do-driver.test.ts
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

const { organizacao: ORG, contato: CONTACT, sessao: SESSION, conversa: CONV } = IDS_DO_CASO;

/** A lista ÚNICA, já ligada ao pool desta corrida. */
const REGUAS = reguasDeData(pool);
/** Só as que recebem o valor: as de consulta leem o banco por conta própria. */
const REGUAS_DE_VALOR = REGUAS.filter((r) => r.entrada === "valor");

interface LinhaDeData {
  tipo: string;
  created_at: Date;
}

/**
 * O carimbo de chegada, lido do banco pelo MESMO caminho da produção: um
 * `select` sem `::text`, sem `to_char`, sem `extract` — o driver entrega `Date`.
 */
async function lerCarimboDeChegada(cliente: pg.Pool | pg.PoolClient = pool): Promise<LinhaDeData> {
  const { rows } = await cliente.query<LinhaDeData>(
    `select pg_typeof(created_at)::text as tipo, created_at
       from messages
      where organization_id = $1 and conversation_id = $2
      order by created_at desc
      limit 1`,
    [ORG, CONV],
  );
  const linha = rows[0];
  if (linha === undefined) throw new Error("fixture ausente: nenhuma mensagem na conversa");
  return linha;
}

describe("as réguas de data do repositório veem o `Date` que o driver entrega", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1,'reguas-de-data','Réguas de Data','Réguas de Data') on conflict (id) do nothing`,
      [ORG],
    );
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1,$2,'reguas-de-data-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
      [SESSION, ORG],
    );
  });

  beforeEach(async () => {
    await pool.query("delete from messages where organization_id = $1", [ORG]);
    await pool.query("delete from conversations where organization_id = $1", [ORG]);
    await pool.query("delete from contacts where organization_id = $1", [ORG]);
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number)
       values ($1,$2,'Cliente de teste','+5511900000000')`,
      [CONTACT, ORG],
    );
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false)`,
      [CONV, ORG, CONTACT, SESSION],
    );
    // Áudio de entrada, sem derivação e com `media_url`: pendente por definição.
    // `sent_at`/`created_at` recebem o ISO com milissegundo — o banco guarda o
    // INSTANTE, e o driver devolve `Date`.
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, media_url, media_mime, media_derived_status, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'audio','inbound','delivered',null,$6,'audio/ogg',null,'external_device',$7,$7)`,
      [crypto.randomUUID(), ORG, CONV, SESSION, CONTACT, "https://cdn.example/audio.ogg", CHEGADA],
    );
  });

  afterAll(async () => {
    await pool.query("delete from messages where organization_id = $1", [ORG]);
    await pool.query("delete from conversations where organization_id = $1", [ORG]);
    await pool.query("delete from contacts where organization_id = $1", [ORG]);
    await pool.end();
  });

  it("MEDIÇÃO 0: a coluna é `timestamptz` e o driver a entrega como `Date`, no mesmo instante", async () => {
    const linha = await lerCarimboDeChegada();
    expect(linha.tipo).toBe("timestamp with time zone");
    expect(linha.created_at).toBeInstanceOf(Date);
    expect(linha.created_at.toISOString()).toBe(CHEGADA);
    // `String(Date)` em vez de `toISOString()` é o que quebra a régua: perde o
    // milissegundo e ganha o fuso da sessão. O instante, aqui, é o mesmo.
    expect(linha.created_at.getTime()).toBe(CHEGADA_MS);
  });

  it("MEDIÇÃO 1: o fuso da SESSÃO do Postgres não desloca o instante que o driver entrega", async () => {
    const cliente = await pool.connect();
    try {
      // O bug de fuso do #3849 não é teórico: um `toISOString` aplicado sobre
      // valor já convertido, ou um `timestamptz::text` lido como hora de
      // parede, anda 3h em America/Sao_Paulo. A coluna guarda o INSTANTE; ler a
      // mesma linha de uma sessão em -03 tem de devolver o MESMO epoch.
      await cliente.query("set time zone 'America/Sao_Paulo'");
      const linha = await lerCarimboDeChegada(cliente);
      expect(linha.created_at).toBeInstanceOf(Date);
      expect(linha.created_at.getTime()).toBe(CHEGADA_MS);
      expect(linha.created_at.toISOString()).toBe(CHEGADA);
    } finally {
      await cliente.query("reset time zone");
      cliente.release();
    }
  });

  it("a lista não é oca e não repete régua", () => {
    expect(REGUAS.length).toBeGreaterThanOrEqual(10);
    const nomes = REGUAS.map((r) => r.nome);
    expect(new Set(nomes).size).toBe(nomes.length);
    // O normalizador de borda é o que a mensagem de erro do RED recomenda; se
    // ele sair da lista, o RED deixa de ter para onde apontar.
    expect(nomes).toContain("instanteDoBanco");
  });

  it.each(REGUAS.map((r) => [r.nome, r] as const))(
    "a régua `%s` VÊ o instante que o driver entregou",
    async (_nome, regua) => {
      // O valor CRU, como a régua o recebe em produção. Nada de string.
      const { created_at } = await lerCarimboDeChegada();
      expect(await regua.exercitar(created_at)).toBe(true);
    },
  );

  it.each(REGUAS_DE_VALOR.map((r) => [r.nome, r] as const))(
    "a régua `%s` continua aceitando a string ISO do cliente REST",
    async (_nome, regua) => {
      // O caminho do PostgREST/jsonb não pode quebrar: é a forma que o cliente
      // REST entrega da MESMA coluna, e é o que os testes de unidade usam.
      expect(await regua.exercitar(CHEGADA_TEXTO)).toBe(true);
    },
  );

  it.each(REGUAS_DE_VALOR.map((r) => [r.nome, r] as const))(
    "a régua `%s` trata `null`/`undefined` como hoje: não vê instante e não lança",
    async (_nome, regua) => {
      // A ausência de carimbo NÃO autoriza nada: a régua responde "não vi",
      // como sempre respondeu. Um `throw` aqui derrubaria o turno inteiro.
      await expect(Promise.resolve(regua.exercitar(null))).resolves.toBe(false);
      await expect(Promise.resolve(regua.exercitar(undefined))).resolves.toBe(false);
    },
  );

  it("todo arquivo de produção que ramifica por `instanceof Date` está declarado", () => {
    const declarados = new Set(REGUAS.map((r) => r.onde.split(":")[0]));
    const isentos = new Set(FORA_DA_LISTA.map((f) => f.arquivo));
    const sitios = sitiosQueRamoamPorDate();

    expect(sitios.length, "a varredura não achou site nenhum — instrumento quebrado").toBeGreaterThan(
      10,
    );

    const naoDeclarados = sitios
      .filter((s) => !declarados.has(s.arquivo) && !isentos.has(s.arquivo))
      .map((s) => `${s.arquivo}:${s.linhas.join(",")}`);

    expect(
      naoDeclarados,
      "régua de data que trata os dois transportes nasceu fora da lista ÚNICA. " +
        "Se ela lê data de armazenamento e decide algo, entre na lista " +
        "(`tests/invariants/reguas-de-data.ts`) e ganhe cobertura aqui; " +
        "se não é régua de leitura, isente em FORA_DA_LISTA com o motivo medido.",
    ).toEqual([]);
  });

  it("isenção cujo arquivo deixou de ramificar por `Date` reprova: dívida paga, remova a entrada", () => {
    const sitios = new Set(sitiosQueRamoamPorDate().map((s) => s.arquivo));
    const pagas = FORA_DA_LISTA.filter((f) => !sitios.has(f.arquivo)).map((f) => f.arquivo);
    expect(pagas, "o motivo desta isenção não vale mais — apague a linha de FORA_DA_LISTA").toEqual(
      [],
    );
  });

  it("cada régua da lista ainda é declarada em `arquivo:linha` (`onde`)", () => {
    // Renomear/remover a régua sem atualizar a lista tem de doer: o endereço é
    // o que o RED e a revisão humana seguem. A conferência é pela DECLARAÇÃO, e
    // não pela linha exata — exigir o número faria a cerca ficar vermelha por
    // qualquer edição acima da função, que não tem nada a ver com data.
    const quebradas: string[] = [];
    for (const regua of REGUAS) {
      const [arquivo] = regua.onde.split(":");
      const fonte = readFileSync(path.join(process.cwd(), arquivo!), "utf8");
      const declaracao = new RegExp(`(export\\s+)?(async\\s+)?function\\s+${regua.nome}\\s*[<(]`);
      if (!declaracao.test(fonte)) {
        quebradas.push(`${regua.onde}: \`${regua.nome}\` não é declarada neste arquivo`);
      }
    }
    expect(quebradas).toEqual([]);
  });

  it("a lista cobre as réguas do invariante anterior (#3959) — duas listas não divergem", () => {
    // O arquivo anterior é CONGELADO pela regra de `tests/invariants/README.md`
    // ("adicione, não edite"). Ele tem a própria lista curta; a única forma de
    // ele não virar uma segunda verdade é esta: cada nome declarado lá tem de
    // existir aqui.
    const anterior = readFileSync(
      path.join(process.cwd(), "tests/invariants/data-do-banco-nao-vem-como-texto.test.ts"),
      "utf8",
    );
    const nomesDoAnterior = [...anterior.matchAll(/nome:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(nomesDoAnterior.length).toBeGreaterThanOrEqual(2);
    const daLista = new Set(REGUAS.map((r) => r.nome));
    expect(nomesDoAnterior.filter((n) => !daLista.has(n))).toEqual([]);
  });

  it("o detector de `instanceof Date` tem dentes (e não conta comentário)", () => {
    // Sem isto, a catraca da lista poderia ficar verde só porque o repositório
    // hoje não tem a forma — o mesmo furo que o #3959 pagou na catraca irmã.
    const comRamo = `
      export function regua(valor: unknown) {
        if (valor instanceof Date) return valor.getTime();
        return typeof valor === "string" ? Date.parse(valor) : null;
      }
    `;
    expect(linhasQueRamoamPorDate(comRamo)).toEqual([3]);

    const soComentario = `
      // a versão antiga fazia \`quando instanceof Date\` e por isso...
      export function regua(valor: unknown) {
        return typeof valor === "string" ? Date.parse(valor) : null;
      }
    `;
    expect(linhasQueRamoamPorDate(soComentario)).toEqual([]);
  });
});

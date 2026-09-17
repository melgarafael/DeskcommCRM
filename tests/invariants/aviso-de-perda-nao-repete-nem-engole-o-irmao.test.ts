import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import { avisoDoEspelhoRecusado } from "@/lib/agent-engine/edge/crm/move-lead-stage";

/**
 * O AVISO DE "PERDA SEM MOTIVO" NÃO NASCE DE NOVO A CADA TURNO — E NÃO ENGOLE O
 * IRMÃO DO MESMO NEGÓCIO.
 *
 * O ramo que abre o aviso (issue #917) chamava `insertInboxItem` sem `dedupe`, e
 * o assistente reconclui o mesmo passo em todo turno: uma linha idêntica por
 * mensagem do cliente. É a queixa original da #917 com outra roupa — N cópias do
 * mesmo item enterram o item que pedia decisão, e alarme repetido treina o dono a
 * ignorar o alarme certo (o contrato está escrito em `insertInboxItem`).
 *
 * ⚠️ `kind_e_ref` — o dedupe óbvio — NÃO serve aqui, e é por isso que este
 * arquivo mede as DUAS direções. Os dois avisos do espelho (`fora_do_escopo` e
 * `perda_sem_motivo`) saem com o mesmo `kind` genérico (`other`) e a mesma `ref`
 * (o lead), distinguidos só pelo TÍTULO: por `kind_e_ref`, o segundo sumiria
 * atrás do primeiro — o defeito que o dedupe existe para evitar, invertido.
 *
 * SQL não se prova com dublê: aqui é Postgres de verdade, pela função que o
 * ponto de uso chama.
 *
 * As duas sabotagens e o que cada uma derruba:
 *   1. trocar `'kind_ref_e_titulo'` por `undefined` (o estado do PR) — o caso 1
 *      passa a ver 3 linhas em vez de 1;
 *   2. trocar por `'kind_e_ref'` — o caso 2 passa a ver 1 linha em vez de 2.
 *
 * As duas sabotagens são em `DEDUPE_DO_ESPELHO`
 * (lib/agent-engine/edge/crm/move-lead-stage.ts), que é de onde o ponto de uso
 * tira o valor.
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

const ORG = "aa910000-0000-4000-8000-00000000091a";
const LEAD_A = "aa910000-0000-4000-8000-0000000000a1";
const LEAD_B = "aa910000-0000-4000-8000-0000000000b1";

/** O aviso real, como o ponto de uso o monta — não um texto inventado aqui. */
function aviso(motivo: "perda_sem_motivo" | "fora_do_escopo") {
  const a = avisoDoEspelhoRecusado({
    motivo,
    detalhe: "detalhe",
    etapaDeDestino: "Perdido",
  });
  if (!a) throw new Error(`esperava aviso para ${motivo}`);
  return a;
}

async function gravar(motivo: "perda_sem_motivo" | "fora_do_escopo", leadId: string) {
  const a = aviso(motivo);
  return insertInboxItem(
    pool,
    ORG,
    { kind: "other", title: a.title, body: a.body, refKind: "lead", refId: leadId },
    // O dedupe vem da DECISÃO, como no ponto de uso — não um literal repetido
    // aqui, que ficaria verde com a decisão sabotada.
    a.dedupe,
  );
}

async function abertos(leadId: string, titulo?: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_inbox_items
      where organization_id = $1 and kind = 'other' and status = 'open'
        and ref_kind = 'lead' and ref_id = $2
        and ($3::text is null or title = $3)`,
    [ORG, leadId, titulo ?? null],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'aviso-perda', 'Aviso perda', 'Aviso perda')`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("o aviso da etapa de perda na Central", () => {
  it("três turnos com a mesma conclusão abrem UM aviso, não três", async () => {
    await gravar("perda_sem_motivo", LEAD_A);
    await gravar("perda_sem_motivo", LEAD_A);
    await gravar("perda_sem_motivo", LEAD_A);

    expect(await abertos(LEAD_A, aviso("perda_sem_motivo").title)).toBe(1);
  });

  it("o aviso de ESCOPO do mesmo negócio continua nascendo — não some atrás do primeiro", async () => {
    await gravar("fora_do_escopo", LEAD_A);

    // Dois avisos abertos para o MESMO lead, com o mesmo `kind`: é o que
    // `kind_e_ref` impediria, e cada um diz ao dono uma coisa diferente para fazer.
    expect(await abertos(LEAD_A)).toBe(2);
    expect(await abertos(LEAD_A, aviso("fora_do_escopo").title)).toBe(1);
  });

  it("o mesmo problema em OUTRO negócio abre o seu próprio aviso", async () => {
    // O que `kind_e_titulo` sozinho engoliria: o segundo cliente ficaria sem sinal.
    await gravar("perda_sem_motivo", LEAD_B);

    expect(await abertos(LEAD_B, aviso("perda_sem_motivo").title)).toBe(1);
  });

  it("resolvido o aviso, o próximo turno pode abrir outro", async () => {
    // O dedupe é "enquanto houver um ABERTO", não "uma vez na vida": o dono que
    // resolveu e voltou a ter o problema precisa ser avisado de novo.
    await pool.query(
      `update agent_inbox_items set status = 'resolved'
        where organization_id = $1 and ref_id = $2 and title = $3`,
      [ORG, LEAD_B, aviso("perda_sem_motivo").title],
    );

    await gravar("perda_sem_motivo", LEAD_B);

    expect(await abertos(LEAD_B, aviso("perda_sem_motivo").title)).toBe(1);
  });
});

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { bodyHash, pgSendLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import {
  comSaida,
  rodapeDeSaida,
  temSaida,
  textoDaSaidaEfetivo,
} from "@/lib/prospecting/rodape-de-saida";
import {
  SQL_MENSAGEM_GUARDADA,
  enviarComSaidaConfiguravel,
} from "@/lib/prospecting/saida-configuravel";

/**
 * O REPROCESSO DA SAÍDA LÊ SÓ AS BOLHAS DO ENVIO (#4370 — correção pedida pelo
 * mantenedor no PR #4654).
 *
 * ─── O que estava errado ────────────────────────────────────────────────────
 *
 * O `send_ledger` tem UMA LINHA POR MENSAGEM FÍSICA, com `unique (job_id, seq)`.
 * O `seq` é o contador do TURNO: em `lib/agent-engine/agent/inbound-turn.ts` ele
 * nasce em 0 no início do run e o `enviar` faz `seq += 1` a cada bolha — e ele
 * CONTINUA crescendo entre duas chamadas de `send_message` do mesmo turno, com o
 * mesmo `job_id`. Quem lê o ledger só por `seq >= $3` não separa um envio do
 * outro, e a consulta do reprocesso fazia exatamente isso.
 *
 * Medido pelo mantenedor em Postgres 17, com os SQLs extraídos do arquivo:
 *
 *   - cenário A — 1 envio em 3 bolhas, saída na última: acha (certo);
 *   - cenário B — 2 envios no turno, saída no 1º: NÃO acha, porque a
 *     concatenação puxa o texto do envio seguinte e `temSaida` olha o FIM;
 *   - cenário C — 2 envios no turno, saída no 2º: o 1º "acha" a frase do 2º.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * Com a fronteira do envio (`send_ledger.envio_seq`, gravada NA ESCRITA por
 * `pgSendLedger.create`), o reprocesso lê `envio_seq = <1ª bolha do envio>`:
 * cada cenário acima vira um caso, e o A continua certo. A linha ANTERIOR à
 * migration — sem a marca — cai na régua de antes (`seq >= $3`), e isso também
 * está preso aqui: é comportamento preservado, não um efeito colateral.
 *
 * Sem esta fronteira o arquivo REPROVA nos cenários B e C — é a prova de que o
 * defeito não volta.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
/** Um job por cenário: o ledger é lido por (job_id, âncora) e um caso não pode contaminar o outro. */
const JOB_A = "eeeeeeee-0000-4000-8000-0000000000a1";
const JOB_B = "eeeeeeee-0000-4000-8000-0000000000b1";
const JOB_C = "eeeeeeee-0000-4000-8000-0000000000c1";
const JOB_LEGADO = "eeeeeeee-0000-4000-8000-0000000000d1";
const JOB_ESCRITA = "eeeeeeee-0000-4000-8000-0000000000e1";

/** A frase padrão do pt-BR — a campanha dos cenários não tem `texto_da_saida` próprio. */
const RODAPE = rodapeDeSaida("pt-BR");

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, locale)
     values ($1,'envio-do-ledger','Envio do Ledger','Envio do Ledger','pt-BR')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do reprocesso','+5511999990777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'envio-do-ledger-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  for (const job of [JOB_A, JOB_B, JOB_C, JOB_LEGADO, JOB_ESCRITA]) {
    await pool.query(
      `insert into job_queue (id, organization_id, contact_id, kind, payload)
       values ($1,$2,$3,'inbound_turn','{}'::jsonb) on conflict (id) do nothing`,
      [job, ORG, CONTACT],
    );
  }
});

/**
 * Escreve UM envio no ledger pela porta de produção (`pgSendLedger`), com as
 * bolhas na ordem em que o turno as emitiu.
 *
 * `comFronteira: false` grava como a linha era ANTES da 9407: sem `envio_seq`.
 * É o que prova o recuo para a régua anterior.
 */
async function escreveEnvio(opcoes: {
  job: string;
  seqInicial: number;
  bolhas: readonly string[];
  comFronteira?: boolean;
  status?: "queued" | "accepted";
}): Promise<number[]> {
  const store = pgSendLedger(pool);
  const seqs: number[] = [];
  for (const [indice, bolha] of opcoes.bolhas.entries()) {
    const seq = opcoes.seqInicial + indice;
    const mensagemId = randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,'text','outbound','sent',$6,'external_device', now())`,
      [mensagemId, ORG, CONV, SESSION, CONTACT, bolha],
    );
    const chave = await store.create(
      {
        tenantId: ORG,
        leadId: CONTACT,
        jobId: opcoes.job,
        seq,
        ...(opcoes.comFronteira === false ? {} : { envioSeq: opcoes.seqInicial }),
        body: bolha,
      },
      bodyHash(bolha),
    );
    await store.update(ORG, chave, opcoes.status ?? "accepted", mensagemId, null);
    seqs.push(seq);
  }
  return seqs;
}

/** O que a consulta do reprocesso devolve para (job, âncora) — o corpo e o idioma. */
async function leGuardado(job: string, ancora: number) {
  const { rows } = await pool.query<{
    body: string | null;
    locale: string | null;
    texto_da_saida: string | null;
  }>(SQL_MENSAGEM_GUARDADA, [ORG, job, ancora, CONV]);
  return rows[0] ?? null;
}

/** "Esta tentativa já ofereceu a saída?" — a MESMA régua que o envio usa (fim do corpo). */
function achaASaida(linha: { body: string | null; locale: string | null; texto_da_saida: string | null } | null) {
  if (!linha) return false;
  return temSaida(linha.body ?? "", linha.locale, linha.texto_da_saida);
}

/** O corpo que o reprocesso transmite, passando pelo wrapper de verdade (db real). */
async function corpoDoReprocesso(job: string, ancora: number, corpoDaTentativa: string): Promise<string> {
  let enviado = "";
  await enviarComSaidaConfiguravel(
    {
      db: pool,
      organizationId: ORG,
      conversationId: CONV,
      via: "inbound_turn",
      mensagem: { jobId: job, seq: ancora },
      avisar: () => {},
    },
    corpoDaTentativa,
    async (corpo) => {
      enviado = corpo;
      return { kind: "sent", idempotencyKey: "k", messageId: "m" };
    },
  );
  return enviado;
}

describe("cenário A — 1 envio em 3 bolhas, saída na última", () => {
  it("acha a saída e concatena as três bolhas na ordem", async () => {
    const bolhas = ["Oi! Somos a Acme.", "Podemos te mostrar o serviço?", RODAPE];
    await escreveEnvio({ job: JOB_A, seqInicial: 1, bolhas });

    const linha = await leGuardado(JOB_A, 1);
    expect(linha).not.toBeNull();
    // A concatenação é o envio inteiro, na ordem do `seq`.
    expect(linha!.body).toBe(bolhas.join(" "));
    expect(achaASaida(linha), "o cenário A é o conserto do #4370 e não pode regredir").toBe(true);
  });
});

describe("cenário B — 2 envios no turno, saída no 1º", () => {
  const ENVIO_1 = ["Oi! Somos a Acme.", `Quer que eu mande o link?\n\n${RODAPE}`];
  const ENVIO_2 = ["Fechou então, falo com você amanhã."];

  it("o reprocesso do 1º envio NÃO puxa o texto do 2º — e acha a saída", async () => {
    await escreveEnvio({ job: JOB_B, seqInicial: 1, bolhas: ENVIO_1 });
    await escreveEnvio({ job: JOB_B, seqInicial: 3, bolhas: ENVIO_2 });

    const linha = await leGuardado(JOB_B, 1);
    expect(linha!.body).toBe(ENVIO_1.join(" "));
    expect(linha!.body).not.toContain(ENVIO_2[0]);
    expect(achaASaida(linha), "o reenvio sairia sem a frase com `exit_offered_at` dizendo que ela foi oferecida").toBe(
      true,
    );
  });

  it("e o corpo do reenvio sai COM a frase", async () => {
    const enviado = await corpoDoReprocesso(JOB_B, 1, "Quer que eu mande o link?");
    expect(enviado.endsWith(textoDaSaidaEfetivo(null, "pt-BR"))).toBe(true);
  });
});

describe("cenário C — 2 envios no turno, saída no 2º", () => {
  const ENVIO_1 = ["Oi! Somos a Acme.", "Podemos te mostrar o serviço?"];
  const ENVIO_2 = ["Fechou então.", `Falo com você amanhã.\n\n${RODAPE}`];

  it("o 1º envio NÃO acha a saída que é do 2º (o PARAR não sai duas vezes)", async () => {
    await escreveEnvio({ job: JOB_C, seqInicial: 1, bolhas: ENVIO_1 });
    await escreveEnvio({ job: JOB_C, seqInicial: 3, bolhas: ENVIO_2 });

    const primeiro = await leGuardado(JOB_C, 1);
    expect(primeiro!.body).toBe(ENVIO_1.join(" "));
    expect(achaASaida(primeiro), "o 1º envio ganharia a frase do 2º e o PARAR sairia duas vezes").toBe(false);
  });

  it("o 2º envio acha a saída dele", async () => {
    const segundo = await leGuardado(JOB_C, 3);
    expect(segundo!.body).toBe(ENVIO_2.join(" "));
    expect(achaASaida(segundo)).toBe(true);
  });

  it("e o corpo do reenvio do 1º envio sai SEM a frase", async () => {
    const enviado = await corpoDoReprocesso(JOB_C, 1, "Podemos te mostrar o serviço?");
    expect(enviado).toBe("Podemos te mostrar o serviço?");
  });
});

describe("linha ANTERIOR à migration (sem a fronteira) — comportamento preservado", () => {
  it("sem `envio_seq`, cai na régua de antes: lê do `seq` da âncora em diante", async () => {
    // O corpo guardado do turno antigo, com a saída na 2ª bolha e o `seq` subindo.
    const bolhas = ["Oi! Somos a Acme.", `Quer que eu mande o link?\n\n${RODAPE}`];
    await escreveEnvio({ job: JOB_LEGADO, seqInicial: 1, bolhas, comFronteira: false });

    const { rows: semMarca } = await pool.query<{ envio_seq: number | null }>(
      "select envio_seq from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, JOB_LEGADO],
    );
    expect(semMarca.map((l) => l.envio_seq)).toEqual([null, null]);

    const daAncora = await leGuardado(JOB_LEGADO, 1);
    expect(daAncora!.body).toBe(bolhas.join(" "));
    expect(achaASaida(daAncora)).toBe(true);
  });
});

describe("a fronteira é gravada NA ESCRITA, e a identidade da linha não muda", () => {
  it("`create` grava `envio_seq` = âncora do envio em todas as bolhas", async () => {
    const seqs = await escreveEnvio({
      job: JOB_ESCRITA,
      seqInicial: 4,
      bolhas: ["a", "b"],
      status: "queued",
    });
    expect(seqs).toEqual([4, 5]);

    const { rows } = await pool.query<{ seq: number; envio_seq: number | null; status: string }>(
      "select seq, envio_seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, JOB_ESCRITA],
    );
    // A linha continua sendo uma MENSAGEM FÍSICA (`seq`), e o envio é a fronteira.
    expect(rows).toEqual([
      { seq: 4, envio_seq: 4, status: "queued" },
      { seq: 5, envio_seq: 4, status: "queued" },
    ]);
  });

  it("`unique (job_id, seq)` continua valendo — a identidade exactly-once não mudou", async () => {
    const store = pgSendLedger(pool);
    await expect(
      store.create(
        { tenantId: ORG, leadId: CONTACT, jobId: JOB_ESCRITA, seq: 4, envioSeq: 4, body: "outro texto" },
        bodyHash("outro texto"),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("sem `envioSeq` (follow-up de mensagem única, envio fixo, voz fora do envio) grava NULL", async () => {
    const store = pgSendLedger(pool);
    const chave = await store.create(
      { tenantId: ORG, leadId: CONTACT, jobId: JOB_ESCRITA, seq: 9, body: "só uma" },
      bodyHash("só uma"),
    );
    const { rows } = await pool.query<{ envio_seq: number | null }>(
      "select envio_seq from send_ledger where organization_id = $1 and id = $2",
      [ORG, chave],
    );
    expect(rows[0]!.envio_seq).toBeNull();
  });
});

describe("a saída personalizada do dono continua vindo do banco", () => {
  it("o `texto_da_saida` da campanha é o que a concatenação do envio precisa fechar", async () => {
    // Prova de que a régua lê o texto do DONO (e não a frase padrão): a mesma
    // bolha que fecha com o rodapé padrão NÃO fecha com um texto próprio.
    const corpo = comSaida("Oi!", "pt-BR", "Escreva PARAR que eu não chamo mais.");
    expect(temSaida(corpo, "pt-BR", "Escreva PARAR que eu não chamo mais.")).toBe(true);
    expect(temSaida(corpo, "pt-BR", null)).toBe(false);
    expect(textoDaSaidaEfetivo("Escreva PARAR que eu não chamo mais.", "pt-BR")).toBe(
      "Escreva PARAR que eu não chamo mais.",
    );
  });
});

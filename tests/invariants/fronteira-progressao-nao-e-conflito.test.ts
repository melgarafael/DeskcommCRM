import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_ORG, GOV_SESSION } from "./gov-helpers";

/**
 * "NÃO HAVIA ATENDIMENTO / HÁ AGORA" É PROGRESSÃO, NÃO CONFLITO.
 *
 * O CAS de `fn_service_begin` existe para impedir que trabalho antigo aja sobre
 * um atendimento que mudou debaixo dele. Quando a observação diz `absent`, não
 * havia atendimento em voo — nada podia ter mudado sob o chamador. Mesmo assim
 * o código comparava a fronteira de agora contra o literal `{"absent":true}`,
 * que difere sempre, e levantava `service_stale` no caminho ORDINÁRIO.
 *
 * O custo era invisível: um lead criado e depois movido de etapa gera dois
 * eventos observados como `absent`; resolver o primeiro cria a conversa e o
 * segundo morria com 40001 — que `serviceForEvent` engole como `stale_origin`.
 * O follow-up de etapa simplesmente não nascia, sem erro em lugar nenhum.
 *
 * Este arquivo guarda os dois lados: a progressão passa, e o atendimento OUTRO
 * continua sendo recusado.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
beforeAll(() => {
  seedGov();
});
afterAll(async () => {
  await pool.end();
});

describe("fronteira: progressão não é conflito", () => {
  it("segunda origem observada como ausente aceita a conversa que a primeira criou", async () => {
    const contato = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Progressão')",
      [contato, GOV_ORG],
    );
    const ausente = JSON.stringify({ organization_id: GOV_ORG, contact_id: contato, absent: true });

    // 1ª resolução: não há conversa, a observação diz `absent` — cria.
    const primeira = await pool.query("select public.fn_service_begin($1,$2,$3,$4::jsonb) as b", [
      GOV_ORG,
      contato,
      GOV_SESSION,
      ausente,
    ]);
    expect(
      primeira.rows[0].b?.conversation_id,
      "a primeira origem abre o atendimento",
    ).toBeTruthy();

    // 2ª resolução com a MESMA observação: a conversa agora existe. Isto é o
    // caminho ordinário (lead criado e movido), e era ele que morria.
    const segunda = await pool.query("select public.fn_service_begin($1,$2,$3,$4::jsonb) as b", [
      GOV_ORG,
      contato,
      GOV_SESSION,
      ausente,
    ]);
    expect(
      segunda.rows[0].b?.conversation_id,
      "a segunda origem tem de reaproveitar o mesmo atendimento, não morrer em service_stale",
    ).toBe(primeira.rows[0].b.conversation_id);
  });

  it("observação que descreve OUTRO atendimento continua sendo recusada", async () => {
    const contato = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Outro')",
      [contato, GOV_ORG],
    );
    const ausente = JSON.stringify({ organization_id: GOV_ORG, contact_id: contato, absent: true });
    const criada = await pool.query("select public.fn_service_begin($1,$2,$3,$4::jsonb) as b", [
      GOV_ORG,
      contato,
      GOV_SESSION,
      ausente,
    ]);
    // Uma fronteira concreta que NÃO é a vigente: revisão adiantada. O
    // afrouxamento vale só para a partida `absent`; isto tem de continuar 40001.
    const forjada = JSON.stringify({ ...criada.rows[0].b, service_revision: 99 });
    await expect(
      pool.query("select public.fn_service_begin($1,$2,$3,$4::jsonb)", [
        GOV_ORG,
        contato,
        GOV_SESSION,
        forjada,
      ]),
    ).rejects.toMatchObject({ code: "40001" });
  });
});

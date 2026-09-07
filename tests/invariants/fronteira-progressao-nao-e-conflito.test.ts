import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_ORG, GOV_SESSION, GOV_PIPELINE, GOV_STAGE } from "./gov-helpers";

/**
 * PARA UM EVENTO, `absent` É PROCEDÊNCIA — PARA UM ATOR, É REIVINDICAÇÃO.
 *
 * O CAS de `fn_service_begin` recusa quem chega com uma observação que o mundo
 * já superou, e isso é proteção de CONCORRÊNCIA: dois atores que observaram
 * "não há atendimento" não podem agir os dois. Esse lado continua guardado por
 * `service-boundary.test.ts` — e o segundo caso aqui confirma que não o
 * afrouxei ao consertar o primeiro.
 *
 * Um EVENTO é outra coisa. O retrato `absent` dele diz "quando este evento foi
 * emitido não havia atendimento", e a resolução de cada evento já é idempotente
 * pelo memo `event_service_origins`. Não há corrida a arbitrar — e, sem essa
 * distinção, o caminho ORDINÁRIO morria: um lead criado e depois movido de
 * etapa gera DOIS eventos, cada um com seu retrato `absent`; resolver o
 * primeiro cria a conversa e o segundo levantava 40001, que `serviceForEvent`
 * engole como `stale_origin`. O follow-up de etapa não nascia, sem erro em
 * lugar nenhum — foi assim que `gatilho-de-etapa.spec.ts` ficou vermelho sem
 * dizer por quê.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
beforeAll(() => seedGov());
afterAll(async () => {
  await pool.end();
});

describe("fronteira: progressão de evento não é conflito", () => {
  it("dois eventos do mesmo contato, ambos observados sem atendimento, resolvem para a MESMA conversa", async () => {
    const contact = randomUUID(),
      lead = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Progressão')", [
      contact,
      GOV_ORG,
    ]);
    await pool.query(
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,$5,'Progressão')",
      [lead, GOV_ORG, contact, GOV_PIPELINE, GOV_STAGE],
    );

    // Os DOIS retratos são tirados ANTES de existir conversa — é assim que a
    // vida real acontece: os dois eventos nascem antes de alguém atender.
    const snapshot = async () =>
      (await pool.query("select fn_service_observe_command($1,$2) s", [GOV_ORG, contact])).rows[0]
        .s;
    const emitir = async (tipo: string, observed: unknown) =>
      (
        await pool.query("select emit_event($1,'crm_lead',$2,$3::jsonb,'{}',$4) id", [
          tipo,
          lead,
          JSON.stringify({ service_origin: { kind: "command", observed } }),
          GOV_ORG,
        ])
      ).rows[0].id;
    const primeiro = await emitir("lead.created", await snapshot());
    const segundo = await emitir("lead.stage_changed", await snapshot());

    const resolver = async (event: string) =>
      (
        await pool.query("select fn_service_event_origin($1,$2,$3,$4) b", [
          GOV_ORG,
          event,
          contact,
          GOV_SESSION,
        ])
      ).rows[0].b;

    const a = await resolver(primeiro);
    expect(a?.conversation_id, "a primeira origem abre o atendimento").toBeTruthy();
    const b = await resolver(segundo);
    expect(
      b?.conversation_id,
      "o segundo evento tem de pegar o MESMO atendimento, não morrer em service_stale",
    ).toBe(a.conversation_id);
  });

  it("evento emitido SEM origem (a rota do quadro) ganha o carimbo do servidor e resolve", async () => {
    // A rota `/api/v1/leads/[id]/move` é autenticada, e `emit_event` RECUSA
    // `service_origin` vindo de chamador autenticado (42501) — é o campo que
    // autoriza efeito operacional. Só que ninguém o escrevia no lugar dela: o
    // evento nascia sem origem, `fn_service_event_origin` caía no `service_stale`
    // final e `serviceForEvent` engolia como `stale_origin`. Quem move o negócio
    // pela IA carimba a origem no servidor e o follow-up nasce; quem move PELO
    // QUADRO não, e o gatilho de etapa era inalcançável pela tela.
    const contact = randomUUID(),
      lead = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Sem origem')", [
      contact,
      GOV_ORG,
    ]);
    await pool.query(
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,$5,'Sem origem')",
      [lead, GOV_ORG, contact, GOV_PIPELINE, GOV_STAGE],
    );
    // Exatamente o que a rota manda: payload de negócio, zero origem.
    const evento = (
      await pool.query(
        "select emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,'{}',$3) id",
        [lead, JSON.stringify({ from_stage_id: null, to_stage_id: GOV_STAGE }), GOV_ORG],
      )
    ).rows[0].id;
    const linha = (await pool.query("select payload from event_log where id=$1", [evento])).rows[0]
      .payload;
    expect(
      linha.service_origin?.kind,
      "o servidor tem de carimbar a origem que ele proíbe o chamador de mandar",
    ).toBe("command");
    expect(
      (await pool.query("select fn_service_event_origin($1,$2,$3) b", [GOV_ORG, evento, contact]))
        .rows[0].b?.conversation_id,
      "e com o carimbo o evento resolve, em vez de morrer em stale_origin",
    ).toBeTruthy();
  });

  it("origem já presente não é sobrescrita pelo carimbo automático", async () => {
    // Quem move pela IA já resolve a origem no servidor e a passa. O carimbo
    // automático não pode atropelá-la: ela pode ser uma CONTINUAÇÃO, que é o que
    // amarra o efeito ao atendimento de onde ele nasceu.
    const contact = randomUUID(),
      lead = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Com origem')", [
      contact,
      GOV_ORG,
    ]);
    await pool.query(
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,$5,'Com origem')",
      [lead, GOV_ORG, contact, GOV_PIPELINE, GOV_STAGE],
    );
    const proprio = { kind: "command", observed: { marca: "veio-de-quem-emitiu" } };
    const evento = (
      await pool.query(
        "select emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,'{}',$3) id",
        [lead, JSON.stringify({ service_origin: proprio }), GOV_ORG],
      )
    ).rows[0].id;
    expect(
      (await pool.query("select payload from event_log where id=$1", [evento])).rows[0].payload
        .service_origin.observed.marca,
    ).toBe("veio-de-quem-emitiu");
  });

  it("o CAS do chamador direto continua recusando observação que o mundo superou", async () => {
    // A metade que NÃO pode afrouxar junto: quem chama `fn_service_begin` com
    // um retrato `absent` já superado é um ator em corrida, e perde.
    const contact = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Corrida')", [
      contact,
      GOV_ORG,
    ]);
    const observed = (await pool.query("select fn_service_observe($1,$2) s", [GOV_ORG, contact]))
      .rows[0].s;
    expect(observed.absent).toBe(true);
    await pool.query("select fn_service_begin($1,$2,null,$3)", [GOV_ORG, contact, observed]);
    await expect(
      pool.query("select fn_service_begin($1,$2,null,$3)", [GOV_ORG, contact, observed]),
    ).rejects.toMatchObject({ code: "40001" });
  });
});

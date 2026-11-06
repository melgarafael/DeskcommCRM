import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_SESSION,
  seedGov,
  sql,
} from "./gov-helpers";

const importacao = randomUUID();
const mensagem = randomUUID();

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.importacoes_de_historico
      (id,organization_id,channel_session_id,status,dias,origem)
    values ('${importacao}','${GOV_ORG}','${GOV_SESSION}','concluida',30,'manual');
    insert into public.messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,external_id,
       type,direction,status,sent_via,body,sent_at,metadata)
    values
      ('${mensagem}','${GOV_ORG}','${GOV_CONV_UNASSIGNED}','${GOV_SESSION}',
       '${GOV_CONTACT_1}','hist-${mensagem}','text','inbound','received','external_device',
       'Preciso de 500 cadeiras',clock_timestamp(),
       jsonb_build_object('historico_importado','true','importacao_id','${importacao}'));
  `);
});

describe("histórico analisado pela fila existente", () => {
  it("enfileira uma vez por importação+contato e o segundo clique é idempotente", () => {
    expect(sql(`select public.fn_enqueue_historico_analise('${GOV_ORG}','${importacao}');`)).toBe("1");
    expect(sql(`select public.fn_enqueue_historico_analise('${GOV_ORG}','${importacao}');`)).toBe("0");
    expect(
      sql(`select kind||'|'||contact_id||'|'||(payload->>'conversation_id')
             from public.job_queue
            where organization_id='${GOV_ORG}' and payload->>'importacao_id'='${importacao}';`),
    ).toBe(`history_analysis|${GOV_CONTACT_1}|${GOV_CONV_UNASSIGNED}`);
  });

  it("falha terminal volta a pending sem duplicar a linha", () => {
    sql(`update public.job_queue set status='dead',attempts=3,last_error='sem PII'
          where organization_id='${GOV_ORG}' and payload->>'importacao_id'='${importacao}';`);
    expect(sql(`select public.fn_enqueue_historico_analise('${GOV_ORG}','${importacao}');`)).toBe("1");
    expect(
      sql(`select status||'|'||attempts||'|'||count(*) over ()
             from public.job_queue
            where organization_id='${GOV_ORG}' and payload->>'importacao_id'='${importacao}';`),
    ).toBe("pending|0|1");
  });

  it("o kind exige contato e as funções não são API autenticada", () => {
    expect(() =>
      sql(`insert into public.job_queue(organization_id,kind,payload)
           values('${GOV_ORG}','history_analysis','{}');`),
    ).toThrow(/job_queue_turn_needs_contact/);
    expect(
      sql(`select has_function_privilege('authenticated','public.fn_enqueue_historico_analise(uuid,uuid)','execute'),
                  has_function_privilege('service_role','public.fn_enqueue_historico_analise(uuid,uuid)','execute');`),
    ).toBe("f|t");
  });

  it("resumo expõe somente contagens", () => {
    expect(
      JSON.parse(sql(`select public.fn_resumo_historico_analise('${GOV_ORG}','${importacao}');`)),
    ).toMatchObject({ total: 1, pending: 1, running: 0, done: 0, failed: 0, dead: 0 });
  });
});

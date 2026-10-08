/**
 * O anexo da nota interna obedece ao MESMO interruptor e à MESMA pausa LGPD da
 * mídia de conversa — `fn_enfileirar_midia_vencida`, passo 2c (0572, #1887).
 *
 * Decisão do mantenedor no PR #2309 (opção A): o anexo de nota segue a mesma
 * regra da mídia de conversa — mesmo prazo, mesmo interruptor
 * `media_retention_enforced` e mesma pausa por pedido LGPD em andamento (0557,
 * PR #2180). Sem isto, o anexo de nota seria a ÚNICA coisa apagada numa
 * organização que desligou a limpeza, e um pedido LGPD aberto não o seguraria.
 *
 * Cada caso tem controle positivo (o mesmo fixture SAI quando a trava solta):
 * sem ele, uma função que não faz nada passaria nos "o arquivo fica".
 *
 * Arquivo separado de `retencao-do-anexo-da-nota-por-idade.test.ts` porque
 * `tests/invariants/**` é congelado: invariante novo entra, existente não muda.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GOV_CONV_UNASSIGNED, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const CONVERSA = GOV_CONV_UNASSIGNED;
const ORG = GOV_ORG;

const NOTA = "43870000-0000-4000-8000-0000000000b1";
const PEDIDO_LGPD = "43870000-0000-4000-8000-0000000000b2";
const ANEXO = `${ORG}/${CONVERSA}/note-trava.png`;

const naFila = () =>
  Number(
    lastLine(
      sql(`select count(*) from storage_redaction_queue where bucket = 'internal-media' and object_path = '${ANEXO}'`),
    ),
  );

const ponteiro = () =>
  lastLine(sql(`select coalesce(media_storage_path, 'NULL') from conversation_notes where id = '${NOTA}';`));

const roda = () => JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));

beforeEach(() => {
  seedGov();
  sql(`
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('internal-media', 'internal-media', false, 52428800)
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from storage.objects where name like '${ORG}/%';
    delete from conversation_notes where organization_id = '${ORG}';
    delete from lgpd_requests where organization_id = '${ORG}';
    update organizations set media_retention_days = 60, media_retention_enforced = true where id = '${ORG}';
    insert into conversation_notes (id, organization_id, conversation_id, body, media_storage_path,
                                    media_mime, media_size_bytes, created_at)
      values ('${NOTA}', '${ORG}', '${CONVERSA}', 'anotação viva', '${ANEXO}', 'image/png', 1000,
              now() - interval '400 days');
    insert into storage.objects (bucket_id, name, metadata, created_at)
      values ('internal-media', '${ANEXO}', '{"size": 1000}'::jsonb, now() - interval '400 days');
  `);
});

describe("anexo da nota interna — interruptor e pausa LGPD (0572, decisão A do #2309)", () => {
  it("organização com a limpeza DESLIGADA não perde anexo de nota; religada, ele sai", () => {
    sql(`update organizations set media_retention_enforced = false where id = '${ORG}'`);

    const r = roda();

    expect(naFila(), "interruptor desligado: o arquivo fica").toBe(0);
    expect(ponteiro(), "interruptor desligado: o ponteiro fica").toBe(ANEXO);
    expect(r.vencidas).toBe(0);

    sql(`update organizations set media_retention_enforced = true where id = '${ORG}'`);
    roda();
    expect(naFila(), "religado, o anexo vencido sai").toBe(1);
    expect(ponteiro()).toBe("NULL");
  });

  it("pedido LGPD em andamento pausa a retenção do anexo de nota; concluído, ela volta", () => {
    sql(`insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
           values ('${PEDIDO_LGPD}', '${ORG}', 'data_request', 'manual', 'tenant', now() + interval '7 days');`);

    const r = roda();

    expect(naFila(), "pedido em curso: o arquivo fica").toBe(0);
    expect(ponteiro(), "pedido em curso: o ponteiro fica").toBe(ANEXO);
    expect(r.vencidas).toBe(0);

    sql(`update lgpd_requests set status = 'completed', completed_at = now() where id = '${PEDIDO_LGPD}';`);
    roda();
    expect(naFila(), "pedido concluído, o anexo vencido sai").toBe(1);
    expect(ponteiro()).toBe("NULL");
  });
});

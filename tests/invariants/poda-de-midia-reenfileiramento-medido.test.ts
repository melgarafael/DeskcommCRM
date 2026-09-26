/**
 * Reenfileirar um caminho que JÁ SAIU da fila (migration 0434, issue #1739).
 *
 * A 0432 enfileirava com `on conflict (bucket, object_path) do nothing` sobre
 * um `unique (bucket, object_path)`, e o worker marca a linha como `deleted`
 * (`lib/lgpd/storage-redaction-queue.ts`) sem nada a remover depois. A
 * consequência medida na issue: um arquivo NOVO gravado num caminho que já saiu
 * era engolido num no-op silencioso — nunca mais podado —, e a fila crescia sem
 * teto.
 *
 * O reaproveitamento de `object_path` NÃO é teórico (medido antes do conserto):
 * `app/api/v1/cron/contact-avatars/route.ts:204` grava
 * `${org}/avatars/${contactId}.jpg` com `upsert: true` — caminho estável por
 * contato, regravado a cada refresh —, e `workers/media-persist-worker.ts:122`
 * usa `storagePathFor` (determinístico por mensagem, regravado no retry).
 *
 * O que este arquivo vigia, cada um por um modo de falha concreto:
 *   - `deleted` reabre quando o mesmo caminho volta a ser pedido (vencida E órfão);
 *   - `skipped` reabre do mesmo jeito;
 *   - `pending` e `failed` em curso NÃO são tocados (o `where` do `do update`);
 *   - linha `deleted` com mais de 90 dias é expurgada no mesmo cron; a recente
 *     e a `pending` antiga ficam;
 *   - a rodada seguinte continua idempotente: reabrir não enfileira duas vezes.
 *
 * Arquivo NOVO porque `tests/invariants/**` é congelado.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "17390000-0000-4000-8000-000000000001";
const CONTATO = "17390000-0000-4000-8000-000000000002";
const SESSAO = "17390000-0000-4000-8000-000000000003";
const CONVERSA = "17390000-0000-4000-8000-000000000004";
const MSG = "17390000-0000-4000-8000-000000000010";

/** Caminho de mensagem: determinístico por mensagem (`storagePathFor`). */
const MENSAGEM = `${ORG}/${CONVERSA}/reenfileirada.mp4`;
/** Caminho de avatar: ESTÁVEL por contato, reaproveitado a cada refresh do cron. */
const AVATAR_PULADO = `${ORG}/avatars/pulado.jpg`;
const AVATAR_PENDENTE = `${ORG}/avatars/pendente.jpg`;
const AVATAR_FALHO = `${ORG}/avatars/falho.jpg`;
/** Linhas do expurgo: sem objeto no bucket, nunca entram no passo 2. */
const VELHA = `${ORG}/avatars/expurgo-antigo.jpg`;
const RECENTE = `${ORG}/avatars/expurgo-recente.jpg`;
const PENDENTE_VELHA = `${ORG}/avatars/pendente-velha.jpg`;

const conta = (q: string) => Number(lastLine(sql(q)));
const naFila = (p: string) =>
  conta(
    `select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`,
  );
/** `status|attempts|processed_at|error_message` da linha do caminho. */
const estado = (p: string) =>
  lastLine(
    sql(
      `select coalesce(status, 'NULA') || '|' || attempts || '|' || coalesce(processed_at::text, 'NULO') || '|' || coalesce(error_message, 'NULO')
         from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`,
    ),
  );
const rodar = () => JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));

function objeto(nome: string, idadeDias: number): string {
  return `insert into storage.objects (bucket_id, name, metadata, created_at)
          values ('whatsapp-media', '${nome}', '{"size": 1000}'::jsonb, now() - interval '${idadeDias} days');`;
}

/** Linha já existente na fila, com o estado que se quer observar. */
function linhaFila(
  caminho: string,
  status: string,
  o: { attempts?: number; enqueuedDias?: number; processadaDias?: number | null; erro?: string | null } = {},
): string {
  const processada =
    o.processadaDias === undefined || o.processadaDias === null
      ? "null"
      : `now() - interval '${o.processadaDias} days'`;
  const erro = o.erro === undefined || o.erro === null ? "null" : `'${o.erro}'`;
  return `insert into storage_redaction_queue (organization_id, bucket, object_path, status, attempts, enqueued_at, processed_at, error_message)
          values ('${ORG}', 'whatsapp-media', '${caminho}', '${status}', ${o.attempts ?? 0},
                  now() - interval '${o.enqueuedDias ?? 1} days', ${processada}, ${erro});`;
}

beforeEach(() => {
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media') on conflict (id) do nothing;
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from storage.objects where name like '${ORG}/%';
    delete from messages where organization_id = '${ORG}';
    delete from conversations where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name, media_retention_days)
      values ('${ORG}', 'org-midia-1739', 'Org Midia 1739 LTDA', 'Org Midia 1739', 60)
      on conflict (id) do update set media_retention_days = 60;
    insert into contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Cliente', '+5511900001739');
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'midia-1739', 'WORKING', '\\x00'::bytea);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open', false);
    insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, body, sent_via, sent_at, created_at, media_storage_path)
      values ('${MSG}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'video', 'inbound', 'delivered',
              'a mensagem que já perdeu o arquivo', 'external_device', now() - interval '100 days', now() - interval '100 days', '${MENSAGEM}');
    ${objeto(MENSAGEM, 100)}
  `);
});

describe("fn_enfileirar_midia_vencida — reenfileiramento (0434)", () => {
  it("deleted reabre pela via da VENCIDA: o pedido novo volta a pending e a mensagem perde o arquivo", () => {
    // O arquivo sumiu uma vez (`deleted`); alguém gravou um arquivo NOVO no
    // mesmo caminho e a retenção voltou a enfileirar. Com o `do nothing` da
    // 0432 este pedido era engolido e o arquivo novo ficava fora da poda.
    sql(linhaFila(MENSAGEM, "deleted", { attempts: 1, enqueuedDias: 40, processadaDias: 30 }));

    const r = rodar();

    expect(r.vencidas).toBeGreaterThanOrEqual(1);
    expect(naFila(MENSAGEM)).toBe(1);
    expect(estado(MENSAGEM)).toBe("pending|0|NULO|NULO");
    expect(lastLine(sql(`select coalesce(media_storage_path, 'NULO') from messages where id = '${MSG}'`))).toBe("NULO");
  });

  it("skipped reabre pela via do ÓRFÃO: o avatar reaproveitado volta para a fila", () => {
    // O caso do avatar: caminho estável por contato, `upsert` a cada refresh.
    // «Objeto não existe» (skipped) numa rodada anterior não pode segurar o
    // caminho para sempre — o objeto novo de hoje tem de entrar na fila.
    sql(objeto(AVATAR_PULADO, 50));
    sql(linhaFila(AVATAR_PULADO, "skipped", { attempts: 1, enqueuedDias: 20, processadaDias: 20 }));

    const r = rodar();

    expect(r.orfas).toBeGreaterThanOrEqual(1);
    expect(naFila(AVATAR_PULADO)).toBe(1);
    expect(estado(AVATAR_PULADO)).toBe("pending|0|NULO|NULO");
  });

  it("pending e failed em curso não são tocados — o where do do update é a garantia", () => {
    sql(objeto(AVATAR_PENDENTE, 50));
    sql(objeto(AVATAR_FALHO, 50));
    sql(linhaFila(AVATAR_PENDENTE, "pending", { attempts: 2, enqueuedDias: 2, erro: "storage_remove_failed" }));
    sql(linhaFila(AVATAR_FALHO, "failed", { attempts: 3, enqueuedDias: 6, processadaDias: 4, erro: "storage_remove_failed" }));

    const r = rodar();

    // Nenhum dos dois órfãos entra (o filtro conta só linha EM CURSO como
    // «já na fila») e nenhum é reescrito; a única entrada é a vencida do
    // fixture, que nunca teve linha nenhuma.
    expect(r).toEqual({ vencidas: 1, orfas: 0 });
    expect(estado(AVATAR_PENDENTE)).toBe("pending|2|NULO|storage_remove_failed");
    expect(estado(AVATAR_FALHO)).toMatch(/^failed\|3\|[^N]/);
    expect(estado(AVATAR_FALHO).endsWith("|storage_remove_failed")).toBe(true);
    expect(naFila(AVATAR_PENDENTE)).toBe(1);
    expect(naFila(AVATAR_FALHO)).toBe(1);
  });

  it("deleted com mais de 90 dias é expurgada; a recente e a pending antiga ficam", () => {
    sql(linhaFila(VELHA, "deleted", { attempts: 1, enqueuedDias: 100, processadaDias: 100 }));
    sql(linhaFila(RECENTE, "deleted", { attempts: 1, enqueuedDias: 10, processadaDias: 10 }));
    sql(linhaFila(PENDENTE_VELHA, "pending", { attempts: 1, enqueuedDias: 200 }));

    rodar();

    expect(naFila(VELHA)).toBe(0);
    expect(naFila(RECENTE)).toBe(1);
    expect(naFila(PENDENTE_VELHA)).toBe(1);
  });

  it("a rodada seguinte continua idempotente: reabrir não enfileira duas vezes", () => {
    sql(linhaFila(MENSAGEM, "deleted", { attempts: 1, enqueuedDias: 40, processadaDias: 30 }));
    rodar();

    const segunda = rodar();

    expect(segunda).toEqual({ vencidas: 0, orfas: 0 });
    expect(naFila(MENSAGEM)).toBe(1);
    expect(estado(MENSAGEM)).toBe("pending|0|NULO|NULO");
  });
});

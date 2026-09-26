/**
 * A retenção de mídia EXECUTADA (migration 0432) — `fn_enfileirar_midia_vencida`.
 *
 * O que este arquivo vigia, cada um por um modo de falha concreto:
 *   - arquivo vencido sai e a MENSAGEM fica (texto, horário, status);
 *   - arquivo recente não sai;
 *   - órfão de conversa apagada sai, órfão recente espera a carência de 1 dia;
 *   - avatar em uso e cabeçalho de modelo (`org/templates/`) NUNCA saem;
 *   - a segunda rodada não enfileira de novo (idempotência);
 *   - anon/authenticated não executam a função.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "42700000-0000-4000-8000-000000000001";
const CONTATO = "42700000-0000-4000-8000-000000000002";
const SESSAO = "42700000-0000-4000-8000-000000000003";
const CONVERSA = "42700000-0000-4000-8000-000000000004";
const CONVERSA_APAGADA = "42700000-0000-4000-8000-00000000dead";
const MSG_VELHA = "42700000-0000-4000-8000-000000000010";
const MSG_NOVA = "42700000-0000-4000-8000-000000000011";

const caminho = (resto: string) => `${ORG}/${resto}`;
const VELHO = caminho(`${CONVERSA}/velho.mp4`);
const NOVO = caminho(`${CONVERSA}/novo.jpg`);
const ORFAO = caminho(`${CONVERSA_APAGADA}/video.mp4`);
const ORFAO_RECENTE = caminho(`${CONVERSA_APAGADA}/recente.ogg`);
const AVATAR_EM_USO = caminho("avatars/em-uso.jpg");
const AVATAR_ORFAO = caminho("avatars/orfao.jpg");
const MODELO = caminho("templates/cabecalho.png");

const conta = (q: string) => Number(lastLine(sql(q)));
const naFila = (p: string) =>
  conta(`select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`);

function objeto(nome: string, idadeDias: number): string {
  return `insert into storage.objects (bucket_id, name, metadata, created_at)
          values ('whatsapp-media', '${nome}', '{"size": 1000}'::jsonb, now() - interval '${idadeDias} days');`;
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
      values ('${ORG}', 'org-midia-427', 'Org Midia LTDA', 'Org Midia', 60)
      on conflict (id) do update set media_retention_days = 60;
    insert into contacts (id, organization_id, name, phone_number, avatar_storage_path)
      values ('${CONTATO}', '${ORG}', 'Cliente', '+5511900000427', '${AVATAR_EM_USO}');
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'midia-427', 'WORKING', '\\x00'::bytea);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open', false);
    insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, body, sent_via, sent_at, created_at, media_storage_path)
      values ('${MSG_VELHA}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'video', 'inbound', 'delivered',
              'olha este vídeo', 'external_device', now() - interval '100 days', now() - interval '100 days', '${VELHO}'),
             ('${MSG_NOVA}', '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'image', 'inbound', 'delivered',
              null, 'external_device', now() - interval '10 days', now() - interval '10 days', '${NOVO}');
    ${objeto(VELHO, 100)}
    ${objeto(NOVO, 10)}
    ${objeto(ORFAO, 5)}
    ${objeto(ORFAO_RECENTE, 0)}
    ${objeto(AVATAR_EM_USO, 50)}
    ${objeto(AVATAR_ORFAO, 50)}
    ${objeto(MODELO, 200)}
  `);
});

describe("fn_enfileirar_midia_vencida", () => {
  it("vencido e órfãos entram na fila; o resto fica onde está", () => {
    const r = JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));
    // Controle positivo: sem ele, uma função que não faz nada passaria nos "não saiu".
    expect(r.vencidas).toBeGreaterThanOrEqual(1);

    expect(naFila(VELHO)).toBe(1);
    expect(naFila(ORFAO)).toBe(1);
    expect(naFila(AVATAR_ORFAO)).toBe(1);

    expect(naFila(NOVO)).toBe(0);
    expect(naFila(ORFAO_RECENTE)).toBe(0);
    expect(naFila(AVATAR_EM_USO)).toBe(0);
    expect(naFila(MODELO)).toBe(0);
  });

  it("a mensagem vencida perde só o arquivo — texto e horário ficam", () => {
    sql(`select public.fn_enfileirar_midia_vencida(500)`);
    expect(lastLine(sql(`select coalesce(media_storage_path, 'NULO') || '|' || body from messages where id = '${MSG_VELHA}'`)))
      .toBe("NULO|olha este vídeo");
    expect(lastLine(sql(`select media_storage_path from messages where id = '${MSG_NOVA}'`))).toBe(NOVO);
  });

  it("a segunda rodada não enfileira de novo", () => {
    sql(`select public.fn_enfileirar_midia_vencida(500)`);
    const r = JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));
    expect(r).toEqual({ vencidas: 0, orfas: 0 });
  });

  it("retenção abaixo de 30 dias vale como 30 — o piso do formulário", () => {
    sql(`update organizations set media_retention_days = 1 where id = '${ORG}';`);
    sql(`select public.fn_enfileirar_midia_vencida(500)`);
    expect(naFila(NOVO)).toBe(0); // 10 dias < 30
  });

  it("só o service_role executa", () => {
    for (const papel of ["anon", "authenticated"]) {
      expect(lastLine(sql(`select has_function_privilege('${papel}', 'public.fn_enfileirar_midia_vencida(integer)', 'execute')`)))
        .toBe("f");
    }
  });
});

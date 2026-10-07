/**
 * A limpeza de mídia ganha INTERRUPTOR e MARCA a mensagem como expirada (migration 0557).
 *
 * Desde a 0432 a função apaga a mídia de mensagem de TODA organização. O issue
 * #1534 (PR #2180, @webtecnica) deu à organização o jeito de desligar, e o
 * mantenedor decidiu (doc 92, opção A) que quem já existe CONTINUA ligado:
 *   - o padrão do interruptor é LIGADO, para a existente e para a nova;
 *   - desligada, nada da organização expira — e a vizinha ligada expira
 *     (isolamento por organização);
 *   - o piso de 30 dias vale MESMO com valor menor gravado no banco;
 *   - a mensagem vencida fica com `metadata.media_status = 'expired'` e perde
 *     `media_storage_path` E `media_url` (a rota não busca de novo do provedor);
 *   - pedido LGPD em andamento suspende a expiração da organização;
 *   - reaplicar o apêndice do baseline (o que o `update.sh` faz a cada versão)
 *     não mexe no interruptor de ninguém.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/** UUID válido por organização (dígito `n`) e sufixo (`k`). */
const id = (n: number, k: string) => `4370000${n}-0000-4000-8000-${k.padStart(12, "0")}`;

const DESLIGADA = 1;
const LIGADA = 2;
const PADRAO = 3;
const COM_LGPD = 4;
const REAPLICA_OFF = 5;
const REAPLICA_ON = 6;
const VPS_ANTIGA = 7;

const org = (n: number) => id(n, "1");
const velha = (n: number) => id(n, "d1");
const nova = (n: number) => id(n, "d2");
const caminho = (n: number, nome: string) => `${org(n)}/${id(n, "b2")}/${nome}`;

const naFila = (p: string) =>
  Number(lastLine(sql(`select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = '${p}'`)));
const status = (msg: string) =>
  lastLine(sql(`select coalesce(metadata->>'media_status', '') from messages where id = '${msg}'`));
const ponteirosNulos = (msg: string) =>
  lastLine(sql(`select (media_storage_path is null)::text || '|' || (media_url is null)::text from messages where id = '${msg}'`));
const interruptor = (n: number) =>
  lastLine(sql(`select media_retention_enforced::text from organizations where id = '${org(n)}'`));
const rodar = () => JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));

/**
 * Uma organização com uma mensagem velha (100 dias) e uma nova (5 dias), e
 * retenção gravada em 10 dias — abaixo do piso de 30. `ligada = null` omite a
 * coluna no INSERT, para valer o DEFAULT do banco.
 */
function monta(n: number, ligada: boolean | null): void {
  const o = org(n);
  const [conta, conv, sess] = [id(n, "b1"), id(n, "b2"), id(n, "b3")];
  const pv = caminho(n, "v.jpg");
  const pn = caminho(n, "n.jpg");
  const coluna = ligada === null ? "" : ", media_retention_enforced";
  const valor = ligada === null ? "" : `, ${ligada}`;
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media') on conflict (id) do nothing;
    insert into organizations (id, slug, legal_name, display_name, media_retention_days${coluna})
      values ('${o}', 'org-midia-0557-${n}', 'Org ${n}', 'Org ${n}', 10${valor});
    insert into contacts (id, organization_id, name, phone_number)
      values ('${conta}', '${o}', 'Cliente', '+55119000557${n}');
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${sess}', '${o}', 'midia-0557-${n}', 'WORKING', '\\x00'::bytea);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
      values ('${conv}', '${o}', '${conta}', '${sess}', 'open', false);
    insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, sent_via, sent_at, created_at, media_storage_path, media_url)
      values ('${velha(n)}', '${o}', '${conv}', '${sess}', '${conta}', 'image', 'inbound', 'delivered', 'external_device',
              now() - interval '100 days', now() - interval '100 days', '${pv}', 'https://p.test/${pv}'),
             ('${nova(n)}', '${o}', '${conv}', '${sess}', '${conta}', 'image', 'inbound', 'delivered', 'external_device',
              now() - interval '5 days', now() - interval '5 days', '${pn}', 'https://p.test/${pn}');
    insert into storage.objects (bucket_id, name, metadata, created_at) values
      ('whatsapp-media', '${pv}', '{"size": 100}'::jsonb, now() - interval '100 days'),
      ('whatsapp-media', '${pn}', '{"size": 100}'::jsonb, now() - interval '5 days');
  `);
}

/** O trecho do apêndice da 0557 que roda ANTES da função — o que o `update.sh` reaplica. */
function trechoDoApendice(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf("(migration 0557) ----");
  const fim = baseline.indexOf("create or replace function public.fn_enfileirar_midia_vencida", inicio);
  if (inicio < 0 || fim < 0) throw new Error("INSTRUMENTO: bloco da 0557 não achado no baseline");
  const trecho = baseline.slice(baseline.lastIndexOf("\n", inicio) + 1, fim);
  // Guarda de vacuidade: sem o `alter table`, reaplicar seria executar só comentário.
  if (!trecho.includes("add column if not exists media_retention_enforced")) {
    throw new Error("INSTRUMENTO: o trecho não contém o alter table da 0557");
  }
  return trecho;
}

describe("fn_enfileirar_midia_vencida — interruptor, piso, isolamento, LGPD e marcador (0557)", () => {
  it("o padrão é LIGADO: quem não escolheu nada continua com a limpeza, no piso de 30 dias", () => {
    monta(PADRAO, null);
    expect(interruptor(PADRAO)).toBe("true");

    rodar();
    // 10 dias gravados → piso 30 → a de 100 dias sai, a de 5 fica.
    expect(naFila(caminho(PADRAO, "v.jpg"))).toBe(1);
    expect(naFila(caminho(PADRAO, "n.jpg"))).toBe(0);
    expect(status(velha(PADRAO))).toBe("expired");
    expect(ponteirosNulos(velha(PADRAO))).toBe("true|true");
    expect(lastLine(sql(`select metadata->>'media_retention_days' from messages where id = '${velha(PADRAO)}'`))).toBe("30");
    expect(status(nova(PADRAO))).toBe("");
  });

  it("desligada não expira nada, e a vizinha ligada expira (isolamento)", () => {
    monta(DESLIGADA, false);
    monta(LIGADA, true);

    rodar();
    expect(naFila(caminho(DESLIGADA, "v.jpg"))).toBe(0);
    expect(status(velha(DESLIGADA))).toBe("");
    expect(ponteirosNulos(velha(DESLIGADA))).toBe("false|false");
    expect(naFila(caminho(LIGADA, "v.jpg"))).toBe(1);
    expect(status(velha(LIGADA))).toBe("expired");
  });

  it("pedido LGPD em andamento suspende a expiração; concluído, ela volta", () => {
    monta(COM_LGPD, true);
    const pedido = id(COM_LGPD, "e1");
    sql(`insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
           values ('${pedido}', '${org(COM_LGPD)}', 'data_request', 'manual', 'tenant', now() + interval '7 days');`);

    rodar();
    expect(naFila(caminho(COM_LGPD, "v.jpg"))).toBe(0);
    expect(status(velha(COM_LGPD))).toBe("");

    sql(`update lgpd_requests set status = 'completed', completed_at = now() where id = '${pedido}';`);
    rodar();
    expect(naFila(caminho(COM_LGPD, "v.jpg"))).toBe(1);
    expect(status(velha(COM_LGPD))).toBe("expired");
  });

  it("reaplicar o apêndice (o update.sh) duas vezes não mexe no interruptor de ninguém", () => {
    monta(REAPLICA_OFF, false);
    monta(REAPLICA_ON, true);
    const trecho = trechoDoApendice();

    sql(trecho);
    sql(trecho);
    expect(interruptor(REAPLICA_OFF)).toBe("false");
    expect(interruptor(REAPLICA_ON)).toBe("true");
  });

  it("na atualização de uma VPS sem a coluna, a organização que já existia fica LIGADA", () => {
    monta(VPS_ANTIGA, null);
    // Uma transação só: a coluna some e volta pelo apêndice sem nenhuma outra
    // sessão enxergar o meio-termo. É o banco de quem está na 1.53.0 e roda o
    // `update.sh`: a organização existe, a coluna ainda não.
    const depois = lastLine(
      sql(`
        begin;
        alter table public.organizations drop column media_retention_enforced;
        ${trechoDoApendice()}
        select media_retention_enforced::text from organizations where id = '${org(VPS_ANTIGA)}';
        commit;
      `)
        .split("\n")
        .filter((l) => l === "true" || l === "false")
        .join("\n"),
    );
    expect(depois).toBe("true");
  });
});

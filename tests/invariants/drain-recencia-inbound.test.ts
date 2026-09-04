import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";

import { GOV_ORG, GOV_SESSION, GOV_CONV_UNASSIGNED, GOV_CONTACT_1, seedGov, sql } from "./gov-helpers";

/**
 * R7 — o anti-backlog do drain (`lib/agent-engine/edge/crm/drain.ts`) elege "a
 * última inbound da conversa" para decidir se um evento foi SUPERADO. A consulta
 * era `order by sent_at desc nulls last, id desc` — e o `id` é uuid aleatório.
 * Dois inbound com o MESMO `sent_at` (relógio do provider repetido) faziam a
 * escolha da última cair no sorteio do uuid: metade das vezes elegia a ANTIGA e
 * o drain deixava passar um evento que devia ter sido pulado — a IA respondendo
 * mensagem velha.
 *
 * A correção usa `coalesce(sent_at, created_at) desc, created_at desc, id desc`
 * (padrão do repo — migration 0027). `created_at` é a ordem de INGESTÃO (uma
 * mensagem por webhook), então empate de `sent_at` desempata determinístico.
 *
 * Este invariante roda a MESMA cláusula contra Postgres real, com duas linhas de
 * `sent_at` idêntico, e prova que a de `created_at` mais novo vence — para
 * qualquer par de uuids.
 */

const CV = GOV_CONV_UNASSIGNED;
const CT = GOV_CONTACT_1;

// `id` fixos escolhidos para que ORDER BY `id desc` sozinho elegeria a ANTIGA
// (a1... < f9..., então 'f9' desc viria primeiro — e é a mensagem antiga).
const MSG_ANTIGA = "aaaaaaaa-0000-4000-8000-0000000000f9";
const MSG_NOVA = "aaaaaaaa-0000-4000-8000-0000000000a1";

/** Cláusula EXATA do drain.ts (mantida em sincronia à mão — a cerca é o ponto). */
const ORDER_BY = "order by coalesce(sent_at, created_at) desc, created_at desc, id desc";

function ultimaInbound(): string {
  return sql(`select id from public.messages
     where organization_id = '${GOV_ORG}' and conversation_id = '${CV}' and direction = 'inbound'
     ${ORDER_BY}
     limit 1;`).trim();
}

beforeAll(() => {
  seedGov();
  sql(`delete from public.messages where conversation_id = '${CV}';`);
  // Mesmo sent_at nos dois; created_at 10 min mais novo na "NOVA".
  sql(`insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, body, sent_at, created_at)
       values
        ('${MSG_ANTIGA}', '${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${CT}',
         'text', 'inbound', 'received', 'ai', 'primeira', timestamptz '2026-08-27 10:00:00Z', timestamptz '2026-08-27 10:00:00Z'),
        ('${MSG_NOVA}', '${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${CT}',
         'text', 'inbound', 'received', 'ai', 'segunda',  timestamptz '2026-08-27 10:00:00Z', timestamptz '2026-08-27 10:10:00Z');`);
});

describe("R7 · anti-backlog: a última inbound é a mais RECENTE, não a de maior uuid", () => {
  it("sent_at empatado → vence quem tem created_at mais novo", () => {
    expect(ultimaInbound()).toBe(MSG_NOVA);
  });

  it("a cláusula NÃO é a antiga (`nulls last` + `id desc` sozinho)", () => {
    expect(ORDER_BY).not.toContain("nulls last");
    // Sanidade: ORDER BY só `id desc` elegeria a ANTIGA — prova que o teste morde.
    const soPorId = sql(`select id from public.messages
       where organization_id = '${GOV_ORG}' and conversation_id = '${CV}' and direction = 'inbound'
       order by id desc limit 1;`).trim();
    expect(soPorId).toBe(MSG_ANTIGA);
  });

  it("drain.ts usa exatamente esta cláusula (guarda contra drift do inline SQL)", () => {
    const fonte = readFileSync(
      resolve(__dirname, "../../lib/agent-engine/edge/crm/drain.ts"),
      "utf-8",
    );
    expect(fonte).toContain(ORDER_BY);
    expect(fonte).not.toContain("order by sent_at desc nulls last");
  });
});

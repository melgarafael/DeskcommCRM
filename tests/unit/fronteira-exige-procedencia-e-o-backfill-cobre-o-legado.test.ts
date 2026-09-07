import { describe, expect, it, vi } from "vitest";

import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";
import { createSupabaseAdminClient } from "@/lib/followup/engine";

/**
 * AUSÊNCIA DE CARIMBO É RECUSA, E QUEM CUIDA DO LEGADO É O BACKFILL.
 *
 * Este arquivo já afirmou o contrário. A versão anterior guardava um CINTO —
 * sem carimbo, medir silêncio por `last_inbound_at`; sem fronteira, seguir o
 * acompanhamento — escrito para "o clone que aplicou a 0222 sem o backfill".
 * Medido depois, essa população é VAZIA: a 0222 não é ancestral de `origin/main`
 * e nenhuma tag a contém, e o backfill vive no apêndice idempotente do
 * `baseline.sql`, então o `update.sh` seguinte o executa — a janela teórica se
 * cura sozinha.
 *
 * O cinto, esse, não era de graça. Em banco JÁ backfilled ele abria dois
 * caminhos que nunca deveriam existir, os dois porque a falta de carimbo ali é
 * NORMAL e recorrente, não legado:
 *
 *   · conversa de GRUPO — `fn_service_inbound` retorna cedo e nunca carimba
 *     mensagem de grupo, e a consulta da varredura não filtra `is_group`. O
 *     cinto inscrevia o contato de um grupo em follow-up automático.
 *   · mensagem entregue FORA DE ORDEM depois de um fechamento — `fn_service_inbound`
 *     também retorna cedo (`m.sent_at <= c.service_closed_at`), e ela fica sem
 *     carimbo para sempre; na reabertura, passava a valer.
 *
 * E a guarda que o cinto alegava manter não existia: uma fronteira remontada da
 * LINHA CORRENTE é comparada contra a própria linha corrente, então
 * `assertCurrentServiceBoundary` não pode reprovar nunca. Foi essa frase, no
 * comentário, que impediu a brecha de ser vista.
 *
 * Estes casos guardam a decisão corrigida: procedência é EXIGIDA nos dois
 * consumidores, e o legado é problema do backfill — que agora reclama alto
 * quando não termina (migration 0222, passo 4).
 */

function supabaseComConversas(data: unknown[]) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown) => resolve({ data, error: null });
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

const metadata = { ai_gate: "open" };

function conversaLegada(contactId: string, comCarimbo: boolean) {
  const conversationId = `conversation-${contactId}`;
  return {
    id: conversationId,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contactId,
    last_inbound_at: "2026-09-01T10:00:00.000Z",
    messages: comCarimbo
      ? [
          {
            organization_id: "org",
            contact_id: contactId,
            conversation_id: conversationId,
            service_revision: 1,
            demanda_id: null,
            demanda_revision: null,
            sent_at: "2026-09-01T10:00:00.000Z",
          },
        ]
      : [],
    contacts: {
      tags: [],
      is_blocked: false,
      ai_authorized_at: null,
      phone_number: "+5585999990000",
    },
    sessao: { metadata },
  };
}

describe("fronteira exige procedência; o legado é do backfill", () => {
  it("varredura de silêncio NÃO enxerga a conversa sem carimbo — grupo e entrega fora de ordem moram aqui", async () => {
    const db = createSupabaseSilenceSweepDb(
      supabaseComConversas([conversaLegada("c-sem-carimbo", false)]),
    );
    const ids = await db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []);
    expect(ids).toEqual([]);
  });

  it("varredura de silêncio continua enxergando a conversa COM carimbo", async () => {
    const db = createSupabaseSilenceSweepDb(supabaseComConversas([conversaLegada("c-novo", true)]));
    const ids = await db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []);
    expect(ids).toEqual(["c-novo"]);
  });

  it("acompanhamento SEM fronteira é recusado — todo caminho de criação carimba", async () => {
    // Nenhum caminho cria acompanhamento sem fronteira: `lib/followup/enroll.ts`
    // grava `service_boundary: boundary`, e os dois INSERTs em SQL
    // (`fn_appointment_recover`) passam `boundary` no `values`. Nulo aqui só
    // pode ser linha pré-0222 — que o backfill carimba. Seguir em frente seria
    // rodar acompanhamento sem conferir contra qual atendimento ele é.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = createSupabaseAdminClient({ rpc } as never);
    await expect(
      db.assertServiceBoundary!({
        id: "enr-sem-fronteira",
        organization_id: "org",
        contact_id: "c-sem-fronteira",
        service_boundary: null,
      } as never),
    ).rejects.toThrow("service_boundary_stale");
  });

  it("acompanhamento COM fronteira continua sendo conferido contra o banco", async () => {
    // `fn_service_boundary` devolvendo nada = conversa que não existe mais.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = createSupabaseAdminClient({ rpc } as never);
    await expect(
      db.assertServiceBoundary!({
        id: "enr-novo",
        organization_id: "org",
        contact_id: "c-novo",
        service_boundary: {
          organization_id: "org",
          contact_id: "c-novo",
          conversation_id: "conv-1",
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
      } as never),
    ).rejects.toThrow("service_boundary_stale");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

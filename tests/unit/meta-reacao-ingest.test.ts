import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A INGESTÃO DA REAÇÃO do canal oficial (#2797, fatias 1 e 2).
 *
 * O evento chega pronto do normalizador (`tests/unit/meta-reacao.test.ts`);
 * aqui se prova o que a ingestão FAZ com ele: grava a linha `type='reaction'`
 * ligada à mensagem alvo, apaga a anterior do mesmo autor quando o emoji vem
 * vazio, descarta quando não há alvo — e, sob tudo isso, NÃO carimba a
 * conversa: sem `fn_mark_conversation_message` não há `last_message_at`,
 * janela de 24h, prévia nem contador de não lidas.
 */

const rastros = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Array<[string, unknown]>>,
  avisos: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (mensagem: string, detalhes?: unknown) => rastros.avisos.push([mensagem, detalhes]),
    error: () => {},
    info: () => {},
    debug: () => {},
  },
}));

import { ingestMetaReaction } from "@/lib/channels/meta/ingest";
import type { ReactionEvent } from "@/lib/channels/meta/webhook";

const ALVO_ID = "pre-alvo";

interface Linha {
  id: string;
  organization_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  external_id: string | null;
  type?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function porCaminho(linha: Record<string, unknown>, caminho: string): unknown {
  let atual: unknown = linha;
  for (const pedaco of caminho.split("->")) {
    if (typeof atual !== "object" || atual === null) return undefined;
    atual = (atual as Record<string, unknown>)[pedaco.replace(/^>/, "")];
  }
  return atual;
}

/**
 * O ALVO, na grafia da Cloud API: a mensagem que foi reagida, já gravada pelo
 * caminho normal. `adminFalso` recebe as linhas PRÉ-EXISTENTES — o alvo quase
 * sempre vem junto de uma reação antiga, porque é sobre ela que a remoção
 * trabalha (regra do canal: apagar SÓ a do mesmo autor).
 */
const ALVO: Partial<Linha> = { id: ALVO_ID, external_id: "wamid.ALVO" };

function adminFalso(linhas: Array<Partial<Linha>>): SupabaseClient {
  const messages: Linha[] = linhas.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    conversation_id: "conversa-1",
    contact_id: "contato-1",
    external_id: null,
    ...m,
  }));

  /**
   * Uma cadeia de filtros POR OPERAÇÃO: se o SELECT do alvo e o DELETE da
   * remoção dividissem o mesmo estado, o filtro do alvo (`external_id in
   * [...]`) contaminaria o apagão e ele casaria ZERO linhas — o teste apontaria
   * o código em vez do dublê.
   */
  const cadeiaDeFiltros = () => {
    const filtros: Array<[string, unknown]> = [];
    const casam = () =>
      messages.filter((m) =>
        filtros.every(([c, v]) => {
          const valor = porCaminho(m as Record<string, unknown>, c);
          return Array.isArray(v) ? v.includes(valor) : (valor ?? null) === v;
        }),
      );
    const q = {
      casam,
      filtros,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push([coluna, valores]);
        return q;
      },
      like: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: casam()[0] ?? null, error: null }),
    };
    return q;
  };

  const consulta = () => cadeiaDeFiltros();

  const from = (tabela: string) => {
    if (tabela === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: { id: "sessao-1", organization_id: "org-1" }, error: null }),
      };
      return chain;
    }
    if (tabela === "messages") {
      return {
        select: () => consulta(),
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            async maybeSingle() {
              const externo = linha.external_id as string | null;
              const colide =
                externo !== null &&
                messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo);
              if (colide) {
                return {
                  data: null,
                  error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' },
                };
              }
              rastros.inserts.push(linha);
              const nova = { id: "reacao-1", ...linha } as Linha;
              messages.push(nova);
              return { data: { id: nova.id }, error: null };
            },
          }),
        }),
        // `await ....delete().eq(...)` sem `.select()` (é assim que a remoção
        // roda): o dublê executa no `then`, quando os filtros já estão todos
        // empilhados — e é ali que o rastro vai para o teste ler.
        delete: () => {
          const cadeia = cadeiaDeFiltros();
          const encadeavel = {
            eq(coluna: string, valor: unknown) {
              cadeia.eq(coluna, valor);
              return encadeavel;
            },
            then(ok: (v: unknown) => unknown) {
              rastros.deletes.push([...cadeia.filtros]);
              const alvos = cadeia.casam();
              for (const linha of alvos) messages.splice(messages.indexOf(linha), 1);
              return Promise.resolve(ok({ data: alvos.map((l) => ({ id: l.id })), error: null }));
            },
          };
          return encadeavel;
        },
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  };

  return {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rastros.rpcs.push({ name, args });
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const EVENTO: ReactionEvent = {
  kind: "reaction",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  externalId: "wamid.REACAO",
  from: "5511999999999",
  emoji: "👍",
  targetExternalId: "wamid.ALVO",
  sentAt: new Date("2026-10-01T12:00:00.000Z"),
};

beforeEach(() => {
  rastros.rpcs.length = 0;
  rastros.inserts.length = 0;
  rastros.deletes.length = 0;
  rastros.avisos.length = 0;
});

describe("a reação do canal oficial vira linha ligada ao alvo (#2797)", () => {
  it("grava type='reaction' com o ponteiro, o emoji e o autor em metadata", async () => {
    const outcome = await ingestMetaReaction(adminFalso([ALVO]), EVENTO, { organizationId: "org-1" });

    expect(outcome).toMatchObject({ status: "ingested" });
    expect(rastros.inserts).toHaveLength(1);
    expect(rastros.inserts[0]).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conversa-1",
      contact_id: "contato-1",
      type: "reaction",
      direction: "inbound",
      external_id: "wamid.REACAO",
      reply_to_message_id: ALVO_ID,
      metadata: {
        reaction: { emoji: "👍", target_external_id: "wamid.ALVO", author: "5511999999999" },
      },
    });
  });

  it("NÃO carimba a conversa: sem fn_mark_conversation_message e sem pós-entrada", async () => {
    await ingestMetaReaction(adminFalso([ALVO]), EVENTO, { organizationId: "org-1" });

    expect(rastros.rpcs.filter((r) => r.name === "fn_mark_conversation_message")).toEqual([]);
  });

  it("alvo fora do CRM: descartada, sem linha nenhuma e com o motivo no desfecho", async () => {
    const outcome = await ingestMetaReaction(adminFalso([]), EVENTO, { organizationId: "org-1" });

    expect(outcome).toMatchObject({ status: "ignored", reason: "reacao_sem_alvo" });
    expect(rastros.inserts).toEqual([]);
    expect(rastros.avisos.length, "o descarte não deixou rastro no log").toBeGreaterThan(0);
  });

  it("emoji vazio (reação removida): apaga a anterior do MESMO autor e não insere", async () => {
    // O banco tem DUAS linhas: o alvo (que dá o ponteiro) e a reação antiga
    // que a remoção vai apagar — só ela tem `type: "reaction"`.
    const admin = adminFalso([
      ALVO,
      {
        id: "reacao-antiga",
        type: "reaction",
        external_id: "wamid.REACAO_ANTIGA",
        reply_to_message_id: ALVO_ID,
        metadata: { reaction: { emoji: "👍", target_external_id: "wamid.ALVO", author: "5511999999999" } },
      },
    ]);

    const outcome = await ingestMetaReaction(admin, { ...EVENTO, emoji: null, externalId: "wamid.REMOCAO" }, {
      organizationId: "org-1",
    });

    expect(outcome).toMatchObject({ status: "ingested" });
    expect(rastros.inserts, "a remoção virou linha nova").toEqual([]);
    expect(rastros.deletes, "a reação anterior não foi apagada").toHaveLength(1);
    // O apagão é restrito: organização, tipo reação, MESMO alvo e MESMO autor.
    expect(rastros.deletes[0]).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["type", "reaction"],
        ["reply_to_message_id", ALVO_ID],
        ["metadata->reaction->>author", "5511999999999"],
      ]),
    );
  });

  it("reentrega da Meta: a mesma reação não vira duas linhas", async () => {
    const admin = adminFalso([ALVO]);

    const primeira = await ingestMetaReaction(admin, EVENTO, { organizationId: "org-1" });
    const segunda = await ingestMetaReaction(admin, EVENTO, { organizationId: "org-1" });

    expect(primeira).toMatchObject({ status: "ingested" });
    expect(segunda).toMatchObject({ status: "duplicate" });
    expect(rastros.inserts).toHaveLength(1);
  });
});

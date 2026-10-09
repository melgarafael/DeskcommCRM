/**
 * QUEM APLICA A REGRA NO BANCO (issue #2389) — e as três pontas do laço.
 *
 * O que este arquivo cobre além da regra pura:
 *
 *  1. pausar ABRE um item `canal_pausado` apontando para o canal;
 *  2. pausar de novo com o item aberto ATUALIZA — e não insere um segundo
 *     (um canal pausado = um item);
 *  3. retomar RESOLVE o mesmo item, sem clique, com `reativado` no corpo;
 *  4. a linha do canal JÁ NÃO EXISTIR (exclusão) com o item aberto resolve com
 *     `canal_arquivado` — o caso do #1023, em que o emissor some;
 *  5. falha de leitura devolve `falhou` e NUNCA lança: esta chamada é lateral a
 *     uma operação que o operador já pediu.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { KIND_CANAL_PAUSADO } from "./canal-pausado";
import { fecharAvisoDePausaDoCanalArquivado, sincronizarAvisoDePausa } from "./central-de-pausa";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-07T15:42:00.000Z");
const CONTEXTO = { autor: "Ana Silva", agora: AGORA };

interface Item {
  id: string;
  organization_id: string;
  kind: string;
  status: string;
  severity?: string;
  title?: string;
  body: string | null;
  ref_kind?: string;
  ref_id?: string | null;
}

/**
 * Um Supabase falso, só com o que o módulo usa.
 *
 * O builder é PromiseLike, como o de verdade: `await ...update().eq().eq()`
 * executa na hora. É isso que deixa o teste determinístico sem rede.
 */
function banco(estado: {
  linha: Record<string, unknown> | null;
  itens: Item[];
  erroLeitura?: boolean;
  erroInsert?: { code: string; message: string };
}) {
  let proximo = 1;
  const cliente = {
    from(tabela: string) {
      if (tabela === "channel_sessions") {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () =>
            estado.erroLeitura
              ? { data: null, error: { message: "leitura quebrou" } }
              : { data: estado.linha, error: null },
        };
        return c;
      }
      return itens(estado.itens, () => String(proximo++), estado.erroInsert);
    },
  };
  return cliente as unknown as SupabaseClient;
}

function itens(alvo: Item[], id: () => string, erroInsert?: { code: string; message: string }) {
  let acao: "select" | "insert" | "update" = "select";
  let payload: Record<string, unknown> = {};
  const filtros: Array<[string, unknown]> = [];

  const casando = () =>
    alvo.filter((linha) =>
      filtros.every(([c, v]) => (linha as unknown as Record<string, unknown>)[c] === v),
    );

  const executar = async (): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => {
    if (acao === "select") return { data: casando()[0] ?? null, error: null };
    if (acao === "insert") {
      if (erroInsert) return { data: null, error: erroInsert };
      alvo.push({ id: `aviso-${id()}`, status: "open", body: null, ...payload } as Item);
      return { data: null, error: null };
    }
    const alvos = casando();
    for (const linha of alvos) Object.assign(linha, payload);
    return { data: alvos[0] ? { id: alvos[0].id } : null, error: null };
  };

  const c: Record<string, unknown> = {
    select: () => c,
    insert: (p: Record<string, unknown>) => {
      acao = "insert";
      payload = p;
      return c;
    },
    update: (p: Record<string, unknown>) => {
      acao = "update";
      payload = p;
      return c;
    },
    eq: (col: string, val: unknown) => {
      filtros.push([col, val]);
      return c;
    },
    limit: () => c,
    maybeSingle: () => executar().then((r) => ({ data: r.data, error: r.error })),
    then: (ok?: unknown, falhou?: unknown) => executar().then(ok as never, falhou as never),
  };
  return c;
}

const linhaDoCanal = (over: Record<string, unknown> = {}) => ({
  id: CANAL,
  organization_id: ORG,
  display_name: "Loja Centro",
  phone_number: "+5511999990000",
  archived_at: null,
  metadata: { disabled: true },
  ...over,
});

const itemAberto = (over: Partial<Item> = {}): Item => ({
  id: "aviso-1",
  organization_id: ORG,
  kind: KIND_CANAL_PAUSADO,
  ref_kind: "channel_session",
  ref_id: CANAL,
  status: "open",
  body: "«Loja Centro» está pausado desde 07/10/26, 12:42 — quem pausou foi Ana Silva.",
  ...over,
});

describe("sincronizarAvisoDePausa", () => {
  it("pausar ABRE um item canônico apontando para o canal", async () => {
    const itens: Item[] = [];
    const db = banco({ linha: linhaDoCanal(), itens });

    const desfecho = await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO);

    expect(desfecho).toBe("aberto");
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({
      organization_id: ORG,
      kind: KIND_CANAL_PAUSADO,
      severity: "warn",
      status: "open",
      ref_kind: "channel_session",
      ref_id: CANAL,
    });
    expect(itens[0]!.body).toContain("Loja Centro");
    expect(itens[0]!.body).toContain("Ana Silva");
  });

  it("re-pausar com o item aberto NÃO abre um segundo", async () => {
    const itens = [itemAberto()];
    const db = banco({ linha: linhaDoCanal(), itens });

    const desfecho = await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO);

    expect(desfecho).toBe("atualizado");
    expect(itens).toHaveLength(1);
    expect(itens[0]!.status).toBe("open");
    expect(itens[0]!.body).toContain("Ana Silva");
  });

  it("retomar RESOLVE o item sem clique, com motivo `reativado` visível", async () => {
    const itens = [itemAberto()];
    const db = banco({ linha: linhaDoCanal({ metadata: {} }), itens });

    const desfecho = await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO);

    expect(desfecho).toBe("resolvido");
    expect(itens).toHaveLength(1);
    expect(itens[0]!.status).toBe("resolved");
    expect(itens[0]!.body).toContain("Resolvido pelo sistema: o canal foi reativado.");
    // O histórico do item (quem pausou, quando) continua legível.
    expect(itens[0]!.body).toContain("quem pausou foi Ana Silva");
  });

  it("retomar sem item aberto é `sem_mudanca` — não nasce aviso do nada", async () => {
    const db = banco({ linha: linhaDoCanal({ metadata: {} }), itens: [] });
    expect(await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO)).toBe(
      "sem_mudanca",
    );
  });

  it("linha do canal EXCLUÍDA com o item aberto resolve com `canal_arquivado`", async () => {
    const itens = [itemAberto()];
    const db = banco({ linha: null, itens });

    const desfecho = await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO);

    expect(desfecho).toBe("resolvido");
    expect(itens[0]!.status).toBe("resolved");
    expect(itens[0]!.body).toContain("Resolvido pelo sistema: o canal foi arquivado.");
  });

  it("canal pausado e depois ARQUIVADO fora de Conexões resolve com `canal_arquivado`", async () => {
    // Redes Sociais e voz arquivam a linha e chamam o fechador sem autor.
    const itens = [itemAberto()];
    const db = banco({ linha: linhaDoCanal({ archived_at: AGORA.toISOString() }), itens });

    expect(await fecharAvisoDePausaDoCanalArquivado(db, { id: CANAL, organization_id: ORG })).toBe(
      "resolvido",
    );
    expect(itens[0]!.status).toBe("resolved");
    expect(itens[0]!.body).toContain("Resolvido pelo sistema: o canal foi arquivado.");
  });

  it("linha ausente e sem item não faz nada", async () => {
    const db = banco({ linha: null, itens: [] });
    expect(await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO)).toBe(
      "sem_mudanca",
    );
  });

  it("INSERT que perde a corrida (23505 do índice único) é `sem_mudanca`, não `falhou`", async () => {
    // Duas pausas simultâneas leram "nenhum aberto"; a outra inseriu primeiro.
    const db = banco({ linha: linhaDoCanal(), itens: [], erroInsert: { code: "23505", message: "duplicate key" } });
    expect(await sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO)).toBe(
      "sem_mudanca",
    );
  });

  it("erro de leitura devolve `falhou` e NUNCA lança", async () => {
    const db = banco({ linha: null, itens: [], erroLeitura: true });
    await expect(
      sincronizarAvisoDePausa(db, { id: CANAL, organization_id: ORG }, CONTEXTO),
    ).resolves.toBe("falhou");
  });
});

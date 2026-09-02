/**
 * A REGRA do cron `prune-old-media` (regra de negócio B-03).
 *
 * `organizations.media_retention_days` existia desde a migration original e
 * nunca teve leitor — achado ao comparar com o changelog do upstream
 * (DeskcommCRM 1.4.0: "limpeza automática do banco... mídia depois de um
 * período"). Sem cron nenhum, mídia se acumula para sempre no bucket
 * `whatsapp-media`, risco real de estourar a cota de 1 GB do Supabase free
 * tier.
 *
 * O que se guarda aqui, com um dublê do client:
 *   1. o corte é POR ORGANIZAÇÃO, usando `media_retention_days` de cada uma
 *      — não um valor fixo global;
 *   2. só mensagens com `media_storage_path` preenchido entram na varredura
 *      (mensagem de texto não tem o que podar);
 *   3. o objeto vai para `storage_redaction_queue` (a mesma fila que a
 *      cascata de LGPD usa) — este cron nunca chama `storage.remove()`
 *      diretamente, quem remove de verdade é o `storage-redaction` já
 *      agendado, com retry;
 *   4. as 4 colunas de mídia da mensagem são zeradas NO MESMO passo que
 *      enfileira a remoção — nunca ficam apontando para um blob que já foi
 *      mandado apagar;
 *   5. o `insert`/`upsert` na fila usa `ignoreDuplicates` (equivalente a
 *      `on conflict (bucket, object_path) do nothing`) — enfileirar duas
 *      vezes o mesmo objeto não pode estourar a constraint UNIQUE.
 */
import { describe, expect, it } from "vitest";

import { pruneOldMedia } from "@/app/api/v1/cron/prune-old-media/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
  valores?: unknown;
  opts?: unknown;
}

function clientDuble(orgs: { id: string; media_retention_days: number }[], mensagensPorOrg: Record<string, { id: string; media_storage_path: string }[]>) {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let op = "select";
      let valores: unknown;
      let opts: unknown;
      let orgPedida: string | undefined;
      const cadeia: Record<string, unknown> = {
        select() {
          return cadeia;
        },
        update(v: unknown) {
          op = "update";
          valores = v;
          return cadeia;
        },
        upsert(v: unknown, o: unknown) {
          op = "upsert";
          valores = v;
          opts = o;
          return {
            then(resolve: (r: unknown) => unknown) {
              chamadas.push({ tabela, op, filtros, valores, opts });
              return Promise.resolve(resolve({ data: null, error: null }));
            },
          };
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          if (col === "organization_id") orgPedida = val as string;
          return cadeia;
        },
        not(col: string, op2: string, val: unknown) {
          filtros[`not:${col}:${op2}`] = val;
          return cadeia;
        },
        lt(col: string, val: unknown) {
          filtros[`lt:${col}`] = val;
          return cadeia;
        },
        in(col: string, val: unknown) {
          filtros[`in:${col}`] = val;
          return {
            then(resolve: (r: unknown) => unknown) {
              chamadas.push({ tabela, op, filtros, valores });
              return Promise.resolve(resolve({ data: null, error: null }));
            },
          };
        },
        limit() {
          chamadas.push({ tabela, op, filtros });
          const dados = tabela === "organizations" ? orgs : (mensagensPorOrg[orgPedida ?? ""] ?? []);
          return Promise.resolve({ data: dados, error: null });
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

describe("prune-old-media — a regra", () => {
  it("sem organizações: nada é enfileirado, resultado é zero", async () => {
    const { client, chamadas } = clientDuble([], {});

    const result = await pruneOldMedia(client as never, new Date("2026-08-30T12:00:00Z"));

    expect(result).toEqual({ organizations_scanned: 0, messages_pruned: 0 });
    expect(chamadas.some((c) => c.tabela === "storage_redaction_queue")).toBe(false);
  });

  it("o corte usa media_retention_days DA ORGANIZAÇÃO, não um valor fixo", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const { client, chamadas } = clientDuble(
      [
        { id: "org-30d", media_retention_days: 30 },
        { id: "org-365d", media_retention_days: 365 },
      ],
      { "org-30d": [], "org-365d": [] },
    );

    await pruneOldMedia(client as never, now);

    const corte30 = chamadas.find((c) => c.tabela === "messages" && c.filtros["eq:organization_id"] === "org-30d")!;
    const corte365 = chamadas.find((c) => c.tabela === "messages" && c.filtros["eq:organization_id"] === "org-365d")!;

    expect(corte30.filtros["lt:created_at"]).toBe(
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(corte365.filtros["lt:created_at"]).toBe(
      new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("só mensagens com media_storage_path preenchido entram na varredura", async () => {
    const { client, chamadas } = clientDuble([{ id: "org-1", media_retention_days: 30 }], { "org-1": [] });

    await pruneOldMedia(client as never, new Date("2026-08-30T12:00:00Z"));

    const call = chamadas.find((c) => c.tabela === "messages" && c.op === "select")!;
    expect(call.filtros["not:media_storage_path:is"]).toBe(null);
  });

  it("mídia encontrada: vai para storage_redaction_queue com ignoreDuplicates, e as colunas somem", async () => {
    const { client, chamadas } = clientDuble([{ id: "org-1", media_retention_days: 30 }], {
      "org-1": [
        { id: "m1", media_storage_path: "org-1/abc.jpg" },
        { id: "m2", media_storage_path: "org-1/def.mp3" },
      ],
    });

    const result = await pruneOldMedia(client as never, new Date("2026-08-30T12:00:00Z"));

    expect(result).toEqual({ organizations_scanned: 1, messages_pruned: 2 });

    const enfileirado = chamadas.find((c) => c.tabela === "storage_redaction_queue" && c.op === "upsert")!;
    expect(enfileirado.opts).toMatchObject({ onConflict: "bucket,object_path", ignoreDuplicates: true });
    expect(enfileirado.valores).toEqual([
      { organization_id: "org-1", bucket: "whatsapp-media", object_path: "org-1/abc.jpg" },
      { organization_id: "org-1", bucket: "whatsapp-media", object_path: "org-1/def.mp3" },
    ]);

    const atualizado = chamadas.find((c) => c.tabela === "messages" && c.op === "update")!;
    expect(atualizado.valores).toEqual({
      media_url: null,
      media_storage_path: null,
      media_mime: null,
      media_size_bytes: null,
    });
  });

  it("nunca chama storage.remove() diretamente — quem apaga é o storage-redaction já agendado", async () => {
    const { client, chamadas } = clientDuble([{ id: "org-1", media_retention_days: 30 }], {
      "org-1": [{ id: "m1", media_storage_path: "org-1/abc.jpg" }],
    });
    // O dublê nem MODELA `.storage` — se o código chamasse admin.storage.from(...),
    // estouraria "is not a function" e o teste falharia por essa razão certa.
    await pruneOldMedia(client as never, new Date("2026-08-30T12:00:00Z"));

    expect(chamadas.every((c) => c.tabela !== "storage")).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Foto de perfil na cascata de anonimização (migration 0099).
 *
 * O que se prova aqui é o que é do APP: quais operações acontecem, em que ORDEM,
 * e que o objeto de fato sai do bucket ao fim do fluxo. O que é do BANCO (a RPC
 * real, a constraint que sustenta a idempotência, o escopo que o cron enxerga)
 * está em `tests/invariants/lgpd-avatar-anonimizacao.test.ts`, contra um Postgres
 * de verdade — de propósito, porque este repo já perdeu uma cascata de redação
 * inteira por um teste que mockava o RPC e conferia a própria mentira.
 *
 * O client é falsificado, mas o código sob teste não: `cascadeRedactContact` e
 * `drainStorageRedactionQueue` rodam de verdade. O fake registra a sequência de
 * operações justamente porque a ORDEM é a propriedade em disputa.
 */

/** Sequência de operações, na ordem em que o código as aguarda. */
const ops: string[] = [];
const inserts: {
  tabela: string;
  payload: Record<string, unknown>;
  opcoes?: Record<string, unknown>;
}[] = [];
const updates: { tabela: string; patch: Record<string, unknown> }[] = [];
const removes: { bucket: string; caminhos: string[] }[] = [];

let contatoRow: { avatar_storage_path: string | null } | null = null;
let filaPendente: Record<string, unknown>[] = [];
let erroDoRemove: { message: string } | null = null;
let erroDoInsert: { code?: string; message: string } | null = null;

const rpcMock = vi.fn();

/**
 * Imita o query builder do PostgREST: encadeável e awaitable. O resolver só roda
 * no `await`, então `ops` reflete a ordem real de execução, não a de escrita.
 */
function chain(resolver: () => Promise<unknown>): Record<string, unknown> {
  const alvo = {};
  const proxy: Record<string, unknown> = new Proxy(alvo, {
    get(_t, prop) {
      if (prop === "then") {
        return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
          resolver().then(ok, falha);
      }
      if (prop === "maybeSingle" || prop === "single") return () => resolver();
      return () => proxy;
    },
  }) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () =>
        chain(async () => {
          ops.push(`select:${tabela}`);
          return tabela === "contacts"
            ? { data: contatoRow, error: null }
            : { data: filaPendente, error: null };
        }),
      insert: (payload: Record<string, unknown>) =>
        chain(async () => {
          ops.push(`insert:${tabela}`);
          inserts.push({ tabela, payload });
          return { error: erroDoInsert };
        }),
      upsert: (payload: Record<string, unknown>, opcoes?: Record<string, unknown>) =>
        chain(async () => {
          ops.push(`insert:${tabela}`);
          inserts.push({ tabela, payload, opcoes });
          return { error: erroDoInsert };
        }),
      delete: () =>
        chain(async () => {
          ops.push(`delete:${tabela}`);
          return { error: null };
        }),
      update: (patch: Record<string, unknown>) =>
        chain(async () => {
          ops.push(`update:${tabela}`);
          updates.push({ tabela, patch });
          return { error: null };
        }),
    }),
    storage: {
      from: (bucket: string) => ({
        remove: async (caminhos: string[]) => {
          ops.push(`storage.remove:${bucket}`);
          removes.push({ bucket, caminhos });
          return { error: erroDoRemove };
        },
      }),
    },
    rpc: (...args: unknown[]) => {
      ops.push("rpc");
      return rpcMock(...args);
    },
  }),
}));

import { cascadeRedactContact } from "@/lib/lgpd/redact-cascade";
import { drainStorageRedactionQueue } from "@/lib/lgpd/storage-redaction-queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const PEDIDO = "33333333-3333-4333-8333-333333333333";
const CAMINHO = `${ORG}/avatars/${CONTATO}.jpg`;

beforeEach(() => {
  ops.length = 0;
  inserts.length = 0;
  updates.length = 0;
  removes.length = 0;
  filaPendente = [];
  erroDoRemove = null;
  erroDoInsert = null;
  contatoRow = { avatar_storage_path: CAMINHO };
  rpcMock.mockReset().mockResolvedValue({
    data: { already_anonymized: false, counts: { contacts: 1 }, media_paths: [] },
    error: null,
  });
});

describe("cascadeRedactContact — foto de perfil", () => {
  it("enfileira o arquivo da foto e zera a coluna do contato", async () => {
    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      tabela: "storage_redaction_queue",
      payload: {
        organization_id: ORG,
        request_id: PEDIDO,
        bucket: "whatsapp-media",
        object_path: CAMINHO,
      },
    });

    const zeragem = updates.find((u) => u.tabela === "contacts");
    expect(zeragem?.patch).toMatchObject({ avatar_storage_path: null });
  });

  it("caminho fora da forma exata solta o ponteiro e não entra na fila", async () => {
    contatoRow = { avatar_storage_path: `${ORG}/avatars/outro-contato.jpg` };

    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO });

    expect(inserts).toEqual([]);
    expect(updates.find((u) => u.tabela === "contacts")?.patch).toMatchObject({ avatar_storage_path: null });
  });

  it("enfileira ANTES de chamar a RPC — depois dela o caminho poderia já não existir", async () => {
    // A ordem é a propriedade em disputa: desde a 9243 a RPC também limpa
    // `avatar_storage_path`, e a fila cheia antes dela é a falha fechada que
    // `cascadeRedactContact` documenta. Este teste é o que impede a inversão.
    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO });

    const posInsert = ops.indexOf("insert:storage_redaction_queue");
    const posRpc = ops.indexOf("rpc");
    expect(posInsert).toBeGreaterThanOrEqual(0);
    expect(posRpc).toBeGreaterThanOrEqual(0);
    expect(posInsert).toBeLessThan(posRpc);
  });

  it("contato sem foto não enfileira nada e a cascata segue normalmente", async () => {
    contatoRow = { avatar_storage_path: null };

    const resultado = await cascadeRedactContact({
      organizationId: ORG,
      contactId: CONTATO,
      requestId: PEDIDO,
    });

    expect(inserts).toHaveLength(0);
    expect(updates.filter((u) => u.tabela === "contacts")).toHaveLength(0);
    expect(ops).toContain("rpc");
    expect(resultado.alreadyAnonymized).toBe(false);
  });

  it("o enfileiramento é escopado pela organização em toda leitura e escrita", async () => {
    // Service role bypassa RLS: sem o filtro manual por organização, a cascata de
    // um tenant alcançaria a foto de outro.
    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO });
    expect(inserts[0]?.payload).toMatchObject({ organization_id: ORG });
  });

  it("anexo de nota com caminho fora da organização não entra na fila", async () => {
    const PROPRIO = `${ORG}/conversa/nota.jpg`;
    filaPendente = [
      { id: "c1", media_storage_path: `outra-org/conversa/nota.jpg` },
      { id: "c2", media_storage_path: PROPRIO },
    ] as unknown as typeof filaPendente;

    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO });

    const naFila = inserts
      .filter((i) => i.tabela === "storage_redaction_queue" && i.payload.bucket === "internal-media")
      .map((i) => i.payload.object_path);
    expect(naFila).toEqual([PROPRIO]);
  });

  it("enfileiramento que falha NÃO pode zerar o ponteiro — seria perder o rastro do arquivo", async () => {
    // O caminho do avatar é ESTÁVEL por contato (`{org}/avatars/{id}.jpg`) e
    // reaproveitado a cada refresh, ao contrário da mídia de mensagem. Por isso
    // ele COLIDE com `unique (bucket, object_path)` quando já houve um pedido
    // anterior para o mesmo contato — a linha antiga nunca é purgada da fila.
    //
    // Se o insert falhar e o código zerar `avatar_storage_path` assim mesmo, o
    // contato fica anonimizado, a auditoria registra a redação, e o JPEG do
    // rosto permanece no bucket sem NENHUM ponteiro capaz de encontrá-lo. É a
    // definição de arquivo órfão que este PR existe para evitar.
    erroDoInsert = { code: "23505", message: "duplicate key value violates unique constraint" };

    await expect(
      cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: PEDIDO }),
    ).rejects.toThrow();

    expect(updates.find((u) => u.tabela === "contacts")).toBeUndefined();
    expect(ops).not.toContain("rpc");
  });
});

describe("drainStorageRedactionQueue — o arquivo sai do bucket", () => {
  it("remove o objeto do bucket e marca a linha como deleted", async () => {
    // "Enfileirou" não é "removeu". Este é o teste que cobra a diferença.
    filaPendente = [
      { id: "fila-1", organization_id: ORG, bucket: "whatsapp-media", object_path: CAMINHO, attempts: 0 },
    ];

    const stats = await drainStorageRedactionQueue({ limit: 10 });

    expect(removes).toEqual([{ bucket: "whatsapp-media", caminhos: [CAMINHO] }]);
    expect(stats).toMatchObject({ attempted: 1, deleted: 1, failed: 0 });
    expect(updates.find((u) => u.tabela === "storage_redaction_queue")?.patch).toMatchObject({
      status: "deleted",
    });
  });

  it.each([
    ["outra organização", "outra-org/avatars/x.jpg"],
    ["prefixo parecido", `${ORG}-x/avatars/x.jpg`],
    ["barra inicial", `/${ORG}/avatars/x.jpg`],
    ["subida de pasta", `${ORG}/../outra-org/x.jpg`],
    ["ponto", `${ORG}/./x.jpg`],
    ["segmento vazio", `${ORG}//x.jpg`],
    ["contrabarra", `${ORG}/pasta\\x.jpg`],
  ])("caminho fora da organização não é removido: %s", async (_nome, caminho) => {
    filaPendente = [
      { id: "fila-fora", organization_id: ORG, bucket: "whatsapp-media", object_path: caminho, attempts: 0 },
    ];

    const stats = await drainStorageRedactionQueue({ limit: 10 });

    expect(removes).toEqual([]);
    expect(stats).toMatchObject({ attempted: 1, skipped: 1, deleted: 0, failed: 0 });
    expect(updates.find((u) => u.tabela === "storage_redaction_queue")?.patch).toMatchObject({
      status: "skipped",
      error_message: "path_outside_organization",
    });
  });

  it("objeto já ausente vira skipped, não fica em retry eterno", async () => {
    filaPendente = [
      { id: "fila-2", organization_id: ORG, bucket: "whatsapp-media", object_path: CAMINHO, attempts: 0 },
    ];
    erroDoRemove = { message: "Object not found" };

    const stats = await drainStorageRedactionQueue({ limit: 10 });

    expect(stats).toMatchObject({ attempted: 1, skipped: 1, deleted: 0 });
    expect(updates.find((u) => u.tabela === "storage_redaction_queue")?.patch).toMatchObject({
      status: "skipped",
    });
  });
});

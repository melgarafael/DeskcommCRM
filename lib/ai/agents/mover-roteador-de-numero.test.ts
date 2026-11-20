/**
 * #4340 (segunda metade) — O ROTEADOR ACOMPANHA O NÚMERO NOVO.
 *
 * ─── O defeito medido ────────────────────────────────────────────────────────
 *
 * `ai_routers.channel_session_id` ancora o roteador num número. Quando os
 * agentes migram para um número novo, o roteador continua apontando para o
 * antigo — arquivado, fora de `listSelectableChannels` e, desde o #4348,
 * marcado como removido na tela. O número NOVO nasce sem roteador: o turno
 * dele cai no agente principal, sem decisão de intenção (só o rastro
 * `no_match` do #4348).
 *
 * ─── A escolha, e a régua que este arquivo prova ────────────────────────────
 *
 * A troca é uma AÇÃO do operador na tela que já denuncia o problema, e não um
 * efeito colateral de publicar uma versão do agente. Motivo: o evento "publicar
 * versão noutro número" não diz que o roteador deve seguir — um roteador tem N
 * membros e o número novo pode ser de outro telefone, de outra campanha. Só um
 * humano sabe que B substitui A. O que o sistema garante é que a mudança é
 * EXPLÍCITA, guiada e auditada:
 *
 *   - só a partir de um roteador cujo número atual está ARQUIVADO/ausente —
 *     número vivo não se move por esta porta (`numero_atual_ainda_ativo`);
 *   - só para um número da MESMA organização, vivo e SEM roteador nenhum;
 *   - a linha de `ai_routers` é atualizada (o trigger da 0085 já registra
 *     old/new) E uma linha `ai.router_channel_moved` guarda "de X para Y" com
 *     quem moveu — o mantenedor consegue explicar o que mudou;
 *   - mesmo número duas vezes = no-op idempotente, sem auditoria duplicada.
 *
 * O teste do TURNO (`roteador-acompanha-numero.test.ts`) é o outro lado: depois
 * da mudança, `loadActiveRouter` na sessão NOVA acha este roteador.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { moverRoteadorParaNumero } from "./mover-roteador-de-numero";

const ORG = "11111111-1111-4111-8111-111111111111";
const ROUTER = "22222222-2222-4222-8222-222222222222";
const NUMERO_ANTIGO = "33333333-3333-4333-8333-333333333333";
const NUMERO_NOVO = "44444444-4444-4444-8444-444444444444";
const OUTRO_NUMERO = "55555555-5555-4555-8555-555555555555";

interface Canal {
  id: string;
  archived_at: string | null;
}

interface Estado {
  router: { id: string; name: string; channel_session_id: string } | null;
  canais: Canal[];
  /** Sessões que já têm roteador (qualquer `is_active`). */
  ocupantes: { channel_session_id: string }[];
  /** Banco sem a migration 0106 (sem `channel_sessions.archived_at`). */
  semColunaArquivado?: boolean;
  erroNoUpdate?: { code?: string; message: string } | null;
}

/**
 * Dublê do PostgREST: responde os formatos de consulta que o módulo usa e
 * APLICA o UPDATE no estado — é o que permite medir "moveu de verdade", e não
 * só "a função disse que moveu".
 */
function bancoFingido(inicial: Partial<Estado> = {}) {
  const estado: Estado = {
    router: { id: ROUTER, name: "Roteador do atendimento", channel_session_id: NUMERO_ANTIGO },
    canais: [
      { id: NUMERO_ANTIGO, archived_at: "2026-11-01T12:00:00.000Z" },
      { id: NUMERO_NOVO, archived_at: null },
      { id: OUTRO_NUMERO, archived_at: null },
    ],
    ocupantes: [],
    ...inicial,
  };
  const updates: Record<string, unknown>[] = [];
  const pedidos: string[] = [];

  const db = {
    from(tabela: string) {
      let pediuArquivado = false;
      let pediuSomenteId = false;
      const filtros: Array<[string, unknown]> = [];

      function resolver() {
        if (tabela === "ai_routers") {
          // `select("id")` é a checagem de ocupante; o detalhe pede mais colunas.
          return pediuSomenteId
            ? { data: estado.ocupantes, error: null }
            : { data: estado.router, error: null };
        }
        if (tabela === "channel_sessions") {
          if (estado.semColunaArquivado && pediuArquivado) {
            return {
              data: null,
              error: {
                code: "42703",
                message: "column channel_sessions_1.archived_at does not exist",
              },
            };
          }
          const id = filtros.find(([c]) => c === "id")?.[1];
          const canal = estado.canais.find((c) => c.id === id) ?? null;
          if (!canal) return { data: null, error: null };
          // O fallback sem a coluna devolve só o id.
          return { data: pediuArquivado ? canal : { id: canal.id }, error: null };
        }
        return { data: null, error: null };
      }

      const q = {
        select(colunas: string) {
          pedidos.push(`${tabela}:${colunas}`);
          pediuArquivado = colunas.includes("archived_at");
          pediuSomenteId = colunas.trim() === "id";
          return q;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push([coluna, valor]);
          return q;
        },
        is: () => q,
        order: () => q,
        limit: () => Promise.resolve(resolver()),
        maybeSingle: () => Promise.resolve(resolver()),
        update(valores: Record<string, unknown>) {
          updates.push(valores);
          const erro = estado.erroNoUpdate ?? null;
          if (!erro && estado.router) {
            estado.router = { ...estado.router, ...valores } as Estado["router"];
          }
          return {
            eq() {
              return this;
            },
            then(resolve: (v: unknown) => unknown) {
              return Promise.resolve({ data: null, error: erro }).then(resolve);
            },
          };
        },
      };
      return q;
    },
  };

  return { db: db as never, estado, updates, pedidos };
}

function mover(db: unknown, para: string = NUMERO_NOVO) {
  return moverRoteadorParaNumero(db as never, {
    organizationId: ORG,
    routerId: ROUTER,
    novoChannelSessionId: para,
    quemMoveu: {
      userId: "99999999-9999-4999-8999-999999999999",
      apiTokenId: null,
      requestId: "req-1",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#4340 — mover o roteador para o número novo", () => {
  it("move a linha do número arquivado para o número novo e audita o 'de X para Y'", async () => {
    const banco = bancoFingido();

    const resultado = await mover(banco.db);

    expect(resultado, "o roteador não foi movido para o número novo").toMatchObject({
      ok: true,
      de: NUMERO_ANTIGO,
      para: NUMERO_NOVO,
      movido: true,
    });
    expect(
      banco.estado.router?.channel_session_id,
      "a linha de ai_routers continuou no número antigo",
    ).toBe(NUMERO_NOVO);

    expect(audit, "a mudança não deixou rastro de auditoria").toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "ai.router_channel_moved",
      organizationId: ORG,
      resourceType: "ai_router",
      resourceId: ROUTER,
      metadata: { de: NUMERO_ANTIGO, para: NUMERO_NOVO },
    });
  });

  it("número atual AINDA vivo não se move por esta porta, e não audita", async () => {
    const banco = bancoFingido({
      canais: [
        { id: NUMERO_ANTIGO, archived_at: null },
        { id: NUMERO_NOVO, archived_at: null },
      ],
    });

    const resultado = await mover(banco.db);

    expect(resultado).toMatchObject({ ok: false, code: "numero_atual_ainda_ativo" });
    expect(banco.estado.router?.channel_session_id).toBe(NUMERO_ANTIGO);
    expect(audit).not.toHaveBeenCalled();
  });

  it("número novo que já tem roteador não recebe outro, e nada muda", async () => {
    const banco = bancoFingido({ ocupantes: [{ channel_session_id: NUMERO_NOVO }] });

    const resultado = await mover(banco.db);

    expect(resultado).toMatchObject({ ok: false, code: "numero_novo_ja_tem_roteador" });
    expect(banco.estado.router?.channel_session_id).toBe(NUMERO_ANTIGO);
    expect(audit).not.toHaveBeenCalled();
  });

  it("número novo arquivado é recusado — mover para um número morto trocaria um problema por outro", async () => {
    const banco = bancoFingido({
      canais: [
        { id: NUMERO_ANTIGO, archived_at: "2026-11-01T12:00:00.000Z" },
        { id: NUMERO_NOVO, archived_at: "2026-11-02T12:00:00.000Z" },
      ],
    });

    const resultado = await mover(banco.db);

    expect(resultado).toMatchObject({ ok: false, code: "numero_novo_invalido" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("número novo que não existe nesta organização é recusado", async () => {
    const banco = bancoFingido({
      canais: [{ id: NUMERO_ANTIGO, archived_at: "2026-11-01T12:00:00.000Z" }],
    });

    const resultado = await mover(banco.db, OUTRO_NUMERO);

    expect(resultado).toMatchObject({ ok: false, code: "numero_novo_invalido" });
  });

  it("mesmo número (duplo clique/retry) é no-op idempotente, sem segundo audit", async () => {
    const banco = bancoFingido();

    const resultado = await mover(banco.db, NUMERO_ANTIGO);

    expect(resultado).toMatchObject({
      ok: true,
      de: NUMERO_ANTIGO,
      para: NUMERO_ANTIGO,
      movido: false,
    });
    expect(banco.updates, "o no-op não pode regravar a linha").toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("banco sem a coluna archived_at: nada está arquivado, então o número atual conta como vivo", async () => {
    const banco = bancoFingido({ semColunaArquivado: true });

    const resultado = await mover(banco.db);

    expect(resultado).toMatchObject({ ok: false, code: "numero_atual_ainda_ativo" });
    expect(banco.estado.router?.channel_session_id).toBe(NUMERO_ANTIGO);
  });

  it("falha do UPDATE não mente: devolve erro e não audita a mudança", async () => {
    const banco = bancoFingido({ erroNoUpdate: { message: "boom" } });

    const resultado = await mover(banco.db);

    expect(resultado).toMatchObject({ ok: false, code: "update_failed" });
    expect(audit).not.toHaveBeenCalled();
  });
});

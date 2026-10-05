/**
 * A retenção de mídia DECLARADA NA TELA passa a ser APLICADA — issue #1534.
 *
 * Três camadas, cada uma com a régua que lhe cabe:
 *
 *   1. O TEXTO do schema (migration 0557 × apêndice do baseline) — as regras
 *      que só existem no banco e que este repositório valida NA ESCRITA, porque
 *      o gate de escrita é o próprio artefato que o kit self-host aplica:
 *      interruptor (`media_retention_enforced`, ligado por padrão), piso de 30 dias, marcador
 *      `expired` + `media_expired_at`, `media_derived_text` zerado, suspensão
 *      por pedido LGPD em andamento, lote no `limit` e isolamento por
 *      organização (templates e avatares fora do alvo).
 *   2. O DRENO em lotes no cron `data-retention` (lotes de 1000, teto de 20
 *      por execução, números em `ResultadoDaRetencao`, audit em
 *      `retention.sweep_run`) — "sem apagar tudo numa tacada" é propriedade do
 *      LAÇO, e o laço é TypeScript.
 *   3. A ROTA `messages/[id]/media` — 410 para o que expirou e NENHUMA ida ao
 *      provedor depois do marcador.
 *
 * O que este arquivo NÃO mede: o que o Postgres DE FATO enfileira. Isso é
 * `tests/invariants/retencao-de-midia-opt-in-e-marcador.test.ts` (suíte
 * `test:db`, Postgres efêmero com o MESMO baseline) — o SQL daqui é a mesma
 * regra escrita duas vezes, e a prova executável dela mora lá.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_LOTES,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
  type PodaDb,
} from "@/app/api/v1/cron/data-retention/route";
import { RETENCAO_MIDIA_DIAS_PISO } from "@/lib/retencao/politica";

const RAIZ = process.cwd();
const MIGRACAO = join(
  RAIZ,
  "supabase",
  "migrations",
  "20261005200301_0557_retencao_de_midia_opt_in_e_marcador.sql",
);
const BASELINE = join(RAIZ, "supabase", "baseline.sql");

const migracao = readFileSync(MIGRACAO, "utf8");
const baseline = readFileSync(BASELINE, "utf8");

/**
 * O estado da rota sob teste mora no ESCOPO DO MÓDULO, não no do describe: as
 * fábricas de `vi.mock` são içadas para o topo do arquivo e só enxergam o que
 * está aqui — uma const do corpo do describe dá `ReferenceError` na fábrica.
 */
const adapter = {
  fetchInboundMedia: vi.fn(async () => ({ buffer: new ArrayBuffer(8), mime: "image/jpeg" })),
};
let mensagem: Record<string, unknown> | null = null;
const cadeiaMensagem = {
  select: () => cadeiaMensagem,
  eq: () => cadeiaMensagem,
  maybeSingle: async () => ({ data: mensagem, error: null }),
};

/** O apêndice do baseline, da marca da 0557 até a função SEGUINTE a ela. */
const apendice = (() => {
  const inicio = baseline.indexOf(
    "-- ---- a limpeza de mídia ganha interruptor, marca a mensagem e obedece à LGPD (migration 0557) ----",
  );
  expect(inicio).toBeGreaterThan(0);
  const corpo = baseline.indexOf("create or replace function public.fn_enfileirar_midia_vencida", inicio);
  expect(corpo).toBeGreaterThan(0);
  const depois = baseline.indexOf("\ncreate or replace function public.fn_", corpo + 10);
  return baseline.slice(inicio, depois > 0 ? depois : corpo + 8000);
})();

/** O corpo do passo VENCIDAS — de `1. VENCIDAS` ao `2. ÓRFÃOS`. */
function corpoDeVencidas(sql: string): string {
  const inicio = sql.indexOf("1. VENCIDAS");
  const fim = sql.indexOf("2. ÓRFÃOS", inicio);
  expect(inicio).toBeGreaterThan(0);
  expect(fim).toBeGreaterThan(inicio);
  return sql.slice(inicio, fim);
}

describe("a retenção de mídia existe no schema, das DUAS formas que o self-host aplica", () => {
  it("a limpeza continua LIGADA para quem já existe: default TRUE e nenhum UPDATE no interruptor", () => {
    // Decisão do mantenedor (doc 92, opção A). O `add column ... default true`
    // preenche TRUE em toda linha existente. Um UPDATE no interruptor dentro do
    // apêndice seria reaplicado pelo `update.sh` a cada versão e desfaria a
    // escolha de quem mexeu nele na tela — a prova executável disso é o
    // invariante `retencao-de-midia-opt-in-e-marcador.test.ts`.
    for (const [rotulo, sql] of [
      ["migration", migracao],
      ["baseline", apendice],
    ] as const) {
      expect(sql, rotulo).toContain(
        "add column if not exists media_retention_enforced boolean not null default true",
      );
      expect(sql, rotulo).not.toMatch(/set\s+media_retention_enforced\s*=/);
    }
  });

  it("a função só expira organização LIGADA (sem enforced, nada expira)", () => {
    for (const [rotulo, sql] of [
      ["migration", migracao],
      ["baseline", apendice],
    ] as const) {
      const vencidas = corpoDeVencidas(sql);
      expect(vencidas, rotulo).toContain("and o.media_retention_enforced");
      // O gate está ANTES do corte, senão ele filtra depois de já ter escolhido.
      expect(vencidas.indexOf("and o.media_retention_enforced"), rotulo).toBeLessThan(
        vencidas.indexOf("order by m.created_at"),
      );
    }
  });

  it("o piso de 30 dias vale MESMO com valor menor gravado no banco", () => {
    const piso = "greatest(coalesce(o.media_retention_days, 365), 30)";
    expect(corpoDeVencidas(migracao)).toContain(piso);
    expect(corpoDeVencidas(baseline)).toContain(piso);
    // E o corte usa o MESMO expressão que o marcador grava — uma cópia de cada
    // lado é como o piso da tela e o piso do banco divergem.
    expect(migracao).toContain(`'media_retention_days', alvo.retencao_dias`);
  });

  it("a mídia expirada perde os DOIS ponteiros, some com a transcrição e fica marcada", () => {
    for (const [rotulo, sql] of [
      ["migration", migracao],
      ["baseline", apendice],
    ] as const) {
      expect(sql, rotulo).toContain("media_storage_path = null");
      expect(sql, rotulo).toContain("media_url = null");
      expect(sql, rotulo).toContain("media_derived_text = null");
      expect(sql, rotulo).toContain(`'media_status', 'expired'`);
      expect(sql, rotulo).toContain(`'media_expired_at'`);
    }
  });

  it("pedido LGPD em andamento SUSPENDE a expiração da organização", () => {
    for (const [rotulo, sql] of [
      ["migration", migracao],
      ["baseline", apendice],
    ] as const) {
      const vencidas = corpoDeVencidas(sql);
      expect(vencidas, rotulo).toContain("from public.lgpd_requests r");
      expect(vencidas, rotulo).toContain("and r.status in ('received', 'processing')");
      expect(vencidas, rotulo).toContain("r.organization_id = m.organization_id");
    }
  });

  it("a poda é em LOTE e SÓ em mensagem: templates e avatares ficam de fora", () => {
    for (const [rotulo, sql] of [
      ["migration", migracao],
      ["baseline", apendice],
    ] as const) {
      const vencidas = corpoDeVencidas(sql);
      expect(vencidas, rotulo).toContain("limit v_lim");
      expect(vencidas, rotulo).toContain("from public.messages m");
      expect(vencidas, rotulo).not.toContain("avatar_storage_path");
      expect(vencidas, rotulo).not.toContain("template");
      expect(vencidas, rotulo).not.toContain("conversation_notes");
    }
  });
});

describe("o dreno em lotes do cron data-retention (#1534)", () => {
  /** Um PodaDb mínimo: só as irmãs em zero e a fila de mídia pela sequência. */
  function dbDeMidia(
    sequencia: Array<{ vencidas: number; orfas?: number; expurgadas?: number }>,
  ): { db: PodaDb; lotes: number[] } {
    const lotes: number[] = [];
    const restante = [...sequencia];
    const db: PodaDb = {
      async rpc() {
        return { data: 0, error: null };
      },
      async apagarRascunhos() {
        return { data: 0, error: null };
      },
      async enfileirarMidia(lote) {
        lotes.push(lote);
        return { data: restante.shift() ?? { vencidas: 0, orfas: 0 }, error: null };
      },
    };
    return { db, lotes };
  }

  it("drena em lotes de 1000 com teto de 20 por execução — nunca tudo numa tacada", async () => {
    const cheia = Array.from({ length: MAX_LOTES + 3 }, () => ({ vencidas: TAMANHO_DO_LOTE, orfas: 0 }));
    const { db, lotes } = dbDeMidia(cheia);
    const r = await podarHistorico(db, {});

    expect(lotes).toHaveLength(MAX_LOTES);
    expect(lotes.every((l) => l === TAMANHO_DO_LOTE)).toBe(true);
    expect(r.lotes_midia).toBe(MAX_LOTES);
    expect(r.midia_enfileirada).toBe(MAX_LOTES * TAMANHO_DO_LOTE);
    // O teto fecha com trabalho sobrando — e o resultado DIZ isso.
    expect(r.midia_tem_resto).toBe(true);
    expect(r.retencao_midia_dias).toBe(RETENCAO_MIDIA_DIAS_PISO);
  });

  it("para no primeiro lote incompleto e soma vencidas + orfas", async () => {
    const { db, lotes } = dbDeMidia([
      { vencidas: TAMANHO_DO_LOTE, orfas: TAMANHO_DO_LOTE },
      { vencidas: 321, orfas: 12 },
    ]);
    const r = await podarHistorico(db, {});

    expect(lotes).toHaveLength(2);
    expect(r.lotes_midia).toBe(2);
    expect(r.midia_enfileirada).toBe(TAMANHO_DO_LOTE * 2 + 321 + 12);
    expect(r.midia_tem_resto).toBe(false);
    expect(r.midia_expurgada).toBe(0);
  });

  it("uma rodada que só enfileirou mídia AUDITA (retention.sweep_run)", async () => {
    const base = await podarHistorico(dbDeMidia([{ vencidas: 0, orfas: 0 }]).db, {});
    expect(houveEfeito(base)).toBe(false);
    expect(houveEfeito({ ...base, midia_enfileirada: 1 })).toBe(true);
    // Expurgar LINHA DE FILA de mídia também é mutação (#1765).
    expect(houveEfeito({ ...base, midia_expurgada: 1 })).toBe(true);
  });
});

describe("a rota messages/[id]/media não re-busca do provedor o que expirou", () => {
  vi.mock("@/lib/supabase/server", () => ({
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "usuario-1" } }, error: null }) },
      from: () => cadeiaMensagem,
    }),
  }));
  vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ idioma: "pt-BR" }) }));
  vi.mock("@/lib/auth/require-role", () => ({
    orgAtivaDaApi: async () => ({ ok: true, org: { orgId: "org-1" } }),
  }));
  vi.mock("@/lib/channels", () => ({
    CHANNEL_SESSION_REF_COLUMNS: "id",
    DEFAULT_CHANNEL_PROVIDER: "waha",
    getAdapter: () => adapter,
    resolveSessionRef: () => ({ session: "s" }),
  }));
  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: { provider: "waha", id: "s" }, error: null }),
        };
        return q;
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) },
    }),
  }));

  /**
   * O import dinâmico mora AQUI, dentro do describe, e não no topo do arquivo:
   * o `vi.mock` é içado para o topo, mas a fábrica só roda quando o MÓDULO é
   * importado — e ela lê `adapter`/`cadeiaMensagem`, que o corpo do describe
   * ainda não inicializou (TDZ na avaliação do arquivo).
   */
  async function chamada(): Promise<Response> {
    const { GET } = await import("@/app/api/v1/messages/[id]/media/route");
    return GET({} as never, { params: Promise.resolve({ id: "mensagem-1" }) });
  }

  beforeEach(() => {
    adapter.fetchInboundMedia.mockClear();
    mensagem = null;
  });

  it("expirada → 410 e NENHUMA chamada ao provedor", async () => {
    mensagem = {
      id: "mensagem-1",
      media_url: null,
      media_storage_path: null,
      media_mime: "image/jpeg",
      channel_session_id: "s",
      metadata: { media_status: "expired", media_retention_days: 365 },
    };

    const resposta = await chamada();
    expect(resposta.status).toBe(410);
    expect(adapter.fetchInboundMedia).not.toHaveBeenCalled();
    const corpo = (await resposta.json()) as { error?: { code?: string; message?: string } };
    expect(corpo.error?.code).toBe("media_expired");
    expect(corpo.error?.message).toContain("365 dias");
  });

  it("sem mídia e SEM marcador continua 404 (o 410 é só do que existiu)", async () => {
    mensagem = {
      id: "mensagem-1",
      media_url: null,
      media_storage_path: null,
      media_mime: null,
      channel_session_id: "s",
      metadata: null,
    };

    const resposta = await chamada();
    expect(resposta.status).toBe(404);
    expect(adapter.fetchInboundMedia).not.toHaveBeenCalled();
    // Mensagem que nunca teve mídia não fala em retenção.
    const corpo = (await resposta.json()) as { error?: { message?: string } };
    expect(corpo.error?.message).toBe("Mensagem sem mídia.");
  });

  it("mídia ainda não persistida segue indo buscar no provedor (controle)", async () => {
    mensagem = {
      id: "mensagem-1",
      media_url: "https://provider.test/a.jpg",
      media_storage_path: null,
      media_mime: "image/jpeg",
      channel_session_id: "s",
      metadata: { media_status: "stored" },
    };

    const resposta = await chamada();
    expect(resposta.status).toBe(200);
    expect(adapter.fetchInboundMedia).toHaveBeenCalledTimes(1);
  });
});

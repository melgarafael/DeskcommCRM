/**
 * O RODÍZIO DO SYNC CONTINUA GIRANDO — SEM CARIMBAR A CONEXÃO (#3695).
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * A rodada de `agenda-google-sync` lê 25 conexões por minuto. O rodízio ERA o
 * `updated_at` da própria conexão: a rodada carimbava a coluna em toda conexão
 * do lote, sincronizando ou não, e lia `order=updated_at.asc` — o carimbo
 * empurrava a linha para o fim da fila. Numa instalação ociosa isso é um UPDATE
 * por conexão por minuto, para sempre, e o único valor que muda é o `updated_at`
 * (WAL, tupla morta, IO) — é o que a #3695 mediu em produção.
 *
 * O carimbo saiu; o rodízio NÃO podia sair junto. Então o que se prova aqui, com
 * banco de mentira e relógio injetado (nada dorme):
 *
 *   1. com mais conexões do que o lote, duas rodadas seguidas leem conjuntos
 *      DIFERENTES — o rodízio existe;
 *   2. em algumas rodadas TODA conexão foi lida — ninguém fica de fora para
 *      sempre (era o risco declarado de trocar o cursor por um critério fixo);
 *   3. quando nada é lido, NENHUMA linha de `calendar_connections` é escrita;
 *   4. quando uma agenda é lida de verdade, `last_sync_at` continua sendo
 *      gravado — a rodada não virou "nunca escreve".
 *
 * O banco falso APLICA `order`/`range`/`limit` sobre a lista, como o servidor
 * faria: um fake que devolvesse sempre o começo da lista faria os casos 1 e 2
 * passarem nos dois mundos.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "cron" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({
  refreshCatalog: vi.fn(),
  syncCalendar: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_db, rows) => rows),
}));

import { GET } from "@/app/api/v1/cron/agenda-google-sync/route";
import { syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  janelaDaRodada,
  LOTE_DE_CONEXOES,
} from "@/lib/agenda/google/rodizio-de-conexoes";

type Conexao = { id: string; organization_id: string; user_id: string };

type Calendario = {
  id: string;
  external_calendar_id: string;
  counts_for_conflicts: boolean;
  is_destination: boolean;
  sync_next_attempt_at: string;
};

type Chamada = {
  tabela: string;
  tipo: "select" | "update";
  colunas: string;
  opcoes?: { count?: string; head?: boolean };
  ordem?: string;
  range?: [number, number];
  limite?: number;
  patch?: Record<string, unknown>;
};

const INICIO = new Date("2026-10-29T12:00:00.000Z").getTime();

/** Conexões com id previsível: a ordem estável do rodízio é este `id`. */
function conexoes(total: number): Conexao[] {
  return Array.from({ length: total }, (_, i) => ({
    id: `conn-${String(i).padStart(3, "0")}`,
    organization_id: `org-${i}`,
    user_id: `user-${i}`,
  }));
}

function agenda(conexaoId: string): Calendario {
  return {
    id: `${conexaoId}-agenda`,
    external_calendar_id: `${conexaoId}-agenda`,
    counts_for_conflicts: true,
    is_destination: false,
    sync_next_attempt_at: "2000-01-01T00:00:00.000Z",
  };
}

/**
 * Banco falso que respeita `order`, `range` e `limit` na tabela de conexões, e
 * registra toda escrita. `paginas` guarda os ids devolvidos por leitura, na
 * ordem das rodadas — é sobre isso que o rodízio é medido.
 */
function dbFalso(programa: {
  conexoes: Conexao[];
  /** `null` = a contagem falhou (o PostgREST devolve `count: null`). */
  totalInformado?: number | null;
  /** Agendas que DEVEM nesta rodada, por conexão. */
  agendasDevidas?: (conexaoId: string) => Calendario[];
}) {
  const chamadas: Chamada[] = [];
  const paginas: string[][] = [];
  const escritasNaConexao: Array<{ patch: Record<string, unknown> }> = [];
  const total =
    programa.totalInformado === undefined ? programa.conexoes.length : programa.totalInformado;

  function consulta(nome: string) {
    let tipo: "select" | "update" = "select";
    let colunas = "";
    let opcoes: { count?: string; head?: boolean } | undefined;
    let ordem: string | undefined;
    let intervalo: [number, number] | undefined;
    let limite: number | undefined;
    let patch: Record<string, unknown> | undefined;
    const filtros: Record<string, unknown> = {};

    const executar = () => {
      chamadas.push({ tabela: nome, tipo, colunas, opcoes, ordem, range: intervalo, limite, patch });

      if (tipo === "update") {
        if (nome === "calendar_connections") escritasNaConexao.push({ patch: patch ?? {} });
        return { data: null, error: null };
      }

      if (nome === "calendar_connections") {
        if (opcoes?.head) return { data: null, count: total, error: null };
        const ordenadas = [...programa.conexoes].sort((a, b) => a.id.localeCompare(b.id));
        const inicio = intervalo?.[0] ?? 0;
        const ultimo = intervalo
          ? intervalo[1]
          : Math.min((limite ?? ordenadas.length) - 1, ordenadas.length - 1);
        const pagina = ordenadas.slice(inicio, ultimo + 1);
        paginas.push(pagina.map((c) => c.id));
        return { data: pagina, count: null, error: null };
      }

      if (nome === "calendar_connection_calendars") {
        if (/catalog_checked_at/.test(colunas)) {
          // Catálogo fresco: a rodada não vai renová-lo (isso é outro caminho).
          return { data: [{ catalog_checked_at: new Date().toISOString() }], error: null };
        }
        return { data: programa.agendasDevidas?.(String(filtros.connection_id)) ?? [], error: null };
      }

      return { data: [], error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = (colunasPedidas: string, opcoesPedidas?: { count?: string; head?: boolean }) => {
      colunas = colunasPedidas;
      opcoes = opcoesPedidas;
      return b;
    };
    b.eq = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return b;
    };
    b.lte = () => b;
    b.is = () => b;
    b.in = () => b;
    b.order = (coluna: string) => {
      ordem = coluna;
      return b;
    };
    b.range = (inicio: number, fim: number) => {
      intervalo = [inicio, fim];
      return b;
    };
    b.limit = (n: number) => {
      limite = n;
      return b;
    };
    b.update = (valores: Record<string, unknown>) => {
      tipo = "update";
      patch = valores;
      return b;
    };
    b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      Promise.resolve(executar()).then(ok, erro);
    return b;
  }

  return { from: (nome: string) => consulta(nome), chamadas, paginas, escritasNaConexao };
}

async function rodar(): Promise<number> {
  const req = new NextRequest("http://local/cron", {
    headers: { authorization: "Bearer cron" },
  });
  return (await GET(req)).status;
}

function relogioEm(ms: number): void {
  vi.setSystemTime(new Date(ms));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  relogioEm(INICIO);
  vi.mocked(syncCalendar).mockResolvedValue("complete");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rodízio da rodada: a aritmética pura", () => {
  it("cabe numa página só quando não há mais conexões do que o lote", () => {
    expect(janelaDaRodada(LOTE_DE_CONEXOES, new Date(INICIO))).toBeNull();
    expect(janelaDaRodada(1, new Date(INICIO))).toBeNull();
    expect(janelaDaRodada(0, new Date(INICIO))).toBeNull();
  });

  it("contagem DESCONHECIDA não desloca: sem saber o total, o deslocamento poderia passar do fim", () => {
    expect(janelaDaRodada(null, new Date(INICIO))).toBeNull();
    expect(janelaDaRodada(undefined, new Date(INICIO))).toBeNull();
    expect(janelaDaRodada(Number.NaN, new Date(INICIO))).toBeNull();
  });

  it("duas rodadas seguidas (um minuto) deslocam a janela", () => {
    const agora = new Date(INICIO);
    const depois = new Date(INICIO + 60_000);
    const a = janelaDaRodada(60, agora);
    const b = janelaDaRodada(60, depois);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.inicio).not.toBe(a!.inicio);
    expect(a!.fim - a!.inicio).toBe(LOTE_DE_CONEXOES - 1);
  });

  it.each([26, 37, 50, 60, 100, 101])(
    "com %i conexões, `ceil(total/lote)` rodadas cobrem TODAS — ninguém fica de fora para sempre",
    (total) => {
      const vistos = new Set<number>();
      const rodadas = Math.ceil(total / LOTE_DE_CONEXOES);
      for (let r = 0; r < rodadas; r += 1) {
        const janela = janelaDaRodada(total, new Date(INICIO + r * 60_000));
        expect(janela).not.toBeNull();
        for (let i = janela!.inicio; i <= janela!.fim; i += 1) vistos.add(i);
      }
      // Exatamente o número de páginas: nenhuma sobra, nenhuma falta.
      expect(vistos.size).toBe(total);
    },
  );
});

describe("rodízio da rodada: a rota, com o banco de mentira", () => {
  it("50 conexões: duas rodadas seguidas leem 25 DIFERENTES cada, e nada é escrito", async () => {
    const banco = dbFalso({ conexoes: conexoes(50) });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    expect(await rodar()).toBe(200);
    relogioEm(INICIO + 60_000);
    expect(await rodar()).toBe(200);

    expect(banco.paginas).toHaveLength(2);
    expect(banco.paginas[0]).toHaveLength(LOTE_DE_CONEXOES);
    expect(banco.paginas[1]).toHaveLength(LOTE_DE_CONEXOES);
    const primeira = new Set(banco.paginas[0]);
    expect((banco.paginas[1] ?? []).filter((id) => primeira.has(id))).toEqual([]);
    // O ponto da issue: rodada ociosa não escreve NADA na conexão.
    expect(banco.escritasNaConexao).toEqual([]);
    // O rodízio não voltou a se apoiar no carimbo.
    const leituras = banco.chamadas.filter(
      (c) => c.tabela === "calendar_connections" && c.tipo === "select" && !c.opcoes?.head,
    );
    expect(leituras.every((c) => c.ordem === "id")).toBe(true);
  });

  it("26 conexões: a página seguinte fecha a lista (o risco declarado do rodízio)", async () => {
    const banco = dbFalso({ conexoes: conexoes(26) });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    expect(await rodar()).toBe(200);
    relogioEm(INICIO + 60_000);
    expect(await rodar()).toBe(200);

    const lidos = new Set(banco.paginas.flat());
    expect(lidos.size).toBe(26);
    expect(banco.escritasNaConexao).toEqual([]);
  });

  it("rodada ociosa: nenhuma escrita em calendar_connections, nem com 60 conexões", async () => {
    const banco = dbFalso({ conexoes: conexoes(60) });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    for (let r = 0; r < 3; r += 1) {
      relogioEm(INICIO + r * 60_000);
      expect(await rodar()).toBe(200);
    }
    // ANTES (#3695): 25 carimbos de `updated_at` por rodada, 75 em três.
    expect(banco.escritasNaConexao).toHaveLength(0);
  });

  it("uma conexão só (cabe na página): lê sem deslocamento e sem contar", async () => {
    const banco = dbFalso({ conexoes: conexoes(3) });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    expect(await rodar()).toBe(200);
    expect(banco.paginas).toEqual([["conn-000", "conn-001", "conn-002"]]);
    const pagina = banco.chamadas.find(
      (c) => c.tabela === "calendar_connections" && c.tipo === "select" && !c.opcoes?.head,
    );
    expect(pagina?.range).toBeUndefined();
    expect(pagina?.limite).toBe(LOTE_DE_CONEXOES);
  });

  it("contagem que falha não pode zerar a rodada: lê o começo da fila", async () => {
    const banco = dbFalso({ conexoes: conexoes(60), totalInformado: null });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    expect(await rodar()).toBe(200);
    expect(banco.paginas[0]).toHaveLength(LOTE_DE_CONEXOES);
    expect(banco.paginas[0]?.[0]).toBe("conn-000");
  });

  it("leitura de verdade CONTINUA gravando last_sync_at (não é 'nunca escreve')", async () => {
    const banco = dbFalso({
      conexoes: conexoes(1),
      agendasDevidas: (conexaoId) => [agenda(conexaoId)],
    });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    expect(await rodar()).toBe(200);
    expect(banco.escritasNaConexao).toHaveLength(1);
    expect(banco.escritasNaConexao[0]?.patch).toMatchObject({ last_sync_error: null });
    expect(typeof banco.escritasNaConexao[0]?.patch.last_sync_at).toBe("string");
  });

  it("`busy` não lê nada e por isso não grava nada na conexão", async () => {
    const banco = dbFalso({
      conexoes: conexoes(1),
      agendasDevidas: (conexaoId) => [agenda(conexaoId)],
    });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    vi.mocked(syncCalendar).mockResolvedValue("busy");

    expect(await rodar()).toBe(200);
    expect(syncCalendar).toHaveBeenCalledTimes(1);
    expect(banco.escritasNaConexao).toEqual([]);
  });

  it("`failed` também não grava: quem conta o que houve é a sync_error da linha", async () => {
    const banco = dbFalso({
      conexoes: conexoes(1),
      agendasDevidas: (conexaoId) => [agenda(conexaoId)],
    });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    vi.mocked(syncCalendar).mockResolvedValue("failed");

    expect(await rodar()).toBe(200);
    expect(banco.escritasNaConexao).toEqual([]);
  });
});

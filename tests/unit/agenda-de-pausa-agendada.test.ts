/**
 * A PAUSA AGENDADA EXISTE, RETOMA SOZINHA E NÃO ATROPELA O OPERADOR — issue #2388.
 *
 * ─── O que este arquivo mede, e por que ele NASCE VERMELHO ─────────────────
 *
 * Hoje só existe pausa MANUAL: um clique em `metadata.disabled` pela Central de
 * Conexões (rota `PATCH …/channel-sessions/[id]/disabled`, RPC
 * `fn_definir_canal_desativado` da migration 0545) e ninguém volta para retomar.
 * Nenhuma agenda, nenhum cron, nada que desfaça a pausa sozinho — a janela de
 * manutenção vira ou "alguém acorda às 3h para clicar" ou "um número pausado
 * até segunda ordem".
 *
 * Medição do red-before (base `origin/main` = ff92e0f98, 09/10/2026):
 *
 *     $ pnpm vitest run tests/unit/agenda-de-pausa-agendada.test.ts
 *     rc 1  (Failed to resolve import "@/lib/channels/agenda-de-pausa" e
 *            "@/app/api/v1/cron/channel-pause-scheduler/route" — nenhum dos
 *            dois existe: só há pausa manual, e nada retoma sozinho)
 *
 * Depois do fix, o MESMO arquivo: rc 0. Os dois números vão no corpo do PR.
 *
 * ─── Relógio INJETADO, nunca sleep ─────────────────────────────────────────
 *
 * `aplicarAgendas(db, agora)` recebe o instante de quem chama; a rota passa
 * `new Date()` e este arquivo passa instantes fixos. Nada aqui dorme nem depende
 * da hora em que a suíte roda — é o critério 2 da issue ("prova por teste do cron
 * com relógio injetado").
 *
 * ─── As três réguas de produto que os casos guardam ────────────────────────
 *
 *  1. Quem a agenda pausou é o que a agenda retoma (critério 3): um canal
 *     pausado MANUALMENTE durante a janela não é retomado no fim — a origem da
 *     pausa (`metadata.disabled_by`) é a régua, e ela nasce na RPC.
 *  2. A janela que passou inteira sem o cron rodar não pausa DEPOIS do fim
 *     (critério 4/1): pausar às 6h uma janela que ia das 3h às 5h seria pior
 *     que não pausar.
 *  3. Organização parada não é tocada (`idsDeOrgsParadas`): suspensa não gasta
 *     nem fala, e a cerca `cron-respeita-org-operante` exige o filtro real.
 *
 * E a borda do critério 7: a janela é montada a partir da HORA DE PAREDE no
 * fuso DA ORGANIZAÇÃO (lib/agenda/fuso), atravessando a virada de horário de
 * verão de São Paulo (2018-11-04) — o instante final tem de ser o daquele fuso,
 * e NUNCA o de ler a mesma hora como UTC (asserção de DESIGUALDADE explícita).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/central-de-pausa", () => ({
  sincronizarAvisoDePausa: vi.fn(async () => "aberto"),
}));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { sincronizarAvisoDePausa } from "@/lib/channels/central-de-pausa";
import {
  acaoDaAgenda,
  canalElegivelParaPausa,
  canalElegivelParaRetomada,
} from "@/lib/channels/agenda-de-pausa";
import { instanteDe } from "@/lib/agenda/fuso";
import { aplicarAgendas, GET } from "@/app/api/v1/cron/channel-pause-scheduler/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const AUTOR = "99999999-9999-4999-8999-999999999999";
const AGENDA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANAL_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANAL_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENDA_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Linha = Record<string, unknown>;
type Filtro = { metodo: string; args: unknown[] };

/** O que o banco fake devolve, e o que as chamadas capturaram. */
interface Programa {
  agendas?: Linha[];
  canais?: Linha[];
  orgsParadas?: string[];
}

const captura: { rpc: Array<Record<string, unknown>>; updates: Array<{ patch: Linha; filtros: Filtro[] }> } = {
  rpc: [],
  updates: [],
};

function valorDo(filtros: Filtro[], metodo: string, coluna: string): unknown {
  return filtros.find((f) => f.metodo === metodo && f.args[0] === coluna)?.args[1];
}

function fazerDb(p: Programa) {
  function construir(tabela: string) {
    const ctx: { filtros: Filtro[]; patch: Linha | null } = { filtros: [], patch: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "lte", "neq", "limit", "order"]) {
      b[m] = (...args: unknown[]) => {
        if (m !== "select") ctx.filtros.push({ metodo: m, args });
        return b;
      };
    }
    b.update = (patch: Linha) => {
      ctx.patch = patch;
      return b;
    };
    b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
      resolver().then(ok, erro);

    async function resolver(): Promise<{ data: unknown; error: null }> {
      if (ctx.patch) {
        captura.updates.push({ patch: ctx.patch, filtros: [...ctx.filtros] });
        const id = String(valorDo(ctx.filtros, "eq", "id") ?? "");
        const statusEsperado = valorDo(ctx.filtros, "eq", "status");
        const agenda = (p.agendas ?? []).find((a) => a.id === id);
        // Claim atômico: só escreve quem ainda enxerga o status esperado.
        if (agenda && agenda.status === statusEsperado) {
          Object.assign(agenda, ctx.patch);
          return { data: [{ id }], error: null };
        }
        return { data: [], error: null };
      }
      if (tabela === "organizations") {
        return { data: (p.orgsParadas ?? []).map((id) => ({ id })), error: null };
      }
      if (tabela === "channel_schedules") {
        return { data: (p.agendas ?? []).filter((a) => a.organization_id === ORG), error: null };
      }
      if (tabela === "channel_sessions") {
        let linhas = p.canais ?? [];
        for (const f of ctx.filtros) {
          if (f.metodo === "eq") linhas = linhas.filter((l) => String(l[String(f.args[0])]) === String(f.args[1]));
        }
        return { data: linhas, error: null };
      }
      throw new Error(`tabela não prevista no banco fake: ${tabela}`);
    }

    return b;
  }

  return {
    from: (tabela: string) => construir(tabela),
    rpc: (nome: string, args: Record<string, unknown>) => {
      captura.rpc.push({ nome, ...args });
      return Promise.resolve({ data: 1, error: null });
    },
  };
}

const agenda = (over: Partial<Linha> = {}): Linha => ({
  id: AGENDA,
  organization_id: ORG,
  channel_session_id: null,
  starts_at: "2026-10-10T03:00:00.000Z",
  ends_at: "2026-10-10T05:00:00.000Z",
  status: "scheduled",
  paused_channel_ids: [],
  created_by: AUTOR,
  ...over,
});

const canal = (id: string, metadata: unknown = null): Linha => ({
  id,
  organization_id: ORG,
  archived_at: null,
  metadata,
});

beforeEach(() => {
  captura.rpc = [];
  captura.updates = [];
  vi.clearAllMocks();
});

describe("regra pura da agenda de pausa (relógio injetado)", () => {
  const janela = { starts_at: "2026-10-10T03:00:00Z", ends_at: "2026-10-10T05:00:00Z", status: "scheduled" as const };

  it("antes do início é aguardando; dentro da janela, pausar", () => {
    expect(acaoDaAgenda(janela, new Date("2026-10-10T02:59:00Z"))).toBe("aguardando");
    expect(acaoDaAgenda(janela, new Date("2026-10-10T03:00:00Z"))).toBe("pausar");
    expect(acaoDaAgenda(janela, new Date("2026-10-10T04:59:00Z"))).toBe("pausar");
  });

  it("janela agendada que já passou inteira é expirada — não pausa depois do fim", () => {
    expect(acaoDaAgenda(janela, new Date("2026-10-10T05:00:00Z"))).toBe("expirada");
    expect(acaoDaAgenda(janela, new Date("2026-10-10T09:00:00Z"))).toBe("expirada");
  });

  it("em execução só retoma no fim; cancelada e encerrada não fazem nada", () => {
    const rodando = { ...janela, status: "running" as const };
    expect(acaoDaAgenda(rodando, new Date("2026-10-10T04:00:00Z"))).toBe("nada");
    expect(acaoDaAgenda(rodando, new Date("2026-10-10T05:00:00Z"))).toBe("retomar");
    expect(acaoDaAgenda({ ...janela, status: "cancelled" }, new Date("2026-10-10T04:00:00Z"))).toBe("nada");
    expect(acaoDaAgenda({ ...janela, status: "done" }, new Date("2026-10-10T06:00:00Z"))).toBe("nada");
  });

  it("elegibilidade: pausa só quem está ligado; retomada só quem a ESTA agenda pausou", () => {
    expect(canalElegivelParaPausa(null)).toBe(true);
    expect(canalElegivelParaPausa({ disabled: true, disabled_by: "manual" })).toBe(false);
    expect(canalElegivelParaRetomada({ disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA }, AGENDA)).toBe(true);
    // Pausado manualmente durante a janela — permanece pausado (critério 3).
    expect(canalElegivelParaRetomada({ disabled: true, disabled_by: "manual" }, AGENDA)).toBe(false);
    // Pausado por OUTRA agenda (janela sobreposta de outro período).
    expect(
      canalElegivelParaRetomada(
        { disabled: true, disabled_by: "schedule", disabled_schedule_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        AGENDA,
      ),
    ).toBe(false);
    // Desligado sem origem (chave de banco anterior à 0545): ninguém retoma às cegas.
    expect(canalElegivelParaRetomada({ disabled: true }, AGENDA)).toBe(false);
  });
});

describe("channel-pause-scheduler — o cron aplica a janela", () => {
  it("na hora de início pausa os canais da agenda e grava a origem programada", async () => {
    const agendas = [agenda()];
    const db = fazerDb({
      agendas,
      canais: [
        canal(CANAL_A),
        // Já pausado à mão ANTES da janela: a agenda não toma posse dele.
        canal(CANAL_B, { disabled: true, disabled_by: "manual" }),
      ],
    });

    const resumo = await aplicarAgendas(db as never, new Date("2026-10-10T03:00:00Z"));

    expect(resumo.pausadas).toBe(1);
    expect(captura.rpc).toHaveLength(1);
    // O cron chama a PEÇA em que a RPC da tela delega (`fn_definir_canal_desativado`
    // continua com os mesmos três argumentos e origem `manual`): mesma escrita,
    // um só caminho de estado.
    expect(captura.rpc[0]).toMatchObject({
      nome: "fn_definir_pausa_de_canal",
      p_org: ORG,
      p_canal: CANAL_A,
      p_desativado: true,
      p_origem: "schedule",
      p_agenda: AGENDA,
    });
    expect(agendas[0]).toMatchObject({ status: "running", paused_channel_ids: [CANAL_A] });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.disabled",
        organizationId: ORG,
        resourceId: CANAL_A,
        metadata: expect.objectContaining({ disabled: true, agenda_id: AGENDA }),
      }),
    );
  });

  it("no fim retoma SÓ o que a agenda pausou — a pausa manual da janela permanece", async () => {
    const agendas = [agenda({ status: "running", paused_channel_ids: [CANAL_A] })];
    const db = fazerDb({
      agendas,
      canais: [
        // Pausado pela própria agenda, e...
        canal(CANAL_A, { disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA }),
        // ...quem o operador pausou DURANTE a janela fica pausado.
        canal(CANAL_B, { disabled: true, disabled_by: "manual" }),
      ],
    });

    const resumo = await aplicarAgendas(db as never, new Date("2026-10-10T05:00:00Z"));

    expect(resumo.retomadas).toBe(1);
    expect(captura.rpc).toHaveLength(1);
    expect(captura.rpc[0]).toMatchObject({
      p_canal: CANAL_A,
      p_desativado: false,
      p_origem: "schedule",
      p_agenda: AGENDA,
    });
    expect(agendas[0]).toMatchObject({ status: "done", paused_channel_ids: [] });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.enabled", resourceId: CANAL_A }),
    );
    expect(captura.rpc.map((r) => r.p_canal)).not.toContain(CANAL_B);
  });

  it("janela perdida: não pausa depois do fim e encerra a agenda", async () => {
    const agendas = [agenda()];
    const db = fazerDb({ agendas, canais: [canal(CANAL_A)] });

    const resumo = await aplicarAgendas(db as never, new Date("2026-10-10T06:00:00Z"));

    expect(resumo.expiradas).toBe(1);
    expect(captura.rpc).toHaveLength(0);
    expect(agendas[0]).toMatchObject({ status: "done" });
  });

  it("organização parada não é tocada", async () => {
    const agendas = [agenda()];
    const db = fazerDb({ agendas, canais: [canal(CANAL_A)], orgsParadas: [ORG] });

    await aplicarAgendas(db as never, new Date("2026-10-10T03:00:00Z"));

    expect(captura.rpc).toHaveLength(0);
    expect(captura.updates).toHaveLength(0);
    expect(agendas[0]).toMatchObject({ status: "scheduled" });
  });

  it("pausar e retomar pela janela abre e fecha o aviso da Central (#2389), como a pausa manual", async () => {
    const agendas = [agenda()];
    const db = fazerDb({ agendas, canais: [canal(CANAL_A)] });
    const inicio = new Date("2026-10-10T03:00:00Z");

    await aplicarAgendas(db as never, inicio);

    expect(sincronizarAvisoDePausa).toHaveBeenCalledTimes(1);
    expect(sincronizarAvisoDePausa).toHaveBeenCalledWith(
      db,
      { id: CANAL_A, organization_id: ORG },
      expect.objectContaining({ agora: inicio, autor: expect.stringContaining("janela") }),
    );

    vi.mocked(sincronizarAvisoDePausa).mockClear();
    const dbFim = fazerDb({
      agendas: [agenda({ status: "running", paused_channel_ids: [CANAL_A] })],
      canais: [canal(CANAL_A, { disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA })],
    });
    await aplicarAgendas(dbFim as never, new Date("2026-10-10T05:00:00Z"));

    expect(sincronizarAvisoDePausa).toHaveBeenCalledTimes(1);
    expect(sincronizarAvisoDePausa).toHaveBeenCalledWith(
      dbFim,
      { id: CANAL_A, organization_id: ORG },
      expect.objectContaining({ agora: new Date("2026-10-10T05:00:00Z") }),
    );
  });

  it("janelas sobrepostas: o fim da primeira não religa o canal — a posse passa à que segue aberta", async () => {
    // A: 03h–05h pausou o canal. B: 04h–06h abriu com ele já pausado (não tomou posse).
    const agendas = [
      agenda({ status: "running", paused_channel_ids: [CANAL_A] }),
      agenda({
        id: AGENDA_2,
        status: "running",
        starts_at: "2026-10-10T04:00:00.000Z",
        ends_at: "2026-10-10T06:00:00.000Z",
      }),
    ];
    const db = fazerDb({
      agendas,
      canais: [canal(CANAL_A, { disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA })],
    });

    const resumo = await aplicarAgendas(db as never, new Date("2026-10-10T05:00:00Z"));

    // Segue pausado, agora em nome de B — é o fim de B que retoma.
    expect(captura.rpc).toEqual([
      expect.objectContaining({ p_canal: CANAL_A, p_desativado: true, p_origem: "schedule", p_agenda: AGENDA_2 }),
    ]);
    expect(resumo).toMatchObject({ retomadas: 0, transferidas: 1, encerradas: 1 });
    expect(agendas[0]).toMatchObject({ status: "done" });
    // Nada mudou no canal: nem aviso da Central, nem linha de retomada na trilha.
    expect(sincronizarAvisoDePausa).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    // E no fim de B o canal volta.
    captura.rpc = [];
    const dbFimB = fazerDb({
      agendas: [agendas[1]!],
      canais: [canal(CANAL_A, { disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA_2 })],
    });
    const fimB = await aplicarAgendas(dbFimB as never, new Date("2026-10-10T06:00:00Z"));
    expect(fimB.retomadas).toBe(1);
    expect(captura.rpc).toEqual([expect.objectContaining({ p_canal: CANAL_A, p_desativado: false })]);
  });

  it("janela de OUTRO canal aberta não segura a retomada deste", async () => {
    const agendas = [
      agenda({ status: "running", paused_channel_ids: [CANAL_A] }),
      agenda({ id: AGENDA_2, status: "running", channel_session_id: CANAL_B, ends_at: "2026-10-10T06:00:00.000Z" }),
    ];
    const db = fazerDb({
      agendas,
      canais: [canal(CANAL_A, { disabled: true, disabled_by: "schedule", disabled_schedule_id: AGENDA })],
    });

    const resumo = await aplicarAgendas(db as never, new Date("2026-10-10T05:00:00Z"));

    expect(resumo).toMatchObject({ retomadas: 1, transferidas: 0 });
    expect(captura.rpc).toEqual([expect.objectContaining({ p_canal: CANAL_A, p_desativado: false })]);
  });

  it("sem segredo nenhum o cron não roda (fail-closed)", async () => {
    const db = fazerDb({ agendas: [] });
    vi.mocked(createAdminClient).mockReturnValue(db as never);

    const r = await GET(new NextRequest("http://localhost/x"));
    expect(r.status).toBe(403);
    expect(captura.rpc).toHaveLength(0);
  });
});

describe("fuso da organização na janela (critério 7)", () => {
  // Janela de 23:30 (03/nov) a 02:30 (04/nov) em São Paulo, atravessando a
  // virada do horário de verão de 2018-11-04 (00:00 → 01:00: a hora não existe).
  const FUSO = "America/Sao_Paulo";
  const inicio = instanteDe({ ano: 2018, mes: 11, dia: 3, hora: 23, minuto: 30 }, FUSO);
  const fim = instanteDe({ ano: 2018, mes: 11, dia: 4, hora: 2, minuto: 30 }, FUSO);

  it("o instante final é o daquele fuso e não o de ler a hora como UTC", () => {
    // DESIGUALDADE explícita contra o relógio "ingênuo": se a conversão usasse
    // UTC fixo, os dois iguais provavam nada.
    expect(fim.getTime()).not.toBe(Date.UTC(2018, 10, 4, 2, 30));
    expect(inicio.getTime()).not.toBe(Date.UTC(2018, 10, 3, 23, 30));
    // 3h de relógio de parede viram 2h reais: uma hora foi pulada no meio.
    expect(fim.getTime() - inicio.getTime()).toBe(2 * 3_600_000);
  });

  it("a regra retoma exatamente no instante de fim da janela, não antes", () => {
    const janela = {
      starts_at: inicio.toISOString(),
      ends_at: fim.toISOString(),
      status: "running" as const,
    };
    expect(acaoDaAgenda(janela, new Date(fim.getTime() - 60_000))).toBe("nada");
    expect(acaoDaAgenda(janela, fim)).toBe("retomar");
  });
});

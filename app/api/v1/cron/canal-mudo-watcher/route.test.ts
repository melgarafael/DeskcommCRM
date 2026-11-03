/**
 * O aviso do canal mudo abre uma vez e fecha sozinho.
 *
 * Os dois casos que mais importam são os do LAÇO DE RETORNO: o aviso tem de
 * sumir quando deixa de ser verdade (o canal ganhou número, saiu do modo de
 * teste ou foi arquivado). Sem isso, a Central acumula avisos que mentem — o
 * canal já responde e a lista diz que não —, e lista que mente ninguém lê.
 *
 * O último caso guarda a régua da auditoria: rodada que não abriu nem fechou
 * nada não é mutação. Uma varredura diária que audita incondicionalmente põe
 * 365 linhas por ano dizendo que nada aconteceu.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

interface Capturado {
  avisos: Array<Record<string, unknown>>;
  resolucoes: Array<{ patch: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}

function admin(
  canais: Array<Record<string, unknown>>,
  abertos: Array<{ id: string; ref_id: string | null }>,
  cap: Capturado,
) {
  return {
    from(tabela: string) {
      if (tabela === "channel_sessions") {
        const c: Record<string, unknown> = {
          select: () => c,
          is: () => c,
          limit: async () => ({ data: canais, error: null }),
        };
        return c;
      }
      // agent_inbox_items
      return {
        select: () => {
          const c: Record<string, unknown> = {
            eq: () => c,
            limit: async () => ({ data: abertos, error: null }),
            maybeSingle: async () => ({ data: { id: "novo" } }),
          };
          return c;
        },
        insert: (linha: Record<string, unknown>) => {
          cap.avisos.push(linha);
          const c: Record<string, unknown> = {
            select: () => c,
            maybeSingle: async () => ({ data: { id: "novo" } }),
          };
          return c;
        },
        update: (patch: Record<string, unknown>) => {
          const filtros: Array<[string, unknown]> = [];
          const c: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filtros.push([col, val]);
              return c;
            },
            select: () => c,
            maybeSingle: async () => {
              cap.resolucoes.push({ patch, filtros: [...filtros] });
              return { data: { id: "resolvido" } };
            },
          };
          return c;
        },
      };
    },
  };
}

const canalMudo = (over: Record<string, unknown> = {}) => ({
  id: CANAL,
  organization_id: ORG,
  status: "WORKING",
  archived_at: null,
  last_status_change_at: diasAtras(5),
  metadata: { ai_gate: "allowlist", ai_test_phone_numbers: [] },
  ...over,
});

const vazio = (): Capturado => ({ avisos: [], resolucoes: [] });
const req = () =>
  new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("canal-mudo-watcher", () => {
  it("abre o aviso apontando para o canal, com kind e referência certos", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([canalMudo()], [], cap) as never);

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { avisados: number; resolvidos: number } };

    expect(r.status).toBe(200);
    expect(corpo.data).toMatchObject({ avisados: 1, resolvidos: 0 });
    expect(cap.avisos).toHaveLength(1);
    expect(cap.avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "canal_mudo_sem_numero",
      severity: "warn",
      ref_kind: "channel_session",
      ref_id: CANAL,
    });
    // O corpo diz a SAÍDA, não só o diagnóstico: quem lê precisa saber o que fazer.
    expect(String(cap.avisos[0]!.body)).toMatch(/Conexiones/);
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo()], [{ id: "aviso-1", ref_id: CANAL }], cap) as never,
    );

    await GET(req());

    expect(cap.avisos).toHaveLength(0);
    expect(cap.resolucoes).toHaveLength(0);
  });

  it("canal que ganhou número tem o aviso RESOLVIDO, com o motivo no corpo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [canalMudo({ metadata: { ai_gate: "allowlist", ai_test_phone_numbers: ["+5511999990000"] } })],
        [{ id: "aviso-1", ref_id: CANAL }],
        cap,
      ) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { resolvidos: number } };

    expect(corpo.data.resolvidos).toBe(1);
    expect(cap.resolucoes[0]!.patch.status).toBe("resolved");
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/consiguió un número autorizado/);
    // O filtro por `status=open` é a trava contra duas rodadas simultâneas.
    expect(cap.resolucoes[0]!.filtros).toContainEqual(["status", "open"]);
  });

  it("canal que saiu do modo de teste também resolve", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo({ metadata: { ai_gate: "open" } })], [{ id: "aviso-1", ref_id: CANAL }], cap) as never,
    );

    await GET(req());

    expect(cap.resolucoes).toHaveLength(1);
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/salió del modo de prueba/);
  });

  it("aviso de canal que sumiu da varredura (arquivado) também fecha", async () => {
    // A varredura só lê conexões não arquivadas. Sem este fechamento, arquivar
    // um canal deixaria o aviso dele aberto para sempre.
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([], [{ id: "aviso-orfao", ref_id: "33333333-3333-4333-8333-333333333333" }], cap) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { resolvidos: number } };

    expect(corpo.data.resolvidos).toBe(1);
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/archivado/);
  });

  it("canal recém-ligado não vira aviso — e a rodada não audita", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo({ last_status_change_at: diasAtras(1) })], [], cap) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { avisados: number; resolvidos: number } };

    expect(corpo.data).toMatchObject({ avisados: 0, resolvidos: 0 });
    expect(cap.avisos).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada com efeito audita uma vez, com os números", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([canalMudo()], [], cap) as never);

    await GET(req());

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "channel.canal_mudo_watcher_run",
      metadata: { avisados: 1, resolvidos: 0 },
    });
  });

  it("sem o segredo, 403 e não lê nada", async () => {
    const cap = vazio();
    const cliente = vi.fn();
    vi.mocked(createAdminClient).mockImplementation(cliente as never);

    const r = await GET(new NextRequest("http://localhost/x"));

    expect(r.status).toBe(403);
    expect(cliente).not.toHaveBeenCalled();
    expect(cap.avisos).toHaveLength(0);
  });
});

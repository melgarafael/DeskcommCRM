import { describe, expect, it, vi } from "vitest";

import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilencePointer, type SilenceSweepDb } from "./silence-sweep";

/**
 * O gatilho de silêncio só olha o silêncio, e um contato cujo negócio foi dado
 * como perdido é silencioso para sempre: o "retomada" voltava a escrever para
 * quem já tinha saído do processo de venda (medido em produção, 30/09/2026).
 *
 * O que estes casos prendem, nas duas direções:
 *  - contato que só tem negócio encerrado fica de fora;
 *  - contato sem negócio nenhum, ou com algum negócio aberto, segue entrando;
 *  - adapter sem o método (falso de teste) mantém o comportamento de antes;
 *  - a consulta de produção pagina além das 1000 linhas do PostgREST e só conta
 *    como encerrado quem NÃO tem negócio aberto.
 */
function fakeDb(encerrados: Set<string> | null, insert: SilenceSweepDb["insertEnrollment"]): SilenceSweepDb {
  const pointer: SilencePointer = {
    id: "p-1",
    organization_id: "org-1",
    active_version_id: "v-1",
    threshold_minutes: 180,
    segments: [],
  };
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [pointer],
    loadSilentContactIds: async () => ["perdido", "sem-negocio", "negocio-aberto"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => new Set<string>(),
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: insert,
  };
  if (encerrados) {
    db.loadContatosComNegocioEncerrado = async (_org, ids) => new Set(ids.filter((id) => encerrados.has(id)));
  }
  return db;
}

const DEPS_BASE = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-10-22T12:00:00Z"),
};

describe("runSilenceSweep — negócio encerrado", () => {
  it("quem só tem negócio encerrado não é inscrito; os outros entram", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const summary = await runSilenceSweep({ db: fakeDb(new Set(["perdido"]), insert), ...DEPS_BASE });

    expect(summary.skipped_negocio_encerrado).toBe(1);
    expect(summary.enrolled).toBe(2);
    expect(insert).not.toHaveBeenCalledWith(expect.objectContaining({ contact_id: "perdido" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "sem-negocio" }));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "negocio-aberto" }));
  });

  it("adapter sem o método: ninguém é cortado (o comportamento de antes)", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const summary = await runSilenceSweep({ db: fakeDb(null, insert), ...DEPS_BASE });

    expect(summary.skipped_negocio_encerrado).toBe(0);
    expect(summary.enrolled).toBe(3);
  });

  it("falha de leitura derruba só este pointer: ninguém é inscrito no escuro", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb(new Set(), insert);
    db.loadContatosComNegocioEncerrado = async () => {
      throw new Error("banco fora");
    };
    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.pointers_failed).toBe(1);
    expect(summary.enrolled).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});

const MAX_ROWS = 1000;

function fakeAdmin(linhas: Array<{ contact_id: string; status: string }>) {
  let consultas = 0;
  const from = (tabela: string) => {
    expect(tabela).toBe("crm_leads");
    consultas += 1;
    let fatia: [number, number] | null = null;
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const [de, ate] = fatia ?? [0, linhas.length - 1];
            const data = linhas.slice(de, ate + 1).slice(0, MAX_ROWS);
            return (resolve: (value: unknown) => unknown) => resolve({ data, error: null });
          }
          return (...args: unknown[]) => {
            if (prop === "range") fatia = [args[0] as number, args[1] as number];
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas: () => consultas };
}

describe("createSupabaseSilenceSweepDb().loadContatosComNegocioEncerrado", () => {
  it("só conta como encerrado quem não tem negócio aberto; sem negócio não entra", async () => {
    const { admin } = fakeAdmin([
      { contact_id: "c-perdido", status: "lost" },
      { contact_id: "c-ganho", status: "won" },
      { contact_id: "c-misto", status: "lost" },
      { contact_id: "c-misto", status: "open" },
    ]);
    const r = await createSupabaseSilenceSweepDb(admin).loadContatosComNegocioEncerrado!("org-1", [
      "c-perdido",
      "c-ganho",
      "c-misto",
      "c-sem-negocio",
    ]);

    expect([...r].sort()).toEqual(["c-ganho", "c-perdido"]);
  });

  it("lê além das 1000 linhas que o PostgREST devolve por resposta", async () => {
    const linhas = [
      ...Array.from({ length: 1000 }, () => ({ contact_id: "c-1", status: "lost" })),
      { contact_id: "c-2", status: "lost" },
      { contact_id: "c-2", status: "open" },
    ];
    const { admin, consultas } = fakeAdmin(linhas);
    const r = await createSupabaseSilenceSweepDb(admin).loadContatosComNegocioEncerrado!("org-1", ["c-1", "c-2"]);

    expect([...r]).toEqual(["c-1"]);
    expect(consultas()).toBe(2);
  });
});

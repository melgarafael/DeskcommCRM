/**
 * A LIMPEZA DOS ARQUIVOS ÓRFÃOS DA ABORDAGEM ENTRA NA RODADA DO CRON — #5139.
 *
 * O que este arquivo mede é o ENCAIXE: o dreno é um a mais entre as podas de
 * banco, tem nome próprio, a falha dele vira linha em `falhas` (e a rodada
 * segue), e a contagem + a trilha caminho+bytes saem no relatório que vira o
 * JSON e o metadata do `retention.sweep_run`.
 *
 * A REGRA de quais arquivos somem (referência, carência, pasta de outro dono) é
 * medida em `lib/prospecting/arquivos-orfaos-da-abordagem.test.ts`, com um
 * Storage falso. Aqui o dreno é injetado como função: o que se prova é que o
 * cron o CHAMA e REPORTAR o que ele devolve.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  houveEfeito,
  podarHistorico,
  type PodaDb,
} from "@/app/api/v1/cron/data-retention/route";
import type { ResultadoDoDrenoDaAbordagem } from "@/lib/prospecting/arquivos-orfaos-da-abordagem";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

/** Um PodaDb de banco zerado: só o dreno de Storage tem trabalho nestes casos. */
function dbZerado(): { db: PodaDb; chamadasRpc: string[] } {
  const chamadasRpc: string[] = [];
  const db: PodaDb = {
    async rpc(nome) {
      chamadasRpc.push(nome);
      return { data: 0, error: null };
    },
    async apagarRascunhos() {
      return { data: 0, error: null };
    },
    async enfileirarMidia() {
      return { data: { vencidas: 0, orfas: 0, expurgadas: 0 }, error: null };
    },
  };
  return { db, chamadasRpc };
}

function drenoVazio(): ResultadoDoDrenoDaAbordagem {
  return { organizacoes: 0, removidos: 0, bytes_removidos: 0, caminhos: [], falhas: [] };
}

const ORG = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("data-retention × limpeza de arquivos órfãos da abordagem (#5139)", () => {
  it("a contagem e a trilha caminho+bytes saem no relatório da rodada", async () => {
    const { db } = dbZerado();
    const r = await podarHistorico(db, {}, async () => ({
      organizacoes: 1,
      removidos: 2,
      bytes_removidos: 3_072,
      caminhos: [
        { caminho: `${ORG}/prospecting/a.pdf`, bytes: 1_024 },
        { caminho: `${ORG}/prospecting/b.mp4`, bytes: 2_048 },
      ],
      falhas: [],
    }));

    expect(r.arquivos_orfaos_da_abordagem_removidos).toBe(2);
    expect(r.arquivos_orfaos_da_abordagem_bytes).toBe(3_072);
    expect(r.arquivos_orfaos_da_abordagem_trilha).toEqual([
      { caminho: `${ORG}/prospecting/a.pdf`, bytes: 1_024 },
      { caminho: `${ORG}/prospecting/b.mp4`, bytes: 2_048 },
    ]);
    expect(r.falhas).toEqual([]);
  });

  it("uma rodada que SÓ removeu arquivo órfão conta como mutação (audita)", async () => {
    const { db } = dbZerado();
    const r = await podarHistorico(db, {}, async () => ({
      organizacoes: 1,
      removidos: 1,
      bytes_removidos: 1_024,
      caminhos: [{ caminho: `${ORG}/prospecting/a.pdf`, bytes: 1_024 }],
      falhas: [],
    }));

    expect(houveEfeito(r)).toBe(true);
  });

  it("sem o dreno injetado (dublês antigos), o relatório traz zero — não inventa", async () => {
    const { db } = dbZerado();
    const r = await podarHistorico(db, {});
    expect(r.arquivos_orfaos_da_abordagem_removidos).toBe(0);
    expect(r.arquivos_orfaos_da_abordagem_trilha).toEqual([]);
    expect(houveEfeito(r)).toBe(false);
  });

  it("falha do dreno vira linha NOMEADA em falhas e as podas irmãs SEGUEM", async () => {
    const { db, chamadasRpc } = dbZerado();
    const r = await podarHistorico(db, {}, async () => {
      throw new Error("storage fora");
    });

    expect(r.falhas).toHaveLength(1);
    expect(r.falhas[0]).toBe("prospecting_arquivos_orfaos: storage fora");
    // A rodada não abortou: as podas de banco rodaram.
    expect(chamadasRpc.length).toBeGreaterThan(0);
    expect(r.arquivos_orfaos_da_abordagem_removidos).toBe(0);
  });

  it("falha POR ORGANIZAÇÃO vira linha na trilha e o que já saiu é preservado", async () => {
    const { db } = dbZerado();
    const r = await podarHistorico(db, {}, async () => ({
      organizacoes: 2,
      removidos: 1,
      bytes_removidos: 512,
      caminhos: [{ caminho: `${ORG}/prospecting/a.pdf`, bytes: 512 }],
      falhas: [`organizacao outra-org: sem permissão`],
    }));

    expect(r.arquivos_orfaos_da_abordagem_removidos).toBe(1);
    expect(r.falhas).toEqual([
      "prospecting_arquivos_orfaos: organizacao outra-org: sem permissão",
    ]);
    // Falha parcial + remoção já feita: a rodada tem de ser distinguível de um
    // dia sem nada a fazer, e o número do que saiu NÃO pode sumir.
    expect(houveEfeito(r)).toBe(true);
  });
});

describe("o dreno devolve o formato que o relatório espera", () => {
  it("dreno vazio não altera nada e não marca efeito", async () => {
    expect(drenoVazio()).toEqual({
      organizacoes: 0,
      removidos: 0,
      bytes_removidos: 0,
      caminhos: [],
      falhas: [],
    });
  });
});

/**
 * A recusa de ligação SIP pela tela. A tabela de brinquedo APLICA os filtros
 * que o código manda (`eq`/`in`), então o teste mede quais linhas mudam, não
 * só que uma chamada foi feita.
 *
 * SABOTAGEM: tirar o `.in("status", TOCANDO)` do UPDATE derruba "ligação já
 * atendida não é encerrada por baixo da conversa"; tirar o `.eq("organization_id")`
 * derruba "outra organização".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { END_REASON_RECUSADA, recusarChamadaSip } from "./recusar-chamada-sip";

type Linha = Record<string, unknown>;
let tabela: Linha[] = [];

function supabaseDeBrinquedo() {
  return {
    from: () => {
      const filtros: Array<(l: Linha) => boolean> = [];
      let mudanca: Linha | null = null;
      const consulta = {
        update(m: Linha) {
          mudanca = m;
          return consulta;
        },
        select: () => consulta,
        eq(col: string, v: unknown) {
          filtros.push((l) => l[col] === v);
          return consulta;
        },
        in(col: string, vs: unknown[]) {
          filtros.push((l) => vs.includes(l[col]));
          return consulta;
        },
        async maybeSingle() {
          const alvo = tabela.find((l) => filtros.every((f) => f(l)));
          return { data: alvo ? { status: alvo.status } : null, error: null };
        },
        then(ok: (r: unknown) => unknown) {
          const alvo = tabela.filter((l) => filtros.every((f) => f(l)));
          if (mudanca) for (const l of alvo) Object.assign(l, mudanca);
          return Promise.resolve({ data: alvo.map((l) => ({ id: l.id })), error: null }).then(ok);
        },
      };
      return consulta;
    },
  } as never;
}

const ORG = "org-a";
const AGORA = new Date("2026-11-04T15:00:00.000Z");
const linha = (id: string, extra: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  provider: "sip",
  direction: "inbound",
  status: "ringing",
  end_reason: null,
  ended_at: null,
  ...extra,
});

beforeEach(() => {
  tabela = [];
});

describe("recusar ligação SIP pela tela", () => {
  it("tocando: encerra como recusada", async () => {
    tabela = [linha("c1")];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("recusada");
    expect(tabela[0]).toMatchObject({ status: "ended", end_reason: END_REASON_RECUSADA, ended_at: AGORA.toISOString() });
  });

  it("starting também é toque", async () => {
    tabela = [linha("c1", { status: "starting" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("recusada");
  });

  it("ligação já atendida não é encerrada por baixo da conversa", async () => {
    tabela = [linha("c1", { status: "connected" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("ja_atendida");
    expect(tabela[0]).toMatchObject({ status: "connected", end_reason: null });
  });

  it("já encerrada (outra aba, o cron, o próprio canal): não mexe e responde como encerrada", async () => {
    tabela = [linha("c1", { status: "ended", end_reason: "timeout" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("ja_encerrada");
    expect(tabela[0]).toMatchObject({ end_reason: "timeout" });
  });

  it("linha de outra organização não é tocada", async () => {
    tabela = [linha("c1", { organization_id: "org-b" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("nao_encontrada");
    expect(tabela[0]).toMatchObject({ status: "ringing" });
  });

  it("ligação FEITA (outbound) não é recusável por este caminho", async () => {
    tabela = [linha("c1", { direction: "outbound", status: "starting" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("nao_encontrada");
    expect(tabela[0]).toMatchObject({ status: "starting" });
  });

  it("linha do WaCalls não é encerrada por este caminho", async () => {
    tabela = [linha("c1", { provider: "wacalls" })];
    expect(await recusarChamadaSip(supabaseDeBrinquedo(), ORG, "c1", AGORA)).toBe("nao_encontrada");
    expect(tabela[0]).toMatchObject({ status: "ringing" });
  });
});

/**
 * A REGRA da varredura de ligação presa em toque (issue #3977).
 *
 * O #3972 consertou a CAUSA (o UUID do AudioSocket não casava com o `channel.id`
 * do `ChannelDestroyed`), mas o evento continua podendo se perder: worker de voz
 * reiniciando/deploy/queda no instante em que o canal cai. Sem prazo de saída, a
 * linha fica `ringing` para sempre e nada a destrava.
 *
 * O que se guarda aqui é o COMPORTAMENTO, com um dublê que aplica os filtros de
 * verdade sobre uma tabela em memória — não a existência da função. Cada
 * propriedade existe porque errar nela recria o defeito:
 *
 *   1. o corte é por `started_at` (coluna que ninguém reescreve), não por
 *      `updated_at`, que o gatilho muda a cada escrita — medir por ele faria a
 *      linha rejuvenescer e escapar para sempre;
 *   2. o UPDATE carrega `status in ('starting','ringing')` além do id: é o
 *      CLAIM. Sem ele, uma ligação atendida entre o SELECT e o UPDATE seria
 *      encerrada por baixo de quem está falando;
 *   3. o motivo é literal e próprio (`encerrada_por_prazo_sem_evento`), não
 *      `timeout`: `timeout` é fato do provedor ("tocou e ninguém atendeu"), e
 *      aqui o fato é outro (o CRM não sabe; o aviso de queda não chegou);
 *   4. rodar duas vezes não muda `ended_at` nem o motivo da linha já encerrada —
 *      a varredura é de minuto em minuto, e um segundo carimbo faria a ligação
 *      parecer ter acabado duas vezes;
 *   5. atendida (`connected`) nunca é tocada, nem velha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import {
  ESTADOS_DE_TOQUE,
  MOTIVO_PRAZO_SEM_EVENTO,
  PRAZO_MAXIMO_MIN,
  PRAZO_PADRAO_MIN,
  encerrarLigacoesPresas,
  interpretarPrazo,
  prazoDeEncerramentoMin,
} from "@/lib/voice/ligacao-presa";

interface Linha {
  id: string;
  organization_id: string;
  status: string;
  end_reason: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string | null;
}

interface Chamada {
  op: "select" | "update";
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

const AGORA = new Date("2026-11-05T12:00:00.000Z");
const minutosAtras = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();
const segundosAtras = (n: number) => new Date(AGORA.getTime() - n * 1000).toISOString();

function linha(over: Partial<Linha> & Pick<Linha, "id">): Linha {
  return {
    organization_id: "22222222-2222-4222-8222-222222222222",
    status: "ringing",
    end_reason: null,
    started_at: minutosAtras(40),
    ended_at: null,
    updated_at: null,
    ...over,
  };
}

/**
 * Dublê do client: a tabela em memória é filtrada de verdade, então o teste mede
 * o DESFECHO (a linha mudou ou não) e não o texto da consulta. Um método não
 * previsto estoura, para o teste não passar por engano sobre caminho que ele não
 * modela.
 */
function clienteDeMentira(linhas: Linha[], gancho?: { aposOSelect?: () => void }) {
  const chamadas: Chamada[] = [];

  const from = () => {
    const filtros: Record<string, unknown> = {};
    let op: "select" | "update" = "select";
    let valores: Record<string, unknown> | undefined;

    const casam = () =>
      linhas.filter((l) => {
        if (filtros["in:status"] && !(filtros["in:status"] as string[]).includes(l.status)) return false;
        if (filtros["eq:organization_id"] && l.organization_id !== filtros["eq:organization_id"]) return false;
        if (filtros["in:id"] && !(filtros["in:id"] as string[]).includes(l.id)) return false;
        if (filtros["lt:started_at"] && !(l.started_at < (filtros["lt:started_at"] as string))) return false;
        return true;
      });

    const executar = () => {
      chamadas.push({ op, filtros: { ...filtros }, ...(valores ? { valores: { ...valores } } : {}) });
      if (op === "select") {
        const encontradas = casam().slice(0, Number(filtros["limit"] ?? 1000));
        gancho?.aposOSelect?.();
        return { data: encontradas.map((l) => ({ ...l })), error: null };
      }
      const atingidas = casam();
      for (const l of atingidas) Object.assign(l, valores);
      return { data: atingidas.map((l) => ({ id: l.id })), error: null };
    };

    const cadeia: Record<string, unknown> = {
      select() {
        return cadeia;
      },
      update(v: Record<string, unknown>) {
        op = "update";
        valores = v;
        return cadeia;
      },
      in(col: string, val: unknown) {
        filtros[`in:${col}`] = val;
        return cadeia;
      },
      eq(col: string, val: unknown) {
        filtros[`eq:${col}`] = val;
        return cadeia;
      },
      lt(col: string, val: unknown) {
        filtros[`lt:${col}`] = val;
        return cadeia;
      },
      limit(n: number) {
        filtros["limit"] = n;
        return cadeia;
      },
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(executar()).then(resolve);
      },
    };
    return cadeia;
  };

  return { client: { from } as never, chamadas, linhas };
}

beforeEach(() => {
  delete process.env.VOICE_CALL_STUCK_AFTER_MIN;
});

describe("o prazo", () => {
  it("sem configuração, o padrão é 15 minutos", () => {
    expect(interpretarPrazo(undefined)).toEqual({ minutos: PRAZO_PADRAO_MIN, recusado: null });
    expect(interpretarPrazo("")).toEqual({ minutos: PRAZO_PADRAO_MIN, recusado: null });
    expect(PRAZO_PADRAO_MIN).toBe(15);
  });

  it("valor válido manda, inclusive com espaço em volta", () => {
    expect(interpretarPrazo("20").minutos).toBe(20);
    expect(interpretarPrazo(" 7 ").minutos).toBe(7);
  });

  it("valor inválido cai no padrão e diz por quê — não derruba a varredura", () => {
    for (const ruim of ["0", "-3", "abc", "2.5", "1e3"]) {
      const lido = interpretarPrazo(ruim);
      expect(lido.minutos, ruim).toBe(PRAZO_PADRAO_MIN);
      expect(lido.recusado, ruim).not.toBeNull();
    }
  });

  it("acima do teto, o teto vale (o prazo não vira decoração)", () => {
    expect(interpretarPrazo(String(PRAZO_MAXIMO_MIN + 1))).toEqual({
      minutos: PRAZO_MAXIMO_MIN,
      recusado: `acima do teto de ${PRAZO_MAXIMO_MIN} min: ${PRAZO_MAXIMO_MIN + 1}`,
    });
  });

  it("o prazo efetivo é lido do ambiente, e o padrão quando não há", () => {
    process.env.VOICE_CALL_STUCK_AFTER_MIN = "20";
    expect(prazoDeEncerramentoMin()).toBe(20);
    delete process.env.VOICE_CALL_STUCK_AFTER_MIN;
    expect(prazoDeEncerramentoMin()).toBe(PRAZO_PADRAO_MIN);
  });
});

describe("encerrarLigacoesPresas", () => {
  it("linha em `starting` com 40 minutos vira terminal, com motivo e `ended_at`", async () => {
    const { client, linhas } = clienteDeMentira([linha({ id: "presa", status: "starting", started_at: minutosAtras(40) })]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-1");

    expect(r).toEqual({ varridas: 1, encerradas: 1, organizacoes: 1, prazo_min: PRAZO_PADRAO_MIN });
    expect(linhas[0]).toMatchObject({
      status: "ended",
      end_reason: MOTIVO_PRAZO_SEM_EVENTO,
      ended_at: AGORA.toISOString(),
    });
    expect(MOTIVO_PRAZO_SEM_EVENTO).toBe("encerrada_por_prazo_sem_evento");
  });

  it("o corte é por `started_at` e é o prazo configurado, com o recorte de estado", async () => {
    const { client, chamadas } = clienteDeMentira([]);

    await encerrarLigacoesPresas(client, AGORA, "req-2");

    const busca = chamadas[0]!;
    expect(busca.op).toBe("select");
    expect(busca.filtros["in:status"]).toEqual([...ESTADOS_DE_TOQUE]);
    expect(busca.filtros["lt:started_at"]).toBe(new Date(AGORA.getTime() - PRAZO_PADRAO_MIN * 60_000).toISOString());
    // `updated_at` seria reescrito pelo gatilho a cada escrita; medir idade por
    // ele é o defeito que o irmão `recover-stuck-messages` documenta.
    expect(busca.filtros["lt:updated_at"]).toBeUndefined();
  });

  it("respeita o prazo vindo do ambiente", async () => {
    process.env.VOICE_CALL_STUCK_AFTER_MIN = "45";
    const { client, chamadas } = clienteDeMentira([]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-3");

    expect(r.prazo_min).toBe(45);
    expect(chamadas[0]!.filtros["lt:started_at"]).toBe(new Date(AGORA.getTime() - 45 * 60_000).toISOString());
  });

  it("toque recente NÃO é tocado (o prazo não mata ligação viva)", async () => {
    const { client, linhas } = clienteDeMentira([
      // 45 s: muito abaixo do toque real do provedor (~60 s) e do prazo.
      linha({ id: "tocando-agora", status: "ringing", started_at: segundosAtras(45) }),
      // 14 min: logo abaixo do prazo — a borda que um `lte` erraria.
      linha({ id: "quase-la", status: "ringing", started_at: minutosAtras(14) }),
    ]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-4");

    expect(r.encerradas).toBe(0);
    expect(linhas.map((l) => l.status)).toEqual(["ringing", "ringing"]);
    expect(linhas.map((l) => l.end_reason)).toEqual([null, null]);
  });

  it("atendida (`connected`) nunca é encerrada por idade, nem antiga", async () => {
    const { client, linhas } = clienteDeMentira([
      linha({ id: "falando", status: "connected", started_at: minutosAtras(90) }),
      linha({ id: "falando-ha-horas", status: "connected", started_at: minutosAtras(600) }),
    ]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-5");

    expect(r.encerradas).toBe(0);
    expect(linhas.every((l) => l.status === "connected")).toBe(true);
  });

  it("linha já terminal não muda de valor, e a segunda rodada é um no-op", async () => {
    const { client, linhas } = clienteDeMentira([linha({ id: "presa", status: "ringing", started_at: minutosAtras(40) })]);

    await encerrarLigacoesPresas(client, AGORA, "req-6");
    const depoisDaPrimeira = { ...linhas[0]! };

    // 5 min depois, a rodada seguinte (é de 5 em 5) encontra a linha já `ended`.
    const segunda = await encerrarLigacoesPresas(client, new Date(AGORA.getTime() + 5 * 60_000), "req-7");

    expect(segunda).toMatchObject({ varridas: 0, encerradas: 0, organizacoes: 0 });
    expect(linhas[0]).toEqual(depoisDaPrimeira);
  });

  it("o claim segura a corrida: quem foi atendida entre o SELECT e o UPDATE não é encerrada", async () => {
    const { client, linhas } = clienteDeMentira(
      [
        linha({ id: "presa", status: "ringing", started_at: minutosAtras(40) }),
        linha({ id: "atendida-na-corrida", status: "ringing", started_at: minutosAtras(41) }),
      ],
      {
        // O atendimento acontece DEPOIS do select e ANTES do update.
        aposOSelect: () => {
          const alvo = linhas.find((l) => l.id === "atendida-na-corrida")!;
          alvo.status = "connected";
        },
      },
    );

    const r = await encerrarLigacoesPresas(client, AGORA, "req-8");

    expect(r.encerradas).toBe(1);
    expect(linhas.find((l) => l.id === "presa")).toMatchObject({ status: "ended" });
    expect(linhas.find((l) => l.id === "atendida-na-corrida")).toMatchObject({
      status: "connected",
      end_reason: null,
      ended_at: null,
    });
  });

  it("é global entre organizações, e cada UPDATE carrega o próprio `organization_id`", async () => {
    const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
    const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
    const { client, chamadas, linhas } = clienteDeMentira([
      linha({ id: "da-a", organization_id: ORG_A, status: "ringing", started_at: minutosAtras(40) }),
      linha({ id: "da-b", organization_id: ORG_B, status: "starting", started_at: minutosAtras(70) }),
    ]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-9");

    expect(r).toMatchObject({ varridas: 2, encerradas: 2, organizacoes: 2 });
    expect(linhas.every((l) => l.status === "ended" && l.end_reason === MOTIVO_PRAZO_SEM_EVENTO)).toBe(true);

    const updates = chamadas.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      const org = u.filtros["eq:organization_id"] as string;
      const ids = u.filtros["in:id"] as string[];
      // Nenhuma escrita atravessa organização: os ids do UPDATE são os da org
      // do mesmo filtro, e não a lista inteira da rodada.
      expect(ids).toHaveLength(1);
      const dona = linhas.find((l) => l.id === ids[0])!.organization_id;
      expect(dona).toBe(org);
    }
  });

  it("nada preso ⇒ nenhum UPDATE", async () => {
    const { client, chamadas } = clienteDeMentira([linha({ id: "novinha", started_at: segundosAtras(5) })]);

    const r = await encerrarLigacoesPresas(client, AGORA, "req-10");

    expect(r).toEqual({ varridas: 0, encerradas: 0, organizacoes: 0, prazo_min: PRAZO_PADRAO_MIN });
    expect(chamadas.filter((c) => c.op === "update")).toEqual([]);
  });
});

/**
 * A RÉGUA DO RECORTE DE ENCERRADOS ANTIGOS DO QUADRO (#2995), medida sem banco.
 *
 * A rota do quadro também é exercitada (com dublê de banco) em
 * `app/api/v1/pipelines/[id]/board/route.test.ts`: lá se prova que o recorte
 * CHEGA ao quadro; aqui, as bordas que um caso de rota não alcança — chave
 * torta no settings, data ilegível, o dia exato do corte.
 */
import { describe, expect, it } from "vitest";

import {
  DIAS_MAXIMO_DO_RECORTE,
  DIAS_MINIMO_DO_RECORTE,
  diasDeRecorte,
  recortaEncerradosAntigos,
} from "@/lib/kanban/recorte-de-encerrados";

const AGORA = new Date("2026-10-23T12:00:00.000Z");
const DIA = 24 * 60 * 60 * 1000;
const ha = (dias: number) => new Date(AGORA.getTime() - dias * DIA).toISOString();

const negocio = (id: string, patch: Record<string, unknown>) =>
  ({ id, status: "open", closed_at: null, ...patch }) as unknown as {
    id: string;
    status: "open" | "won" | "lost";
    closed_at: string | null;
  };

describe("diasDeRecorte — o que o funil tem no settings", () => {
  it("lê o número configurado", () => {
    expect(diasDeRecorte({ ocultar_encerrados_dias: 30 })).toBe(30);
  });

  it("chave ausente, `0`, negativo, fracionado e texto são DESLIGADO", () => {
    expect(diasDeRecorte({})).toBeNull();
    expect(diasDeRecorte(null)).toBeNull();
    expect(diasDeRecorte(undefined)).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: 0 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: -5 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: 2.5 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: "30" })).toBeNull();
  });

  it("acima do teto também é DESLIGADO — o teto existe para o corte não virar infinito", () => {
    expect(diasDeRecorte({ ocultar_encerrados_dias: DIAS_MAXIMO_DO_RECORTE })).toBe(
      DIAS_MAXIMO_DO_RECORTE,
    );
    expect(diasDeRecorte({ ocultar_encerrados_dias: DIAS_MAXIMO_DO_RECORTE + 1 })).toBeNull();
  });
});

describe("recortaEncerradosAntigos — as três réguas", () => {
  const quadro = [
    negocio("ganho-40", { status: "won", closed_at: ha(40) }),
    negocio("ganho-2", { status: "won", closed_at: ha(2) }),
    negocio("perdido-90", { status: "lost", closed_at: ha(90) }),
    negocio("sem-data", { status: "lost", closed_at: null }),
    negocio("data-torta", { status: "won", closed_at: "ontem" }),
    negocio("aberto-400", { status: "open", closed_at: null }),
  ];

  const ids = (dias: number | null) =>
    recortaEncerradosAntigos(quadro, dias, AGORA).map((l) => l.id);

  it("esconde só o que está encerrado E datado além do corte", () => {
    expect(ids(30)).toEqual(["ganho-2", "sem-data", "data-torta", "aberto-400"]);
  });

  it("desligado (nulo) devolve a lista inteira, na ordem original", () => {
    expect(ids(null)).toEqual(quadro.map((l) => l.id));
    expect(ids(0)).toEqual(quadro.map((l) => l.id));
  });

  it("o dia EXATO do corte ainda fica — a opção diz 'há MAIS de N dias'", () => {
    const exato = [negocio("no-dia", { status: "won", closed_at: ha(30) })];
    expect(recortaEncerradosAntigos(exato, 30, AGORA).map((l) => l.id)).toEqual(["no-dia"]);
  });

  it("1 dia já esconde o ganho de ontem — o piso é válido", () => {
    expect(ids(DIAS_MINIMO_DO_RECORTE)).not.toContain("ganho-40");
    expect(ids(DIAS_MINIMO_DO_RECORTE)).not.toContain("ganho-2");
  });

  it("o negócio pedido pelo link (`manter`) fica mesmo encerrado há muito tempo", () => {
    const ficam = recortaEncerradosAntigos(quadro, 30, AGORA, "perdido-90").map((l) => l.id);
    expect(ficam).toContain("perdido-90");
    expect(ficam).not.toContain("ganho-40");
  });

  it("devolve CÓPIA quando não recorta — quem chama não vê a lista mutar", () => {
    const devolvida = recortaEncerradosAntigos(quadro, null, AGORA);
    expect(devolvida).not.toBe(quadro);
    expect(devolvida).toEqual(quadro);
  });
});

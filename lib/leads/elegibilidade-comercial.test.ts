/**
 * #4191 — a RÉGUA da elegibilidade comercial, sem banco.
 *
 * O defeito que estes casos fixam: o negócio não tinha como ser "não
 * comercial". A operação marcava perdido (inventando uma perda) ou apagava o
 * card (perdendo o histórico). O que se mede aqui é a decisão — quem está fora
 * do comercial, o que é motivo válido, o que é idempotente e o que é conflito —
 * e não a escrita, que tem teste próprio contra um cliente falso.
 */
import { describe, expect, it } from "vitest";

import {
  apenasComerciais,
  decidirClassificacao,
  decidirReversao,
  ehComercial,
  ehNaoComercial,
  MAX_MOTIVO_NAO_COMERCIAL,
  motivoParaATimeline,
  normalizarMotivoDoNaoComercial,
  recusaDoMotivoDoNaoComercial,
  type EstadoDaClassificacao,
} from "./elegibilidade-comercial";

const aberto = (extra: Partial<EstadoDaClassificacao> = {}): EstadoDaClassificacao => ({
  status: "open",
  nao_comercial_em: null,
  nao_comercial_motivo: null,
  ...extra,
});

describe("#4191 — quem está fora do comercial", () => {
  it("a coluna nula é comercial; a preenchida é não comercial", () => {
    expect(ehNaoComercial({ nao_comercial_em: null })).toBe(false);
    expect(ehNaoComercial({})).toBe(false);
    expect(ehNaoComercial(null)).toBe(false);
    expect(ehNaoComercial({ nao_comercial_em: "2026-11-06T12:00:00.000Z" })).toBe(true);
    // String vazia não é classificação: é dado sujo, e tratar como "fora do
    // comercial" esconderia o negócio do Radar por causa de um campo em branco.
    expect(ehNaoComercial({ nao_comercial_em: "   " })).toBe(false);
  });

  it("o inverso existe para o leitor não precisar de dupla negação", () => {
    expect(ehComercial({ nao_comercial_em: null })).toBe(true);
    expect(ehComercial({ nao_comercial_em: "2026-11-06T12:00:00.000Z" })).toBe(false);
  });

  it("o filtro de lista mantém a ordem e não mutila a linha", () => {
    const linhas = [
      { id: "a", nao_comercial_em: null },
      { id: "b", nao_comercial_em: "2026-11-06T12:00:00.000Z" },
      { id: "c", nao_comercial_em: null },
    ];
    expect(apenasComerciais(linhas).map((l) => l.id)).toEqual(["a", "c"]);
    expect(linhas).toHaveLength(3);
  });
});

describe("#4191 — o motivo", () => {
  it("normaliza para uma linha só e sem espaço sobrando", () => {
    expect(normalizarMotivoDoNaoComercial("  golpe \n  tentativa   de fraude ")).toBe(
      "golpe tentativa de fraude",
    );
    expect(normalizarMotivoDoNaoComercial("   ")).toBeNull();
    expect(normalizarMotivoDoNaoComercial(42)).toBeNull();
  });

  it("vazio, curto e longo são recusados com código próprio", () => {
    expect(recusaDoMotivoDoNaoComercial(null)?.codigo).toBe("motivo_obrigatorio");
    expect(recusaDoMotivoDoNaoComercial("  ")?.codigo).toBe("motivo_obrigatorio");
    expect(recusaDoMotivoDoNaoComercial("ok")?.codigo).toBe("motivo_curto");
    expect(recusaDoMotivoDoNaoComercial("x".repeat(MAX_MOTIVO_NAO_COMERCIAL + 1))?.codigo).toBe(
      "motivo_longo",
    );
    expect(recusaDoMotivoDoNaoComercial("golpe")).toBeNull();
  });

  it("a mensagem diz o que fazer, não só que falhou", () => {
    expect(recusaDoMotivoDoNaoComercial("")?.mensagem).toContain("Informe o motivo");
    expect(recusaDoMotivoDoNaoComercial("ok")?.mensagem).toContain("pelo menos");
  });
});

describe("#4191 — a decisão de classificar", () => {
  it("negócio aberto e sem classificação: classifica com o motivo normalizado", () => {
    expect(decidirClassificacao(aberto(), "  golpe  ")).toEqual({
      acao: "classificar",
      motivo: "golpe",
    });
  });

  it("motivo inválido é recusado ANTES de olhar o estado (422)", () => {
    const decisao = decidirClassificacao(aberto({ status: "won" }), "");
    expect(decisao).toMatchObject({ acao: "recusar", codigo: "motivo_obrigatorio", httpStatus: 422 });
  });

  it("negócio com desfecho é recusado: a issue não decidiu classificar ganho/perda (409)", () => {
    for (const status of ["won", "lost"]) {
      expect(decidirClassificacao(aberto({ status }), "golpe")).toMatchObject({
        acao: "recusar",
        codigo: "negocio_encerrado",
        httpStatus: 409,
      });
    }
  });

  it("repetir com o MESMO motivo é idempotente — nem outra escrita, nem outra linha na timeline", () => {
    const jaFeito = aberto({
      nao_comercial_em: "2026-11-06T12:00:00.000Z",
      nao_comercial_motivo: "Golpe",
    });
    // Caixa e espaço não fazem outra classificação: é a mesma decisão.
    expect(decidirClassificacao(jaFeito, "  golpe ")).toEqual({ acao: "nada", motivo: "golpe" });
  });

  it("motivo DIFERENTE é conflito, nunca sobrescrita silenciosa (409)", () => {
    const jaFeito = aberto({
      nao_comercial_em: "2026-11-06T12:00:00.000Z",
      nao_comercial_motivo: "spam",
    });
    expect(decidirClassificacao(jaFeito, "golpe")).toMatchObject({
      acao: "recusar",
      codigo: "classificacao_conflitante",
      httpStatus: 409,
    });
  });

  it("classificado sem motivo gravado não vira 'mesma decisão' por acidente", () => {
    const sujo = aberto({ nao_comercial_em: "2026-11-06T12:00:00.000Z", nao_comercial_motivo: null });
    expect(decidirClassificacao(sujo, "golpe")).toMatchObject({
      acao: "recusar",
      codigo: "classificacao_conflitante",
    });
  });
});

describe("#4191 — a decisão de reverter", () => {
  it("reverte quem está classificado", () => {
    expect(decidirReversao({ nao_comercial_em: "2026-11-06T12:00:00.000Z" })).toEqual({
      acao: "reverter",
    });
  });

  it("reverter de novo é idempotente (nada escrito, nada na timeline)", () => {
    expect(decidirReversao({ nao_comercial_em: null })).toEqual({ acao: "nada" });
    expect(decidirReversao({})).toEqual({ acao: "nada" });
  });
});

describe("#4191 — o motivo na timeline", () => {
  it("leva o declarado, sem inventar quando não há", () => {
    expect(motivoParaATimeline("  golpe ")).toBe("golpe");
    expect(motivoParaATimeline(null)).toBe("sem motivo registrado");
  });
});

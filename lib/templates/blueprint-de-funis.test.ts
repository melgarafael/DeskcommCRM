/**
 * O arquivo de blueprint de FUNIS (#1995) — o segundo tipo do mesmo envelope.
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. O envelope é o MESMO (`formato` e `versao`), e o que separa os dois
 *    arquivos é o `tipo`. Um blueprint de respostas rápidas enviado na leitura
 *    de funis é recusado por `tipo` — não aplicado no melhor esforço.
 * 2. A ordem das etapas é a POSIÇÃO no array: fração de `position` da origem
 *    não viaja, e o round-trip JSON preserva a sequência.
 * 3. Cabeçalho é conferido ANTES dos itens: versão diferente diz "versão", não
 *    "funil inválido".
 * 4. Os invariantes que o banco exige (etapa só de ganho OU de perda; um funil
 *    sem etapa é quadro morto) são recusados como `itens`, com o motivo.
 * 5. Nome repetido no destino vira CÓPIA com sufixo, na mesma régua de
 *    comparação de `validarNomeDeFunil` — nunca sobrescreve.
 */
import { describe, expect, it } from "vitest";

import {
  FORMATO_DO_BLUEPRINT,
  TETO_DE_ITENS_DO_BLUEPRINT,
  VERSAO_DO_BLUEPRINT,
  blueprintDasRespostasRapidas,
} from "@/lib/templates/blueprint";
import {
  TIPO_FUNIS,
  blueprintDeFunis,
  lerBlueprintDeFunis,
  nomeDeCopia,
  nomeDoArquivoDeFunis,
  type EtapaExportavel,
  type FunilExportavel,
} from "@/lib/templates/blueprint-de-funis";

const FUNIL = "c7d40000-0000-4000-8000-0000000000f1";
const OUTRO_FUNIL = "c7d40000-0000-4000-8000-0000000000f2";

const FUNIS: FunilExportavel[] = [
  { id: FUNIL, name: "Clínica", description: "Entrada da recepção" },
  { id: OUTRO_FUNIL, name: "Retorno", description: null },
];

const ETAPAS: EtapaExportavel[] = [
  // Fora de ordem de propósito: quem manda é a ordem que a rota leu.
  { pipeline_id: FUNIL, name: "Em andamento", color: "#00aa88", is_won: false, is_lost: false },
  { pipeline_id: FUNIL, name: "Novo", color: null, is_won: false, is_lost: false },
  { pipeline_id: FUNIL, name: "Ganho", color: "#22c55e", is_won: true, is_lost: false },
  { pipeline_id: FUNIL, name: "Perdido", color: null, is_won: false, is_lost: true },
  { pipeline_id: OUTRO_FUNIL, name: "Aguardando", color: null, is_won: false, is_lost: false },
];

/** O corpo do arquivo como ele atravessa a rede: JSON, não objeto vivo. */
function idaEVolta(bruto: unknown): unknown {
  return JSON.parse(JSON.stringify(bruto));
}

describe("blueprintDeFunis", () => {
  it("monta o MESMO envelope, com tipo próprio e etapas na ordem lida", () => {
    const arquivo = blueprintDeFunis(FUNIS, ETAPAS, new Date("2026-11-08T12:00:00.000Z"));

    expect(arquivo.formato).toBe(FORMATO_DO_BLUEPRINT);
    expect(arquivo.versao).toBe(VERSAO_DO_BLUEPRINT);
    expect(arquivo.tipo).toBe(TIPO_FUNIS);
    expect(arquivo.gerado_em).toBe("2026-11-08T12:00:00.000Z");

    expect(arquivo.itens.map((item) => item.nome)).toEqual(["Clínica", "Retorno"]);
    expect(arquivo.itens[0]!.descricao).toBe("Entrada da recepção");
    expect(arquivo.itens[0]!.etapas.map((etapa) => etapa.nome)).toEqual([
      "Em andamento",
      "Novo",
      "Ganho",
      "Perdido",
    ]);
    expect(arquivo.itens[1]!.descricao).toBeNull();
    expect(arquivo.itens[1]!.etapas.map((etapa) => etapa.nome)).toEqual(["Aguardando"]);
  });

  it("não deixa vazar id, slug nem posição numérica", () => {
    const arquivo = blueprintDeFunis(FUNIS, ETAPAS);

    expect(Object.keys(arquivo.itens[0]!).sort()).toEqual(["descricao", "etapas", "nome"]);
    expect(Object.keys(arquivo.itens[0]!.etapas[0]!).sort()).toEqual([
      "cor",
      "is_lost",
      "is_won",
      "nome",
    ]);
  });
});

describe("lerBlueprintDeFunis", () => {
  it("round-trip: o que o export escreve é o que o import lê, na mesma ordem", () => {
    const arquivo = idaEVolta(blueprintDeFunis(FUNIS, ETAPAS));

    const lido = lerBlueprintDeFunis(arquivo);

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.itens.map((item) => item.nome)).toEqual(["Clínica", "Retorno"]);
    expect(lido.itens[0]!.etapas.map((etapa) => etapa.nome)).toEqual([
      "Em andamento",
      "Novo",
      "Ganho",
      "Perdido",
    ]);
    expect(lido.itens[0]!.etapas[2]).toEqual({
      nome: "Ganho",
      cor: "#22c55e",
      is_won: true,
      is_lost: false,
    });
  });

  it("arquivo de RESPOSTAS RÁPIDAS é recusado por tipo, não aplicado", () => {
    const deRespostas = idaEVolta(
      blueprintDasRespostasRapidas([{ title: "Boas-vindas", body: "Olá", shortcut: null }])
        .blueprint,
    );

    const lido = lerBlueprintDeFunis(deRespostas);

    // O formato e a versão casam — só o tipo separa os dois arquivos.
    expect(lido).toEqual({ ok: false, motivo: "tipo" });
  });

  it("formato errado, versão diferente e corpo que não é objeto são recusados pelo motivo certo", () => {
    const arquivo = idaEVolta(blueprintDeFunis(FUNIS, ETAPAS)) as Record<string, unknown>;

    expect(lerBlueprintDeFunis({ ...arquivo, formato: "outra-coisa" })).toEqual({
      ok: false,
      motivo: "formato",
    });
    expect(lerBlueprintDeFunis({ ...arquivo, versao: 2 })).toEqual({ ok: false, motivo: "versao" });
    expect(lerBlueprintDeFunis(null)).toEqual({ ok: false, motivo: "formato" });
    expect(lerBlueprintDeFunis({ itens: [] })).toEqual({ ok: false, motivo: "formato" });
  });

  it("recusa o funil sem etapa: arquivo não pode gerar quadro morto", () => {
    const lido = lerBlueprintDeFunis({
      formato: FORMATO_DO_BLUEPRINT,
      versao: VERSAO_DO_BLUEPRINT,
      tipo: TIPO_FUNIS,
      gerado_em: "2026-11-08T12:00:00.000Z",
      itens: [{ nome: "Vazio", etapas: [] }],
    });

    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.motivo).toBe("itens");
  });

  it("recusa etapa de ganho E de perda, e duas etapas de ganho no mesmo funil", () => {
    const base = {
      formato: FORMATO_DO_BLUEPRINT,
      versao: VERSAO_DO_BLUEPRINT,
      tipo: TIPO_FUNIS,
      gerado_em: "2026-11-08T12:00:00.000Z",
    };

    const asDuas = lerBlueprintDeFunilCom(base, [
      { nome: "Fechado", is_won: true, is_lost: true },
    ]);
    expect(asDuas.ok).toBe(false);

    const doisGanhos = lerBlueprintDeFunilCom(base, [
      { nome: "Ganho 1", is_won: true },
      { nome: "Ganho 2", is_won: true },
    ]);
    expect(doisGanhos.ok).toBe(false);
    if (doisGanhos.ok) return;
    expect(doisGanhos.motivo).toBe("itens");
    expect(JSON.stringify(doisGanhos.detalhes)).toContain("mais de uma etapa de ganho");
  });

  it("recusa lista vazia e lista acima do teto pelo motivo `itens`", () => {
    const base = {
      formato: FORMATO_DO_BLUEPRINT,
      versao: VERSAO_DO_BLUEPRINT,
      tipo: TIPO_FUNIS,
      gerado_em: "2026-11-08T12:00:00.000Z",
    };
    const funil = (i: number) => ({
      nome: `Funil ${i}`,
      etapas: [{ nome: "Novo" }],
    });

    expect(lerBlueprintDeFunis({ ...base, itens: [] }).ok).toBe(false);

    const acimaDoTeto = lerBlueprintDeFunis({
      ...base,
      itens: Array.from({ length: TETO_DE_ITENS_DO_BLUEPRINT + 1 }, (_, i) => funil(i)),
    });
    expect(acimaDoTeto.ok).toBe(false);
    if (acimaDoTeto.ok) return;
    expect(acimaDoTeto.motivo).toBe("itens");
  });
});

/** Cabeçalho válido + etapas do caso, para variar só o que o caso mede. */
function lerBlueprintDeFunilCom(
  base: Record<string, unknown>,
  etapas: Array<Record<string, unknown>>,
) {
  return lerBlueprintDeFunis({
    ...base,
    itens: [{ nome: "Clínica", etapas: etapas.map((etapa) => ({ cor: null, ...etapa })) }],
  });
}

describe("nomeDeCopia — import nunca sobrescreve", () => {
  it("nome livre fica como está", () => {
    expect(nomeDeCopia("Clínica", [])).toBe("Clínica");
    expect(nomeDeCopia("Clínica", ["Retorno"])).toBe("Clínica");
  });

  it("nome ocupado ganha o sufixo; o sufixo ocupado ganha número", () => {
    expect(nomeDeCopia("Clínica", ["Clínica"])).toBe("Clínica (importado)");
    expect(nomeDeCopia("Clínica", ["Clínica", "Clínica (importado)"])).toBe(
      "Clínica (importado 2)",
    );
  });

  it("a régua é a MESMA do funil: caixa, acento e espaço não distinguem", () => {
    expect(nomeDeCopia("clinica", ["Clínica"])).toBe("clinica (importado)");
    expect(nomeDeCopia("  Clínica  ", ["clinica"])).toBe("Clínica (importado)");
  });

  it("respeita o teto de 80 do POST, sem sobrar espaço antes do sufixo", () => {
    const longo = "F".repeat(80);
    const copia = nomeDeCopia(longo, [longo]);

    expect(copia.length).toBeLessThanOrEqual(80);
    expect(copia.endsWith("(importado)")).toBe(true);
    expect(copia).not.toContain("  (importado)");
  });
});

describe("nomeDoArquivoDeFunis", () => {
  it("é funis-AAAA-MM-DD.json, o mesmo desenho do export de respostas", () => {
    expect(nomeDoArquivoDeFunis(new Date("2026-11-08T12:00:00.000Z"))).toBe(
      "funis-2026-11-08.json",
    );
  });
});

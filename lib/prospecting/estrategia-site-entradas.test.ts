/**
 * `entradasDaAbordagem`: a decisão única de INSTRUÇÃO e DADOS da primeira mensagem, que o
 * envio (`worker.ts`) e a prévia (`previa-gerar.ts`) chamam. No modo `estrategia` a saída é
 * exatamente a que o código fazia antes de existir a fonte da abordagem (instrução de
 * `instrucaoDeAbordagemFria` + dados de `montarDadosDeAbordagem`); o modo `agente` troca o
 * ângulo de auditoria pelo roteiro do próprio agente.
 */
import { describe, expect, it } from "vitest";

import {
  LINHA_DA_FONTE_AGENTE,
  entradasDaAbordagem,
  estrategiaDoCandidato,
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
} from "./estrategia-site";
import type { PreviaSalva } from "./previa";

const AGENTE = "55555555-5555-4555-8555-555555555555";
const INSTRUCAO = "Apresente a clínica com educação.";
const QUALIFICACAO = "Tem interesse em agendar avaliação.";
const VOZ = "Voz do vendedor: direto e cordial.";

const DATA = {
  name: "Clínica Vitta",
  category: "Estética",
  address: "Rua X, 10",
  website: "https://vitta.test/",
  rating: 4.8,
  socials: ["https://instagram.com/vitta"],
};
const SITE = {
  classe: "site-ruim" as const,
  problemas: ["nao-mobile"],
  checklist: { tem: ["tel" as const], falta: [] },
  conteudo_resumo: "Página com o horário e o telefone da clínica.",
  provisorio: false,
  verificado_em: "2026-10-10T12:00:00.000Z",
};
const ESTRATEGIA = estrategiaDoCandidato(
  { rating: 4.8, reviews: 120, socials: DATA.socials },
  SITE,
  { ofertas: ["site"], nicho: "clínica", status: "queued" },
);
const PREVIA: PreviaSalva = {
  texto: "RASCUNHO-GUARDADO",
  baseada_em: "site-ruim@2026-10-10T12:00:00.000Z",
  gerada_em: "2026-10-10T13:00:00.000Z",
  agente_id: AGENTE,
};

function base(over: Partial<Parameters<typeof entradasDaAbordagem>[0]> = {}) {
  return {
    config: { instruction: INSTRUCAO, qualification: QUALIFICACAO },
    data: DATA,
    site: SITE,
    estrategia: ESTRATEGIA,
    voz: VOZ,
    previa: PREVIA,
    ...over,
  };
}

describe("entradasDaAbordagem — modo `estrategia` (o de sempre)", () => {
  it("é idêntica ao que o worker fazia: instrução fria + estratégia, dados com Auditoria e rascunho", () => {
    const r = entradasDaAbordagem(base());
    // O que o código fazia antes: as duas funções chamadas direto.
    expect(r.instrucao).toBe(instrucaoDeAbordagemFria(INSTRUCAO, QUALIFICACAO, VOZ, ESTRATEGIA, false));
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, SITE, PREVIA));
    // E o conteúdo, para o teste não ser só uma tautologia.
    expect(r.instrucao).toContain("Estratégia de abordagem definida para este lead");
    expect(r.instrucao).not.toContain(LINHA_DA_FONTE_AGENTE);
    expect(r.dados["Auditoria"]).toContain("Site com problemas");
    expect(r.dados["Detalhe"]).toBe(SITE.conteudo_resumo);
    expect(r.dados["Rascunho de abordagem"]).toBe("RASCUNHO-GUARDADO");
  });

  it("`fonte_da_abordagem` ausente e `'estrategia'` explícito dão a mesma saída", () => {
    const ausente = entradasDaAbordagem(base());
    const explicito = entradasDaAbordagem(
      base({ config: { instruction: INSTRUCAO, qualification: QUALIFICACAO, fonte_da_abordagem: "estrategia" } }),
    );
    expect(explicito).toEqual(ausente);
  });

  it("`exit_offer` ausente vale `first_message`: não só cumprimenta", () => {
    const r = entradasDaAbordagem(base());
    expect(r.instrucao).not.toContain("só cumprimenta");
    const explicito = entradasDaAbordagem(
      base({ config: { instruction: INSTRUCAO, qualification: QUALIFICACAO, exit_offer: "first_message" } }),
    );
    expect(explicito).toEqual(r);
  });

  it("sem voz, sem estratégia e sem prévia: igual às funções de origem", () => {
    const r = entradasDaAbordagem(base({ voz: undefined, estrategia: null, previa: null, site: null }));
    expect(r.instrucao).toBe(instrucaoDeAbordagemFria(INSTRUCAO, QUALIFICACAO, undefined, null, false));
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, null, null));
    expect(r.dados["Rascunho de abordagem"]).toBeUndefined();
  });

  it("voz vazia não entra na instrução (igual ao sem-voz)", () => {
    const r = entradasDaAbordagem(base({ voz: "" }));
    expect(r.instrucao).toBe(instrucaoDeAbordagemFria(INSTRUCAO, QUALIFICACAO, undefined, ESTRATEGIA, false));
  });

  it("`exit_offer = second_message`: só cumprimenta, sem estratégia, sem Auditoria e sem rascunho", () => {
    const r = entradasDaAbordagem(
      base({ config: { instruction: INSTRUCAO, qualification: QUALIFICACAO, exit_offer: "second_message" } }),
    );
    expect(r.instrucao).toBe(instrucaoDeAbordagemFria(INSTRUCAO, QUALIFICACAO, VOZ, ESTRATEGIA, true));
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, null, null));
    expect(r.instrucao).toContain("NÃO apresenta serviço");
    expect(r.instrucao).not.toContain("Estratégia de abordagem definida");
    expect(Object.keys(r.dados)).not.toContain("Auditoria");
    expect(Object.keys(r.dados)).not.toContain("Rascunho de abordagem");
  });
});

describe("entradasDaAbordagem — modo `agente`", () => {
  const cfgAgente = {
    instruction: INSTRUCAO,
    qualification: QUALIFICACAO,
    fonte_da_abordagem: "agente" as const,
  };

  it("sem bloco de estratégia nem Auditoria/Detalhe, com a linha que põe o roteiro do agente na frente", () => {
    const r = entradasDaAbordagem(base({ config: cfgAgente }));
    // Mesmo recebendo estratégia e site, o modo agente os ignora.
    expect(r.instrucao).toBe(
      `${instrucaoDeAbordagemFria(INSTRUCAO, QUALIFICACAO, VOZ, null, false)}\n${LINHA_DA_FONTE_AGENTE}`,
    );
    expect(r.instrucao).not.toContain("Estratégia de abordagem definida");
    expect(r.instrucao.endsWith(LINHA_DA_FONTE_AGENTE)).toBe(true);
    expect(r.dados["Auditoria"]).toBeUndefined();
    expect(r.dados["Detalhe"]).toBeUndefined();
  });

  it("mantém a moldura fria, a voz e o rascunho guardado", () => {
    const r = entradasDaAbordagem(base({ config: cfgAgente }));
    expect(r.instrucao.startsWith(INSTRUCAO)).toBe(true);
    expect(r.instrucao).toContain("primeira abordagem curta e transparente");
    expect(r.instrucao).toContain(`Critérios a confirmar durante a conversa: ${QUALIFICACAO}`);
    expect(r.instrucao).toContain(VOZ);
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, null, PREVIA));
    expect(r.dados["Rascunho de abordagem"]).toBe("RASCUNHO-GUARDADO");
    expect(r.dados["Empresa"]).toBe("Clínica Vitta");
  });

  it("funciona sem site e sem estratégia (site ainda sem veredito)", () => {
    const r = entradasDaAbordagem(base({ config: cfgAgente, site: null, estrategia: null, previa: null }));
    expect(r.instrucao).toContain(LINHA_DA_FONTE_AGENTE);
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, null, null));
  });

  it("`second_message` vence a fonte: só cumprimenta, sem a linha do agente e sem Auditoria", () => {
    const r = entradasDaAbordagem(base({ config: { ...cfgAgente, exit_offer: "second_message" } }));
    expect(r.instrucao).toContain("NÃO apresenta serviço");
    expect(r.dados).toEqual(montarDadosDeAbordagem(DATA, null, null));
    expect(r.dados["Rascunho de abordagem"]).toBeUndefined();
  });
});

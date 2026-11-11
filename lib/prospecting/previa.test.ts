/**
 * A prévia guardada e a FONTE DA ABORDAGEM (`config.fonte_da_abordagem`). A prévia escrita com
 * o ângulo da estratégia do site não serve a uma campanha que passou a usar o prompt do agente
 * (e vice-versa): `previaValida`/`previaDoAgente` só devolvem a prévia da MESMA fonte.
 * `fonte` ausente é prévia anterior à opção — vale como `estrategia`.
 */
import { describe, expect, it } from "vitest";

import { ANCORA_DA_FONTE_AGENTE, chaveDaAuditoria, previaDoAgente, previaValida, type PreviaSalva } from "./previa";
import type { SiteEnrichment } from "./site-classify";

const AGENTE = "55555555-5555-4555-8555-555555555555";
const OUTRO_AGENTE = "66666666-6666-4666-8666-666666666666";

const SITE: SiteEnrichment = {
  ver: 1,
  classe: "fora-do-ar",
  problemas: ["fora-do-ar"],
  checklist: { tem: [], falta: [] },
  final_url: null,
  http_status: null,
  tempo_ms: 120,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};
const BASE = { website: "https://vitta.test/", site: SITE };
const CHAVE = chaveDaAuditoria(BASE)!;

function previa(over: Partial<PreviaSalva> = {}): PreviaSalva {
  return {
    texto: "Olá, tudo bem?",
    baseada_em: CHAVE,
    gerada_em: "2026-10-11T09:00:00.000Z",
    agente_id: AGENTE,
    ...over,
  };
}
const comPrevia = (p: PreviaSalva) => ({ ...BASE, previa: p });
const DO_AGENTE = () => previa({ fonte: "agente", baseada_em: ANCORA_DA_FONTE_AGENTE });

describe("previaValida por fonte", () => {
  it("sem `fonte` informada, a prévia legada (sem `fonte`) e ancorada na auditoria vale — o de sempre", () => {
    expect(previaValida(comPrevia(previa()))).not.toBeNull();
    expect(previaValida(comPrevia(previa()), "estrategia")).not.toBeNull();
  });

  it("prévia `fonte: 'estrategia'` explícita vale para a campanha por estratégia", () => {
    expect(previaValida(comPrevia(previa({ fonte: "estrategia" })), "estrategia")).not.toBeNull();
  });

  it("prévia de OUTRA fonte não vence: a do agente não serve à estratégia", () => {
    expect(previaValida(comPrevia(DO_AGENTE()), "estrategia")).toBeNull();
    // O default do parâmetro (estrategia) faz o mesmo.
    expect(previaValida(comPrevia(DO_AGENTE()))).toBeNull();
  });

  it("prévia de OUTRA fonte não vence: a da estratégia (ou legada) não serve ao agente", () => {
    expect(previaValida(comPrevia(previa({ fonte: "estrategia" })), "agente")).toBeNull();
    // `fonte` ausente = legado = estratégia: também não serve ao modo agente.
    expect(previaValida(comPrevia(previa()), "agente")).toBeNull();
  });

  it("prévia da MESMA fonte vence: a do agente, ancorada em `fonte:agente`", () => {
    expect(previaValida(comPrevia(DO_AGENTE()), "agente")).toEqual(DO_AGENTE());
  });

  it("a prévia do agente não depende da auditoria: vale com o site mudado, sem veredito ou sem site", () => {
    const reauditado = { ...BASE, site: { ...SITE, verificado_em: "2026-11-01T00:00:00.000Z" }, previa: DO_AGENTE() };
    expect(previaValida(reauditado, "agente")).not.toBeNull();
    expect(previaValida({ website: "https://vitta.test/", site: null, previa: DO_AGENTE() }, "agente")).not.toBeNull();
    expect(previaValida({ website: null, previa: DO_AGENTE() }, "agente")).not.toBeNull();
  });

  it("prévia do agente com âncora de auditoria (não `fonte:agente`) é recusada", () => {
    expect(previaValida(comPrevia(previa({ fonte: "agente" })), "agente")).toBeNull();
  });

  it("a da estratégia continua presa à medição: reauditado, a prévia perde a validade", () => {
    const reauditado = {
      ...BASE,
      site: { ...SITE, verificado_em: "2026-11-01T00:00:00.000Z" },
      previa: previa({ fonte: "estrategia" }),
    };
    expect(previaValida(reauditado, "estrategia")).toBeNull();
  });

  it("sem prévia, ou prévia malformada, é null nas duas fontes", () => {
    expect(previaValida(BASE, "estrategia")).toBeNull();
    expect(previaValida(BASE, "agente")).toBeNull();
    const ruim = { ...BASE, previa: { texto: "x" } as unknown as PreviaSalva };
    expect(previaValida(ruim, "estrategia")).toBeNull();
    expect(previaValida(ruim, "agente")).toBeNull();
  });

  it("`fonte` fora do vocabulário torna a prévia malformada", () => {
    const estranha = { ...BASE, previa: { ...previa(), fonte: "outra" } as unknown as PreviaSalva };
    expect(previaValida(estranha, "estrategia")).toBeNull();
  });
});

describe("previaDoAgente por fonte", () => {
  it("legado: sem `fonte`, devolve a prévia do mesmo agente (comportamento de sempre)", () => {
    expect(previaDoAgente(comPrevia(previa()), AGENTE)?.agente_id).toBe(AGENTE);
  });

  it("agente diferente do que escreveu: null, em qualquer fonte", () => {
    expect(previaDoAgente(comPrevia(previa()), OUTRO_AGENTE)).toBeNull();
    expect(previaDoAgente(comPrevia(DO_AGENTE()), OUTRO_AGENTE, "agente")).toBeNull();
  });

  it("mesma fonte e mesmo agente vence; fonte diferente não", () => {
    expect(previaDoAgente(comPrevia(DO_AGENTE()), AGENTE, "agente")).toEqual(DO_AGENTE());
    expect(previaDoAgente(comPrevia(DO_AGENTE()), AGENTE, "estrategia")).toBeNull();
    expect(previaDoAgente(comPrevia(previa({ fonte: "estrategia" })), AGENTE, "agente")).toBeNull();
    expect(previaDoAgente(comPrevia(previa({ fonte: "estrategia" })), AGENTE, "estrategia")).not.toBeNull();
  });
});

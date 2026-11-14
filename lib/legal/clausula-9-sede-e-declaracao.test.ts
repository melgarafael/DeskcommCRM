/**
 * A CLÁUSULA 9 SEPARA O QUE O PROVEDOR DECLARA DA SEDE QUE O CATÁLOGO REGISTRA
 * (#4588).
 *
 * O defeito medido em 14/11 na `origin/main`: a cláusula prometia que o conteúdo
 * era processado "conforme a declaração de cada provedor, consultada em data", e
 * SEIS dos dez provedores do catálogo nunca declararam região de processamento —
 * para eles, `US` era a sede de quem recebe o texto. Uma frase que afirma uma
 * declaração inexistente é o pior tipo de defeito num contrato: ela é assinada
 * por quem opera e não pode ser cumprida por quem fornece.
 *
 * O que este arquivo prende:
 *   1. a tabela MEDIDA do catálogo (id → pais/sede/paisDeclarado/fonte): nenhum
 *      provedor muda de país por acidente, e só a DeepSeek tem declaração;
 *   2. provedor sem declaração NÃO aparece como declarante na cláusula;
 *   3. provedor com `fonteDoPais` aparece com fonte e data, na linha dele;
 *   4. a frase que atribuía a declaração a todos não volta.
 *
 * A lista de ids e países é literal de propósito: derivá-la do próprio catálogo
 * faria o teste passar com qualquer catálogo, inclusive um que troque todos os
 * países. É a única forma de "nenhum provedor muda de país por acidente" virar
 * asserção.
 */
import { describe, expect, it } from "vitest";

import { PROVEDORES, PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import { PROVEDORES_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";
import { clausulaDeTransferenciaInternacional } from "@/lib/legal/operador";

interface LinhaMedida {
  id: string;
  /** O código que a tela e o contrato imprimem. */
  pais: string;
  /** Sede registrada pelo catálogo (#4588). */
  sede: string | null;
  /** O que o provedor declara sobre a região de processamento. */
  paisDeclarado: string | null;
  /** A fonte da declaração, quando existe. */
  fonte: { url: string; consultadoEm: string } | null;
}

/**
 * A tabela medida na `origin/main` de 14/11/2026, com o que o #4588 acrescentou.
 *
 * Os seis `US` sem fonte são exatamente os que a cláusula chamava de
 * declarantes: Anthropic, OpenAI, a assinatura da OpenAI, Google, OpenRouter e
 * TypeSafe. Para eles `sede` é a única informação que o catálogo tem — a OpenAI
 * declara região por projeto, o Gemini não publica a lista de países e o
 * OpenRouter varia por chamada.
 */
const MEDIDO: readonly LinhaMedida[] = [
  { id: "anthropic", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  { id: "openai", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  { id: "openai-assinatura", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  { id: "google", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  { id: "openrouter", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  {
    id: "deepseek",
    pais: "CN",
    sede: "CN",
    paisDeclarado: "CN",
    fonte: {
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
      consultadoEm: "2026-11-12",
    },
  },
  { id: "requesty", pais: "desconhecido", sede: null, paisDeclarado: null, fonte: null },
  { id: "custom", pais: "operador", sede: null, paisDeclarado: null, fonte: null },
  { id: "typesafe", pais: "US", sede: "US", paisDeclarado: null, fonte: null },
  { id: "elevenlabs", pais: "desconhecido", sede: null, paisDeclarado: null, fonte: null },
];

/** O catálogo inteiro, como a cláusula 9 o lê: conversa + decisão + serviço. */
const CATALOGO = [...PROVEDORES, ...PROVEDORES_DE_DECISAO, ...PROVEDORES_DE_SERVICO];

/** Os seis que a cláusula tratava como declarantes sem que tivessem declarado. */
const COM_SEDE_NO_CATALOGO = [
  "anthropic",
  "openai",
  "openai-assinatura",
  "google",
  "openrouter",
  "typesafe",
] as const;

describe("catálogo — sede e declaração são campos diferentes (#4588)", () => {
  it("a tabela medida: cada provedor com o país, a sede e a declaração de hoje", () => {
    const tabela = CATALOGO.map((p) => ({
      id: p.id,
      pais: p.pais,
      sede: p.sede,
      paisDeclarado: p.paisDeclarado,
      fonte: p.fonteDoPais,
    }));
    // Comparação do objeto inteiro: um `pais: "US"` trocado por "UE", ou uma
    // sede apagada num refactor, aparece como diff e não como cláusula errada
    // num contrato assinado.
    expect(tabela).toEqual(MEDIDO);
  });

  it("nenhum dos seis provedores da sede declara região de processamento", () => {
    for (const id of COM_SEDE_NO_CATALOGO) {
      const p = CATALOGO.find((provedor) => provedor.id === id);
      expect(p, `${id} sumiu do catálogo`).toBeDefined();
      expect(p?.pais).toBe("US");
      expect(p?.sede, `${id}: a sede registrada é o que o catálogo sabe dele`).toBe("US");
      // A asserção que o #4588 existe para prender: sem fonte, não há declaração
      // — e o campo novo não pode ser preenchido "de herança" a partir da sede.
      expect(p?.paisDeclarado, `${id} não publica onde processa`).toBeNull();
      expect(p?.fonteDoPais).toBeNull();
    }
  });

  it("a DeepSeek declara, e a declaração tem URL e data próprias", () => {
    const deepseek = CATALOGO.find((p) => p.id === "deepseek");
    expect(deepseek?.paisDeclarado).toBe("CN");
    expect(deepseek?.fonteDoPais?.url).toMatch(/^https:\/\/cdn\.deepseek\.com\//);
    expect(deepseek?.fonteDoPais?.consultadoEm).toBe("2026-11-12");
  });
});

describe("cláusula 9 — quem não declarou não aparece como declarante", () => {
  it.each(COM_SEDE_NO_CATALOGO)("%s entra pela SEDE, nunca como 'declaração do provedor'", (id) => {
    const texto = clausulaDeTransferenciaInternacional([id]);

    expect(texto).toContain("sede nos Estados Unidos");
    // A frase do defeito: "conforme a declaração de cada provedor".
    expect(texto).not.toContain("declaração do provedor");
    expect(texto).not.toContain("conforme a declaração de cada provedor");
    // Data de declaração não existe para quem não declarou — e a da DeepSeek
    // (12/11/2026) é o que uma data de declaração parece.
    expect(texto).not.toContain("12/11/2026");
  });

  it("a linha da sede diz o que é e manda conferir a política do provedor", () => {
    const texto = clausulaDeTransferenciaInternacional(["anthropic"]);

    expect(texto).toContain(
      "Anthropic (sede nos Estados Unidos — de quem recebe o conteúdo; " +
        "não declara a região de processamento, consulte a política do provedor)",
    );
  });

  it("provedor que não declara NADA continua aparecendo, com a frase própria", () => {
    const texto = clausulaDeTransferenciaInternacional(["requesty"]);

    expect(texto).toContain("Requesty (não declara o país; consulte a política do provedor)");
    expect(texto).not.toContain("declaração do provedor");
  });

  it("endpoint próprio não vira sede nem declaração", () => {
    const texto = clausulaDeTransferenciaInternacional(["custom"]);

    expect(texto).toContain("Provedor personalizado (no servidor do operador)");
    expect(texto).not.toContain("declaração do provedor");
    expect(texto).not.toContain("sede nos Estados Unidos");
  });
});

describe("cláusula 9 — quem declarou aparece com fonte e data", () => {
  it("a DeepSeek leva o país declarado e a data da consulta na própria linha", () => {
    const texto = clausulaDeTransferenciaInternacional(["deepseek"]);

    expect(texto).toContain("DeepSeek (China — declaração do provedor, consultada em 12/11/2026)");
    // A data do catálogo é da SEDE, e a DeepSeek tem sede: as duas aparecem, e
    // cada uma no seu lugar — a declaração na linha, a conferência no parágrafo.
    expect(texto).not.toContain("Estados Unidos");
  });

  it("com todos os provedores ativos, uma única linha é declaração", () => {
    const texto = clausulaDeTransferenciaInternacional(
      CATALOGO.filter((p) => p.pais !== "operador").map((p) => p.id),
    );

    expect(texto.match(/declaração do provedor/g)).toHaveLength(1);
    expect(texto).toContain("DeepSeek (China — declaração do provedor, consultada em 12/11/2026)");
    // As seis sedes aparecem como sede, e a frase do defeito não volta em
    // nenhuma forma.
    expect(texto.match(/sede nos Estados Unidos/g)).toHaveLength(6);
    expect(texto).not.toContain("conforme a declaração de cada provedor");
  });

  it("a data da declaração sai do provedor, não do catálogo", () => {
    // 13/11/2026 é a conferência das SEDES (`CONSULTA_DOS_PAISES_EM`); a
    // declaração da DeepSeek foi consultada em 12/11/2026. Trocar uma pela
    // outra é o jeito elegante de inventar uma data no contrato.
    const texto = clausulaDeTransferenciaInternacional(["deepseek"]);
    expect(texto).toContain("consultada em 12/11/2026");
    expect(texto).not.toContain("13/11/2026");
  });
});

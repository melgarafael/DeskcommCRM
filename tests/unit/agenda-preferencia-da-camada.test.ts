/**
 * A LEITURA DA ESCOLHA DA CAMADA "DATAS DOS NEGÓCIOS" (#4436, item 1).
 *
 * ─── O que está sendo medido ───────────────────────────────────────────────
 *
 * A escolha da camada passa a ser gravada por PESSOA, no `user_metadata` do
 * Supabase — o mesmo sítio de `lembretes_de_tarefa` e do perfil (idioma, fuso),
 * sem migration e visível de qualquer aparelho da pessoa. Isso torna o insumo
 * DADO ALHEIO: ele foi gravado numa sessão antiga, por uma versão anterior do
 * produto, ou aponta para um funil que foi arquivado ontem. Abrir a Agenda não
 * pode virar erro de tela por causa disso.
 *
 *   1. **Lixo volta ao padrão, campo a campo** — string, array, objeto com a
 *      chave torta, tipo errado em `ligada`: a camada abre desligada, sem
 *      lançar. É a mesma régua de `lerPreferenciaDeLembrete`.
 *   2. **Funil arquivado (ou fora do alcance de quem lê) volta ao padrão.** O
 *      funil não está na lista que o servidor resolveu — ele só oferece funil
 *      não arquivado e visível pela RLS —, então a escolha inteira cai: funil,
 *      campo e campo-fim.
 *   3. **Campo que sumiu do funil volta ao padrão DAQUELE campo**, sem levar o
 *      funil junto: a pessoa escolhe o campo de novo, no mesmo funil.
 *   4. **Id inválido não é id de funil** — nada de casar por prefixo, por
 *      índice ou por "parece igual".
 *
 * `ligada` é preservada quando só o campo/funil caiu: a pessoa QUIS a camada
 * ligada, e desligá-la por causa de um campo renomeado seria perder a intenção
 * dela. O que volta ao padrão é a escolha que não existe mais.
 */
import { describe, expect, it } from "vitest";

import {
  CHAVE_DA_CAMADA,
  lerEscolhaDaCamada,
  escolhaPadraoDaCamada,
} from "@/lib/agenda/preferencia-da-camada";
import { escolhaDaCamadaSchema } from "@/lib/schemas/agenda";
import type { FunilComDatas } from "@/lib/agenda/datas-dos-negocios";

const FUNIS: FunilComDatas[] = [
  {
    id: "p-viagens",
    nome: "Viagens",
    campos: [
      { key: "data_inicio", label: "Embarque" },
      { key: "data_fim", label: "Retorno" },
    ],
  },
  {
    id: "p-frota",
    nome: "Frota",
    campos: [{ key: "revisao", label: "Revisão" }],
  },
];

/** O metadata como o Supabase devolve: o objeto inteiro, não a chave. */
function metadataCom(cru: unknown): Record<string, unknown> {
  return { full_name: "Ana", locale: "pt-BR", [CHAVE_DA_CAMADA]: cru };
}

describe("lerEscolhaDaCamada — leitura tolerante da escolha guardada", () => {
  it("sem nada guardado: o padrão é desligada, sem funil e sem campo", () => {
    expect(lerEscolhaDaCamada(undefined, FUNIS)).toEqual({
      ligada: false,
      funilId: null,
      campo: null,
      campoFim: null,
    });
    expect(lerEscolhaDaCamada(metadataCom(undefined), FUNIS)).toEqual(escolhaPadraoDaCamada());
    // O metadata pode chegar nulo (sessão sem `user_metadata`).
    expect(lerEscolhaDaCamada(null, FUNIS)).toEqual(escolhaPadraoDaCamada());
  });

  it("escolha válida volta como foi gravada — ligada, funil, campo e campo-fim", () => {
    const escolha = {
      ligada: true,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: "data_fim",
    };
    expect(lerEscolhaDaCamada(metadataCom(escolha), FUNIS)).toEqual(escolha);
  });

  it("metadata torto NÃO lança: string, array, número e a chave em formato inesperado caem no padrão", () => {
    for (const lixo of ["ligada", 42, ["p-viagens"], true, { ...escolhaPadraoDaCamada() }]) {
      expect(() => lerEscolhaDaCamada(lixo, FUNIS)).not.toThrow();
      expect(lerEscolhaDaCamada(lixo, FUNIS)).toEqual(escolhaPadraoDaCamada());
    }
    for (const lixo of ["{}", 7, [], null]) {
      expect(lerEscolhaDaCamada(metadataCom(lixo), FUNIS)).toEqual(escolhaPadraoDaCamada());
    }
  });

  it("funil ARQUIVADO (fora da lista que o servidor resolveu): funil, campo e campo-fim voltam ao padrão", () => {
    const escolha = {
      ligada: true,
      funilId: "p-arquivado",
      campo: "data_inicio",
      campoFim: "data_fim",
    };
    expect(lerEscolhaDaCamada(metadataCom(escolha), FUNIS)).toEqual({
      // A intenção de ter a camada ligada é da pessoa; o resto não existe mais.
      ligada: true,
      funilId: null,
      campo: null,
      campoFim: null,
    });
  });

  it("campo que sumiu do funil cai sozinho: o funil fica, o campo volta ao padrão", () => {
    const escolha = {
      ligada: true,
      funilId: "p-viagens",
      campo: "campo_apagado",
      campoFim: "data_fim",
    };
    expect(lerEscolhaDaCamada(metadataCom(escolha), FUNIS)).toEqual({
      ligada: true,
      funilId: "p-viagens",
      campo: null,
      // Sem o campo principal não há "segundo campo" a que pertencer.
      campoFim: null,
    });
  });

  it("campo do OUTRO funil não vale: casar por chave alheia abriria a camada quebrada", () => {
    const escolha = {
      ligada: true,
      funilId: "p-viagens",
      campo: "revisao",
      campoFim: null,
    };
    expect(lerEscolhaDaCamada(metadataCom(escolha), FUNIS).campo).toBeNull();
  });

  it("segundo campo igual ao primeiro, ou que sumiu, cai sozinho — o campo principal fica", () => {
    const igual = lerEscolhaDaCamada(
      metadataCom({
        ligada: true,
        funilId: "p-viagens",
        campo: "data_inicio",
        campoFim: "data_inicio",
      }),
      FUNIS,
    );
    expect(igual).toEqual({
      ligada: true,
      funilId: "p-viagens",
      campo: "data_inicio",
      campoFim: null,
    });

    const sumiu = lerEscolhaDaCamada(
      metadataCom({ ligada: true, funilId: "p-viagens", campo: "data_inicio", campoFim: "sumiu" }),
      FUNIS,
    );
    expect(sumiu.campoFim).toBeNull();
    expect(sumiu.campo).toBe("data_inicio");
  });

  it("id inválido não é funil: nada de casar por prefixo nem por índice", () => {
    for (const funilId of ["p-viage", "0", "1", " ", "p-VIAGENS"]) {
      const escolha = { ligada: true, funilId, campo: null, campoFim: null };
      expect(lerEscolhaDaCamada(metadataCom(escolha), FUNIS).funilId).toBeNull();
    }
  });

  it("sem funil nenhum a escolha guardada não inventa um: tudo no padrão, menos `ligada`", () => {
    expect(
      lerEscolhaDaCamada(
        metadataCom({ ligada: true, funilId: "p-viagens", campo: "data_inicio" }),
        [],
      ),
    ).toEqual({ ligada: true, funilId: null, campo: null, campoFim: null });
  });

  it("campo-fim sem campo principal não existe: cai, sem tocar em `ligada`", () => {
    expect(
      lerEscolhaDaCamada(
        metadataCom({ ligada: false, funilId: "p-viagens", campo: null, campoFim: "data_fim" }),
        FUNIS,
      ),
    ).toEqual({ ligada: false, funilId: "p-viagens", campo: null, campoFim: null });
  });

  it("`ligada` que não é booleano vira o padrão do produto (desligada)", () => {
    for (const ligada of ["true", 1, null, {}, "sim"]) {
      expect(
        lerEscolhaDaCamada(
          metadataCom({ ligada, funilId: "p-viagens", campo: "data_inicio" }),
          FUNIS,
        ).ligada,
      ).toBe(false);
    }
  });
});

describe("escolhaDaCamadaSchema — o que a action aceita", () => {
  it("aceita a escolha completa e a escolha vazia (desligada, sem funil)", () => {
    const completa = {
      ligada: true,
      funilId: "3f1c2a9e-7b1d-4a55-9c2f-6e8b0d1a2c34",
      campo: "data_inicio",
      campoFim: null,
    };
    expect(escolhaDaCamadaSchema.safeParse(completa).success).toBe(true);
    expect(escolhaDaCamadaSchema.safeParse(escolhaPadraoDaCamada()).success).toBe(true);
  });

  it("recusa tipo errado, funilId que não é id e chave de campo fora da régua do funil", () => {
    expect(escolhaDaCamadaSchema.safeParse({ ligada: "true" }).success).toBe(false);
    // A MESMA régua da rota que lê as datas: id é uuid, e chave de campo segue
    // `chaveDeCampoDoFunilSchema`. O que a consulta recusaria não é gravado.
    expect(
      escolhaDaCamadaSchema.safeParse({ ligada: true, funilId: "", campo: null, campoFim: null })
        .success,
    ).toBe(false);
    expect(
      escolhaDaCamadaSchema.safeParse({
        ligada: true,
        funilId: "3f1c2a9e-7b1d-4a55-9c2f-6e8b0d1a2c34",
        campo: "data inicio",
        campoFim: null,
      }).success,
    ).toBe(false);
    expect(escolhaDaCamadaSchema.safeParse(null).success).toBe(false);
  });
});

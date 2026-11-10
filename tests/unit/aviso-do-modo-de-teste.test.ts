/**
 * A REGRA QUE DIZ, NA TELA DO AGENTE, POR QUE A IA NÃO RESPONDE (#3976).
 *
 * Todo canal nasce em modo de teste com a lista vazia e, com a lista vazia, o
 * gate descarta QUALQUER contato. A tela do agente mostrava número, telefone e
 * estado da conexão — e nada sobre isso: a pessoa publicava, mandava mensagem
 * do próprio celular, não recebia resposta e ia procurar o defeito onde estava
 * tudo certo.
 *
 * ─── O que cada caso cobra ──────────────────────────────────────────────────
 *
 *  1. lista vazia → o aviso que manda cadastrar quem vai testar;
 *  2. lista com o número de quem testa → NADA (não se manda cadastrar o que já
 *     está lá, e o nono dígito não pode fazer o mesmo número parecer dois);
 *  3. lista com outro número → o aviso que diz QUAL número está fora;
 *  4. canal aberto → nada (nenhum aviso em produção);
 *  5. `allowlist` legado (autorização por origem) → nada: não é modo de teste, e
 *     a frase mandaria a pessoa para o lugar errado;
 *  6. estado não medido (leitura falhou / contagem nula) → nada. Indefinido não
 *     acusa — a mesma régua do #3975. "Não deu para ler" não é diagnóstico;
 *  7. número sem DDI → nada: comparar `99999-8888` com uma lista E.164 acusaria
 *     um número que pode estar autorizado.
 *
 * A FRASE de cada estado é do teste da tela
 * (`tests/unit/agente-avisa-modo-de-teste.test.tsx`): apagar a regra e apagar o
 * texto são defeitos diferentes.
 */
import { describe, expect, it } from "vitest";

import { decidirAvisoDoModoDeTeste } from "@/lib/ai/elegibilidade/aviso-do-modo-de-teste";

const CANAL_VAZIO = { mode: "pre_go_live" as const, testNumbersCount: 0 };
const CANAL_COM_DOIS = { mode: "pre_go_live" as const, testNumbersCount: 2 };

const DA_EQUIPE = "+5511987654321";
const DO_SOCIO = "+5511977776666";
const AUTORIZADOS = [DA_EQUIPE, DO_SOCIO];
/** Um celular de São Paulo que NÃO está na lista acima. */
const DE_FORA = "+5511955554444";

describe("decidirAvisoDoModoDeTeste", () => {
  it("modo de teste com a lista vazia: a IA não responde ninguém", () => {
    expect(decidirAvisoDoModoDeTeste({ acesso: CANAL_VAZIO })).toEqual({ tipo: "lista_vazia" });
  });

  it("canal aberto ao público: nenhum aviso", () => {
    expect(
      decidirAvisoDoModoDeTeste({ acesso: { mode: "open", testNumbersCount: 0 } }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("allowlist legado não é modo de teste, mesmo sem número nenhum", () => {
    expect(
      decidirAvisoDoModoDeTeste({ acesso: { mode: "allowlist", testNumbersCount: 0 } }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("estado não medido não acusa: modo ou contagem nulos", () => {
    expect(decidirAvisoDoModoDeTeste({ acesso: null })).toEqual({ tipo: "nenhum" });
    expect(decidirAvisoDoModoDeTeste({ acesso: { mode: null, testNumbersCount: 0 } })).toEqual({
      tipo: "nenhum",
    });
    expect(
      decidirAvisoDoModoDeTeste({ acesso: { mode: "pre_go_live", testNumbersCount: null } }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("modo de teste com números e SEM o número em teste: nada a afirmar", () => {
    expect(decidirAvisoDoModoDeTeste({ acesso: CANAL_COM_DOIS })).toEqual({ tipo: "nenhum" });
    expect(
      decidirAvisoDoModoDeTeste({ acesso: CANAL_COM_DOIS, numerosDeTeste: AUTORIZADOS }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("o número de quem testa ESTÁ na lista: nenhum aviso", () => {
    expect(
      decidirAvisoDoModoDeTeste({
        acesso: CANAL_COM_DOIS,
        numerosDeTeste: AUTORIZADOS,
        numeroEmTeste: DA_EQUIPE,
      }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("a mesma pessoa com o nono dígito a menos continua autorizada", () => {
    // `phoneLookupVariants` cobre as duas grafias: mandar cadastrar de novo um
    // número que já está lá é o aviso errado, e ele ensina a mexer no que não
    // está quebrado.
    expect(
      decidirAvisoDoModoDeTeste({
        acesso: CANAL_COM_DOIS,
        numerosDeTeste: AUTORIZADOS,
        numeroEmTeste: DA_EQUIPE.replace("9", ""),
      }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("número fora da lista: diz QUAL número não recebe resposta", () => {
    expect(
      decidirAvisoDoModoDeTeste({
        acesso: CANAL_COM_DOIS,
        numerosDeTeste: AUTORIZADOS,
        numeroEmTeste: DE_FORA,
      }),
    ).toEqual({ tipo: "numero_fora_da_lista", numero: DE_FORA });
  });

  it("número digitado sem DDI não é acusado", () => {
    expect(
      decidirAvisoDoModoDeTeste({
        acesso: CANAL_COM_DOIS,
        numerosDeTeste: AUTORIZADOS,
        numeroEmTeste: "99999-8888",
      }),
    ).toEqual({ tipo: "nenhum" });
  });

  it("lista não lida (sem permissão ou erro) não vira 'fora da lista'", () => {
    expect(
      decidirAvisoDoModoDeTeste({
        acesso: CANAL_COM_DOIS,
        numerosDeTeste: null,
        numeroEmTeste: DE_FORA,
      }),
    ).toEqual({ tipo: "nenhum" });
  });
});

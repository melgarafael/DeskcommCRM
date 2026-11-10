/**
 * AS MENÇÕES DE GRUPO (#3566) — a exibição resolve, o texto cru fica.
 *
 * Cada regra de produto tem um caso aqui, e cada caso tem um jeito de ficar
 * VERMELHO: trocar a resolução por posição (o caso da ordem invertida reprova),
 * trocar por nome (o caso dos dois "João" reprova), reescrever o corpo (o caso
 * do cru reprova), resolver quem não está no CRM (o caso do desconhecido
 * reprova) e passar a tocar mensagem sem menção (o controle, byte a byte).
 */
import { describe, expect, it } from "vitest";

import { lerMencoesDeGrupo, textoComMencoesResolvidas } from "./mencoes-de-grupo";

const MARIA = { lid: "75235009282237", phone: null, name: "Maria Exemplo" };
const DESCONHECIDO = { lid: "99887766554433", phone: null, name: null };

describe("textoComMencoesResolvidas — o que a tela mostra", () => {
  it("menção a quem está no CRM mostra o NOME", () => {
    expect(textoComMencoesResolvidas("oi @75235009282237, tudo bem?", [MARIA])).toBe(
      "oi @Maria Exemplo, tudo bem?",
    );
  });

  it("menção a desconhecido continua com o número — comportamento de hoje", () => {
    expect(textoComMencoesResolvidas("oi @99887766554433", [DESCONHECIDO])).toBe("oi @99887766554433");
  });

  it("o texto cru NÃO é destruído: a função devolve outro texto e o corpo fica com o @lid", () => {
    const cru = "bom dia @75235009282237";
    const exibido = textoComMencoesResolvidas(cru, [MARIA]);
    expect(exibido).toBe("bom dia @Maria Exemplo");
    // O que vai para o banco é `cru` — a resolução é de LEITURA.
    expect(cru).toBe("bom dia @75235009282237");
  });

  it("menção repetida resolve CADA ocorrência pelo próprio LID, mesmo com a lista fora de ordem", () => {
    const outro = { lid: "22222222222222", phone: null, name: "Pedro" };
    // Lista invertida em relação ao texto: resolução por posição daria Pedro/João trocados.
    const texto = "@11111111111111 e @22222222222222 e @11111111111111";
    expect(textoComMencoesResolvidas(texto, [outro, { lid: "11111111111111", phone: null, name: "João" }])).toBe(
      "@João e @Pedro e @João",
    );
  });

  it("dois contatos chamados 'João' não trocam: cada lid leva o seu rótulo", () => {
    // Os dois primeiros nomes têm o MESMO prefixo: trocar por nome (ou resolver
    // por ordem) faz o "@João" do segundo virar o do primeiro.
    const joaoA = { lid: "11111111111111", phone: null, name: "João" };
    const joaoB = { lid: "22222222222222", phone: null, name: "João Pedro" };
    expect(textoComMencoesResolvidas("@22222222222222 e @11111111111111", [joaoA, joaoB])).toBe(
      "@João Pedro e @João",
    );
  });

  it("nome que veio com @ e dígitos não é reprocessado (uma passada só)", () => {
    const estranho = { lid: "11111111111111", phone: null, name: "Maria @22222222222222" };
    expect(textoComMencoesResolvidas("@11111111111111", [estranho])).toBe("@Maria @22222222222222");
  });

  it("CONTROLE: mensagem sem menção sai byte a byte igual", () => {
    const texto = "reunião às 14h, @todos — sem menção de contato, 75235009282237 sem arroba";
    expect(textoComMencoesResolvidas(texto, [])).toBe(texto);
    // Nem passa pelo replace quando não há nada resolvido.
    expect(textoComMencoesResolvidas(texto, [DESCONHECIDO])).toBe(texto);
  });

  it("corpo nulo continua nulo", () => {
    expect(textoComMencoesResolvidas(null, [MARIA])).toBeNull();
  });

  it("arroba fora da faixa de LID (e-mail, nome curto) não é tocada", () => {
    const texto = "fala com maria@exemplo.com ou com @todos";
    expect(textoComMencoesResolvidas(texto, [MARIA])).toBe(texto);
  });
});

describe("lerMencoesDeGrupo — o metadata de fora, validado", () => {
  it("lê a lista gravada pelo ingest", () => {
    expect(lerMencoesDeGrupo({ mentions: [MARIA, DESCONHECIDO] })).toEqual([MARIA, DESCONHECIDO]);
  });

  it("metadata sem a chave, de outro tipo ou ausente devolve lista vazia", () => {
    expect(lerMencoesDeGrupo(null)).toEqual([]);
    expect(lerMencoesDeGrupo(undefined)).toEqual([]);
    expect(lerMencoesDeGrupo("mentions")).toEqual([]);
    expect(lerMencoesDeGrupo({ group_sender: MARIA })).toEqual([]);
    expect(lerMencoesDeGrupo({ mentions: "não é lista" })).toEqual([]);
  });

  it("item fora do contrato é descartado SEM derrubar os outros", () => {
    expect(lerMencoesDeGrupo({ mentions: [{ lid: "abc" }, MARIA] })).toEqual([MARIA]);
  });
});

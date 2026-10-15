/**
 * A JANELA DE MANUTENÇÃO FALA TODOS OS IDIOMAS QUE O PRODUTO SERVE — #2388.
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * O PR #2673 introduziu as frases da pausa agendada em português (a chave é o
 * próprio texto, em `lib/i18n/dicionario.ts`), espanhol (`dicionario.ts`) e
 * inglês (`lib/i18n/traducoes/en.json`) — e não no catálogo chinês
 * (`lib/i18n/traducoes/zh-CN.json`). Ficou declarado como pendência no corpo
 * daquele PR. Aqui a lacuna é fechada e VIGIADA: a mesma lista de chaves da
 * janela de manutenção tem de existir em todo catálogo que o produto carrega.
 *
 * ─── Por que uma lista fixa, e não derivada do dicionário ───────────────────
 *
 * A régua de completude do repositório não conta chave faltando (decisão 18.2:
 * frase sem tradução cai no português). Este caso é a EXCEÇÃO deliberada para
 * as frases da janela de manutenção: elas são a entrega da #2388, e a promessa
 * "aparece em qualquer idioma servido" precisa de quem a cobre. Derivar a lista
 * do `dicionario.ts` faria a cerca concordar com o que lá estiver — inclusive
 * com a chave que alguém apagou sem querer. Fixa, ela só encolhe se alguém
 * apagar a chave AQUI, e aí o vermelho é o ponto.
 *
 * ─── Cerca ──────────────────────────────────────────────────────────────────
 *
 * Só lê arquivos do repositório (nenhum DOM, nenhum terceiro): roda no projeto
 * `cercas`, que é o primeiro a reprovar um PR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** As chaves da janela de manutenção que o #2673 introduziu (pt é a própria chave). */
const CHAVES_DA_JANELA = [
  "Agendar pausa",
  "Janela de manutenção",
  "A pausa e a retomada acontecem sozinhas no horário marcado. A mensagem que chegar durante a pausa fica gravada e volta na retomada.",
  "A pausa começa (hora local)",
  "A pausa termina (hora local)",
  "Fuso da organização",
  "Para todas as conexões",
  "Janelas agendadas",
  "Cancelar janela",
  "Agendando…",
  "Informe os dois horários da janela.",
  "O fim precisa ser depois do início.",
  "Janela agendada: a pausa e a retomada acontecem sozinhas.",
  "Não foi possível agendar a janela.",
  "Janela cancelada. O que ela já pausou continua pausado.",
  "Não foi possível cancelar a janela.",
];

const RAIZ = join(__dirname, "..", "..");
const catalogo = (codigo: string) =>
  JSON.parse(readFileSync(join(RAIZ, "lib", "i18n", "traducoes", `${codigo}.json`), "utf8")) as Record<
    string,
    string
  >;

describe("as frases da janela de manutenção em todo catálogo", () => {
  it("a lista cobre o vocabulário novo — o verde abaixo não é vacuidade", () => {
    expect(CHAVES_DA_JANELA.length).toBe(16);
    expect(new Set(CHAVES_DA_JANELA).size).toBe(CHAVES_DA_JANELA.length);
  });

  it.each(["en", "zh-CN"])("%s tem todas as chaves, com texto próprio", (codigo) => {
    const entradas = catalogo(codigo);
    const faltando = CHAVES_DA_JANELA.filter((chave) => !(chave in entradas));
    expect(faltando, `${codigo} sem ${faltando.length} chave(s) da janela de manutenção`).toEqual([]);

    // Traduzido, não a chave colada: o valor é texto e não repete o português.
    const coladas = CHAVES_DA_JANELA.filter(
      (chave) => typeof entradas[chave] !== "string" || entradas[chave].trim() === "" || entradas[chave] === chave,
    );
    expect(coladas, `${codigo} com ${coladas.length} chave(s) sem tradução`).toEqual([]);
  });

  it("o catálogo chinês traz as frases da janela em chinês, não em português", () => {
    const zh = catalogo("zh-CN");
    for (const chave of CHAVES_DA_JANELA) {
      // Han (CJK Unified Ideographs) e/ou pontuação CJK: a frase foi traduzida.
      expect(zh[chave], `"${chave}" ficou sem caracteres chineses`).toMatch(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/);
    }
  });
});

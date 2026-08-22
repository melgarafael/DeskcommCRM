/**
 * A TRADUÇÃO NÃO PODE FICAR PARA TRÁS DO ORIGINAL EM SILÊNCIO.
 *
 * ## O defeito que fez este arquivo existir
 *
 * `docs/white-label.md` é o guia comercial do revendedor — o texto que alguém lê
 * antes de vender uma instalação. Ele não tinha tradução, e o rodapé dizia por
 * quê: *"sem um gate que reprove tradução defasada, três cópias divergem no
 * primeiro conserto seguinte — e um guia comercial errado em inglês é pior que
 * um guia inexistente."*
 *
 * O modo de falha é o mais silencioso que existe: markdown errado compila,
 * `typecheck` passa, `lint` passa, e uma tradução de três meses atrás parece na
 * tela exatamente igual a uma tradução de hoje. O leitor de inglês não tem como
 * saber que a frase que ele está lendo foi corrigida no original.
 *
 * ## Os quatro casos, e por que são quatro
 *
 * Cada um cobre um modo de falha que os outros três deixam passar:
 *
 * 1. **arquivo existe** — alguém apaga a tradução e o par some do disco sem o
 *    manifesto notar;
 * 2. **linha 1 é um selo** — a tradução nasce sem selo (o caso normal de quem
 *    cria o arquivo à mão) e nunca entra sob o gate;
 * 3. **o caminho DENTRO do selo é o do manifesto** — selo copiado de outro
 *    arquivo. Este é o único que os outros três não pegam: ele existe, casa a
 *    regex e carrega um hash legítimo — só que de outro original;
 * 4. **o hash bate** — o caso que faz o arquivo existir: o original mudou e a
 *    tradução não acompanhou.
 *
 * ## Por que a vacuidade vem antes de tudo
 *
 * As quatro asserções rodam sobre uma lista. Lista vazia dá quatro zeros e um
 * verde — indistinguível de "nenhuma tradução defasada". `conferirVacuidade`
 * LANÇA, e é a mesma função que o script chama: uma checagem, não duas.
 *
 * ## O que este arquivo NÃO guarda
 *
 * Não guarda os três READMEs, e a ausência é decisão declarada — a razão medida
 * está no cabeçalho de `scripts/selar-traducao.selo.ts` e no rodapé do próprio
 * `docs/white-label.md`. Não guarda a QUALIDADE da tradução: o selo prova que
 * alguém olhou o original naquele estado, nunca que traduziu bem. E não impede
 * `--todas` sem traduzir; contra isso o que existe é o padrão do script ser
 * conferir, e o aviso escrito nele.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMANDO_DE_RESELO,
  SELO,
  TRADUCOES,
  conferirVacuidade,
  hashDoOriginal,
  lerSelo,
} from "../../scripts/selar-traducao.selo";

const raiz = (relativo: string) => path.join(process.cwd(), relativo);

describe("o manifesto de traduções está vivo", () => {
  it("tem pelo menos um par — senão as asserções abaixo passam sobre nada", () => {
    expect(() => conferirVacuidade(TRADUCOES)).not.toThrow();
  });
});

describe("hashDoOriginal", () => {
  it("ignora fim de linha e espaço à direita — senão o gate acende sem defeito", () => {
    // Um editor com CRLF ou um `prettier --write` reprovariam toda tradução sem
    // que uma palavra do texto tivesse mudado, e o conserto aprendido seria
    // re-selar no automático.
    const lf = "# Título\n\nUm parágrafo.\n";
    expect(hashDoOriginal("# Título\r\n\r\nUm parágrafo.\r\n")).toBe(hashDoOriginal(lf));
    expect(hashDoOriginal("# Título   \n\nUm parágrafo.\t\n")).toBe(hashDoOriginal(lf));
    expect(hashDoOriginal("# Título\n\nUm parágrafo.\n\n\n")).toBe(hashDoOriginal(lf));
  });

  it("muda quando o TEXTO muda — inclusive por uma palavra", () => {
    expect(hashDoOriginal("A cor é derivada.\n")).not.toBe(hashDoOriginal("A cor é aplicada.\n"));
  });
});

describe.each(TRADUCOES)("$traducao ($idioma)", (par) => {
  it("existe no disco", () => {
    expect(existsSync(raiz(par.traducao)), `${par.traducao} sumiu do disco`).toBe(true);
  });

  it("tem um selo na linha 1", () => {
    // `.trimEnd()` pelo mesmo motivo que `lerSelo` o faz: num checkout Windows a
    // linha 1 termina em `\r`, e `SELO` ancora em `$`. Sem isto o gate reprova as
    // DUAS traduções — com o selo correto no arquivo — e manda re-selar, que é
    // exatamente o hábito que `hashDoOriginal` normaliza CRLF para evitar. O teste
    // guardava a regra e quebrava a própria regra.
    const primeira = (readFileSync(raiz(par.traducao), "utf8").split("\n", 1)[0] ?? "").trimEnd();
    expect(primeira, `${par.traducao} não começa com o selo. Rode: ${COMANDO_DE_RESELO}`).toMatch(
      SELO,
    );
  });

  it("o selo aponta para o original deste par, e não para outro arquivo", () => {
    const selo = lerSelo(readFileSync(raiz(par.traducao), "utf8"));
    expect(
      selo?.original,
      `o selo de ${par.traducao} cita outro original — selo copiado de outro arquivo`,
    ).toBe(par.original);
  });

  it("o hash do selo é o do original de HOJE", () => {
    const selo = lerSelo(readFileSync(raiz(par.traducao), "utf8"));
    const esperado = hashDoOriginal(readFileSync(raiz(par.original), "utf8"));
    expect(
      selo?.hash,
      `${par.original} mudou e ${par.traducao} não acompanhou. ` +
        `Traduza a mudança e então rode: ${COMANDO_DE_RESELO}`,
    ).toBe(esperado);
  });
});

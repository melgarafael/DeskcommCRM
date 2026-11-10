/**
 * O CÓDIGO DA RECUSA NO ENVIO EXISTE NOS TRÊS LUGARES QUE PRECISAM CONCORDAR.
 *
 * ## O defeito que este arquivo vigia
 *
 * `fn_definir_aviso_de_caso` recusa um número de conexão da PRÓPRIA organização
 * — é o laço robô-com-robô. A pergunta é feita só ao DEFINIR o aviso, e uma
 * conexão ARQUIVADA deixou de contar (não envia nem recebe, então não fechava
 * laço). Arquivar não apaga a linha: REATIVAR é gravar `archived_at = null` de
 * novo. Se o número da conexão já estava gravado como destino, nenhuma checagem
 * volta a rodar e o aviso sai para um número atendido por um agente desta
 * organização.
 *
 * O motor passou a repetir a pergunta no ENVIO. Quando ela reprova, a entrega é
 * CONDEMADA com um código novo — e é esse código que precisa existir em três
 * lugares que falam o mesmo vocabulário fechado:
 *
 *   1. `ERROS_DA_ENTREGA_DE_AVISO` (o tipo que o motor usa);
 *   2. `FRASE_DO_ERRO_DO_AVISO` (a frase que a tela mostra — `satisfies`
 *      garante que um código sem frase não compila, e o teste confirma que ela
 *      tem par `es` no dicionário);
 *   3. o CHECK `entregas_de_aviso_de_caso_erro_codigo_check`, nos DOIS
 *      artefatos de schema.
 *
 * O item 3 é o que este arquivo mede contra os arquivos: um código no TypeScript
 * sem o CHECK correspondente vira `23514` no UPDATE que o próprio motor faz
 * logo depois de decidir a recusa — e a entrega fica `pendente` sem
 * diagnóstico. A comparação contra o Postgres de verdade é do invariante
 * `vocabulario-banco-x-typescript`, que roda a cada PR; aqui a medida é
 * estática, e por isso roda no `test:unit`.
 *
 * ## Por que comparar CADEIA × BASELINE, e não só procurar o valor
 *
 * `test:db` aplica só o `baseline.sql`, e é ele que o self-hoster recebe. Se a
 * migration 0439 trouxesse o valor e o baseline ficasse para trás, quem aplica a
 * cadeia teria o código e quem instala numa VPS não — e nenhum gate veria, porque
 * cada artefato isolado está correto. É o modo de falha que
 * `apendice-do-baseline-nao-diverge-da-cadeia` cobre para FUNÇÃO; aqui se cobre
 * o mesmo eixo para o vocabulário de um CHECK.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  ERROS_DA_ENTREGA_DE_AVISO,
  FRASE_DO_ERRO_DO_AVISO,
} from "@/lib/escalacao/vocabulario-do-aviso";

const RAIZ = join(process.cwd(), "supabase");
const MIGRATIONS = join(RAIZ, "migrations");
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

/** O código que a recusa no envio grava. */
const CODIGO = "destino_da_propria_organizacao";

/** O nome da constraint — é ele que torna a medida ancorada, e não por substring. */
const CONSTRAINT = "entregas_de_aviso_de_caso_erro_codigo_check";

/**
 * Os literais do ÚLTIMO `check (...)` da constraint, em ORDEM de arquivo.
 *
 * `lastIndexOf`/`rfind`, nunca `find`: o baseline é dump + apêndice e a ÚLTIMA
 * definição é a que o Postgres deixa de pé. Ancorar na primeira mede a definição
 * morta — no baseline o dump traz a lista ORIGINAL da 0292, e é justamente a que
 * NÃO vale.
 */
function literaisDoCheck(texto: string): string[] {
  const i = texto.lastIndexOf(CONSTRAINT);
  expect(i, `a constraint ${CONSTRAINT} sumiu do artefato`).toBeGreaterThan(-1);
  // Do nome da constraint até o primeiro `check (` que vem depois dele.
  const abre = texto.indexOf("check (", i);
  expect(abre, "nenhum `check (` depois do nome da constraint").toBeGreaterThan(-1);
  const fecha = texto.indexOf("));", abre);
  expect(fecha, "o `check (` não fecha").toBeGreaterThan(-1);
  const corpo = texto.slice(abre, fecha);
  // Os literais entre apóstrofos, na ordem em que estão no arquivo.
  return [...corpo.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** As migrations que nomeiam a constraint, em ordem de aplicação. */
const naCadeia = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((arquivo) => ({ arquivo, texto: readFileSync(join(MIGRATIONS, arquivo), "utf8") }))
  .filter((x) => x.texto.includes(CONSTRAINT));

describe("o código da recusa no envio, no vocabulário fechado", () => {
  it("a sonda está viva — a constraint existe na cadeia e no baseline", () => {
    // Sem este controle, um `lastIndexOf` que voltasse -1 faria os casos abaixo
    // passarem por vacuidade: é a armadilha do instrumento quebrado devolvendo
    // zero, e a lista vazia lê exatamente como "está tudo certo".
    expect(naCadeia.length, "nenhuma migration nomeia a constraint").toBeGreaterThan(0);
    expect(BASELINE, "a constraint sumiu do baseline").toContain(CONSTRAINT);
  });

  it("está na tupla do TypeScript", () => {
    expect(ERROS_DA_ENTREGA_DE_AVISO).toContain(CODIGO);
  });

  it("tem frase de gente E par em espanhol — senão a tela mostra código cru", () => {
    // `satisfies Record<…>` já garante a frase no typecheck; esta asserção é o
    // que sobrevive a alguém trocar o `satisfies` por uma anotação solta.
    const frase = FRASE_DO_ERRO_DO_AVISO[CODIGO as keyof typeof FRASE_DO_ERRO_DO_AVISO];
    expect(typeof frase, "código sem frase: a tela mostraria o identificador cru").toBe("string");
    // A chave do dicionário é o próprio texto em português (padrão do repo).
    const entrada = DICIONARIO[frase];
    expect(entrada, `sem entrada no dicionário para: ${JSON.stringify(frase)}`).toBeTruthy();
    expect(entrada!.es, "a frase do aviso não tem espanhol").toBeTruthy();
  });

  it("os DOIS artefatos de schema aceitam o código — e dizem a MESMA coisa", () => {
    const daCadeia = literaisDoCheck(naCadeia.at(-1)!.texto);
    const doBaseline = literaisDoCheck(BASELINE);

    expect(
      daCadeia,
      "a migration nova não acrescentou o código ao CHECK: o UPDATE do motor estouraria 23514",
    ).toContain(CODIGO);
    expect(
      doBaseline,
      "o baseline ficou para trás: quem instala numa VPS não receberia o código novo",
    ).toContain(CODIGO);

    // ⚠️ A ordem também é comparada. O gate da casa
    // (`check-do-baseline-nao-diverge-da-cadeia`) compara CONJUNTO; aqui a ordem
    // é comparada de propósito porque é assim que os dois blocos são escritos —
    // e uma lista reordenada de um lado só é sinal de que um dos dois foi
    // reconstruído por alguém que não olhou o outro.
    expect(doBaseline, "cadeia e baseline listam o vocabulário em ordens diferentes").toEqual(
      daCadeia,
    );
  });

  it("o vocabulário do TIPO é exatamente o do CHECK — nenhum sobre, nenhum falta", () => {
    // Não é redundante com `vocabulario-banco-x-typescript`: aquele compara com o
    // Postgres que nasce do baseline e roda SÓ no job `invariants`. Este roda no
    // `verify`, e reprova no mesmo PR que escreveu o código sem a constraint.
    const daCadeia = literaisDoCheck(naCadeia.at(-1)!.texto);
    expect([...ERROS_DA_ENTREGA_DE_AVISO].sort()).toEqual([...daCadeia].sort());
  });
});

describe("a recusa não é silêncio — o registro do desfecho", () => {
  /**
   * O motor PRECISA usar o código novo na recusa.
   *
   * O caso de comportamento (não envia e grava o código) mora em
   * `aviso-de-caso-decide.test.ts`, com banco e transporte falsos — e é o que
   * prova o desfecho. Esta asserção é a sonda de que o código NOVO é o que está
   * ligado ali, e não um `canal_arquivado` genérico que faria o caso de
   * comportamento passar por acidente.
   */
  it("o motor condena a entrega com este código, e não com um genérico", () => {
    const motor = readFileSync(
      join(process.cwd(), "lib", "escalacao", "aviso-ao-suporte.ts"),
      "utf8",
    );
    // A sonda fixa a CHAMADA, não o argumento: desde o #3803 o destino é o
    // número resolvido (`numeroDoAviso`), e não mais `cfg.telefone_destino` —
    // fixar a variável aqui reprovaria uma mudança correta e ensinaria a
    // atualizar a cerca sem pensar, que é como uma cerca deixa de valer.
    const i = motor.indexOf("destinoEhDaPropriaOrganizacao(orgId, ");
    expect(
      i,
      "o motor deixou de conferir o destino antes de enviar — o laço volta a ser possível",
    ).toBeGreaterThan(-1);
    // A janela é generosa de propósito: ela existe para exigir que a checagem e a
    // recusa estejam no MESMO ramo, não para medir quantas linhas cabem entre elas.
    const ramo = motor.slice(i, i + 700);
    expect(ramo, "a recusa da guarda não usa o código próprio").toContain(
      `"${CODIGO}"`,
    );
    expect(ramo, "a recusa chama \`condena\` — sem isso não há linha, nem Central").toContain(
      "condena(",
    );
  });
});

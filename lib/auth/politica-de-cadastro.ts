/**
 * A instalação aceita cadastro aberto, ou só quem foi convidado?
 *
 * ─── Por que isto existe ────────────────────────────────────────────────────
 *
 * `/signup` sempre foi aberto e não havia como fechá-lo pelo produto. Quem
 * hospeda a própria instalação e vende tenant precisa que só convidado entre —
 * e a única saída era bloquear a rota no proxy reverso. Medido numa instalação
 * real em 2026-09-10: a regra de nginx que fazia isso barrava junto o
 * `/signup?invite=…`, ou seja, o convite, que é exatamente quem deveria passar.
 * Regra de infraestrutura não sabe o que é um convite; o produto sabe.
 *
 * ─── O default é `aberto`, e não é opinião ──────────────────────────────────
 *
 * Regra 6 da doutrina de packaging: configuração nova nasce com o default que
 * PRESERVA o comportamento anterior. Toda instalação que já existe segue
 * aceitando cadastro como hoje até alguém escolher o contrário.
 *
 * Quem quer outro padrão declara em `SIGNUP_MODE` no `.env` — ver
 * `padraoDaInstalacao()` abaixo. O banco continua acima do `.env`: havendo linha
 * em `platform_settings`, é ela que vale.
 *
 * ─── A leitura é PEGAJOSA, e este é o ponto de segurança do módulo ──────────
 *
 * Se o banco não responde, a pergunta "aceita cadastro aberto?" não tem
 * resposta honesta. As duas saídas ingênuas são ruins:
 *
 *   - responder `aberto` sempre → uma instalação fechada reabre sozinha durante
 *     um soluço do banco, e ninguém percebe;
 *   - responder `so_convite` sempre → toda instalação que ainda não aplicou a
 *     migration 0232 (a tabela não existe: `42P01`) para de aceitar cadastro,
 *     inclusive quem nunca pediu para fechar. É o oposto de "preserva o
 *     comportamento anterior".
 *
 * Então a regra é: **o último valor lido com sucesso vale**, e só quando nunca
 * houve leitura boa é que o piso da instalação entra. Assim a instalação fechada
 * continua fechada durante uma falha, e a que nunca teve a tabela continua
 * aberta.
 *
 * A memória morre com o processo. Um reinício com o banco ainda fora do ar não
 * tem último valor nenhum — e é exatamente aí que `SIGNUP_MODE` responde, que é
 * por que ele existe.
 *
 * ─── O memo mora em `globalThis` ────────────────────────────────────────────
 *
 * Pelo mesmo motivo medido em `lib/branding/instalacao.ts`: um `let` de arquivo
 * é por INSTÂNCIA DE MÓDULO, e o Next instancia este módulo duas vezes no mesmo
 * processo — um runtime para `route.js` e outro para `page.js`. Aqui isso não é
 * teórico: quem GRAVA é uma server action (runtime de página) e um dos pontos
 * que LÊ é `app/auth/confirm/route.ts` (runtime de rota). Com um `let`, fechar
 * o cadastro pela tela não alcançaria a rota que provisiona a organização —
 * justamente a trava que mais importa — até o TTL expirar.
 */

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export type ModoDeCadastro = "aberto" | "so_convite";

export const MODOS_DE_CADASTRO: readonly ModoDeCadastro[] = ["aberto", "so_convite"];

/**
 * O PISO da instalação: o que vale quando o banco nunca respondeu nesta vida do
 * processo. Sai do `.env`, e o padrão dele é `aberto`.
 *
 * ─── Por que o `.env` participa disto, se o banco é a fonte ─────────────────
 *
 * Mesma divisão de papéis que a marca da instalação já usa (`APP_NAME` e
 * companhia): **o banco está ACIMA do `.env`** — havendo linha em
 * `platform_settings`, é ela que manda, e a tela de admin escreve nela. O `.env`
 * é SEMENTE e PISO: ele responde nas duas situações em que o banco não tem o que
 * dizer, e só nelas.
 *
 *   1. instalação que nunca abriu a tela (não há linha) — o `.env` declara com o
 *      que ela nasce;
 *   2. o app subiu e ainda não conseguiu ler o banco — sem isto, uma instalação
 *      deliberadamente fechada abriria durante essa janela cega.
 *
 * Sem esta variável, quem exige "só se entra por convite, sempre" não tinha como
 * declarar isso: a memória do último valor lido morre quando o processo
 * reinicia, e um reinício com o banco fora do ar caía no padrão do produto.
 *
 * ─── Por que NÃO é `z.enum` no `lib/env.ts` ────────────────────────────────
 *
 * Porque `lib/env.ts` lança no import do módulo, e no Next isso acontece na
 * PRIMEIRA REQUISIÇÃO — com o healthcheck do contêiner sendo um probe TCP, o
 * Docker mostraria `healthy` com 100% das requisições em 500. É o mesmo motivo
 * escrito ao lado de `APP_ACCENT_HEX`. Valor irreconhecível degrada aqui, com
 * ERRO no log, e a tela de admin mostra o que o `.env` declara.
 *
 * Valor irreconhecível cai em `aberto`, e não em `so_convite`, de propósito: um
 * `SIGNUP_MODE=aberot` digitado errado não pode FECHAR a porta de uma instalação
 * que nunca pediu para ser fechada. Quem exige o fechamento tem o mecanismo
 * primário — a linha no banco — e este piso é a segunda camada, não a primeira.
 */
export function padraoDaInstalacao(): ModoDeCadastro {
  const declarado = (env.SIGNUP_MODE ?? "").trim();
  if (declarado === "") return "aberto";
  if (ehModoDeCadastro(declarado)) return declarado;
  avisarUmaVez(`env|${declarado}`, { SIGNUP_MODE: declarado }, "erro");
  return "aberto";
}

export function ehModoDeCadastro(valor: unknown): valor is ModoDeCadastro {
  return typeof valor === "string" && MODOS_DE_CADASTRO.includes(valor as ModoDeCadastro);
}

/**
 * Curto: cadastro é ação rara, e o custo de uma leitura a mais é irrelevante
 * perto de a tela demorar a refletir uma escolha de quem administra. Mesmo
 * raciocínio (e mesmo valor) do memo da marca da instalação.
 */
const TTL_MS = 30_000;

type Memoria = { readonly modo: ModoDeCadastro; readonly expiraEm: number };

declare global {
  var __memoDoModoDeCadastro: Memoria | undefined;
  /** O último valor LIDO COM SUCESSO. Sobrevive à expiração do memo. */
  var __ultimoModoDeCadastroConhecido: ModoDeCadastro | undefined;
  /** Sobe a cada escrita; impede leitura em voo de reinstalar valor pré-escrita. */
  var __geracaoDoModoDeCadastro: number | undefined;
}

/** Chamada por quem ESCREVE o modo. */
export function invalidarModoDeCadastro(): void {
  globalThis.__geracaoDoModoDeCadastro = (globalThis.__geracaoDoModoDeCadastro ?? 0) + 1;
  globalThis.__memoDoModoDeCadastro = undefined;
}

/** Só para os testes: devolve o processo ao estado de quem nunca leu nada. */
export function esquecerModoDeCadastro(): void {
  globalThis.__memoDoModoDeCadastro = undefined;
  globalThis.__ultimoModoDeCadastroConhecido = undefined;
  globalThis.__geracaoDoModoDeCadastro = undefined;
}

const avisado = new Set<string>();

function avisarUmaVez(
  chave: string,
  contexto: Record<string, unknown>,
  nivel: "warn" | "erro" = "warn",
): void {
  if (avisado.has(chave)) return;
  avisado.add(chave);
  if (nivel === "erro") {
    logger.error(
      "política de cadastro: SIGNUP_MODE no .env não é 'aberto' nem 'so_convite'; vale 'aberto'",
      contexto,
    );
    return;
  }
  logger.warn(
    "política de cadastro: não deu para ler do banco; vale o último valor conhecido",
    contexto,
  );
}

/**
 * NUNCA LANÇA. É lida no caminho de renderizar `/signup` e no de confirmar
 * e-mail; uma exceção aqui viraria 500 na porta de entrada do produto.
 */
export async function modoDeCadastro(): Promise<ModoDeCadastro> {
  const memoria = globalThis.__memoDoModoDeCadastro;
  if (memoria && memoria.expiraEm > Date.now()) return memoria.modo;

  // Lida ANTES do await e conferida depois: sem isto, uma leitura que entrou em
  // voo antes de `invalidarModoDeCadastro()` volta com o valor PRÉ-ESCRITA e o
  // reinstala com TTL novo, desfazendo a invalidação — o mesmo lost-update
  // medido no memo da marca em 2026-08-20.
  const geracao = globalThis.__geracaoDoModoDeCadastro ?? 0;
  const lido = await lerModo();

  if (lido !== null) {
    globalThis.__ultimoModoDeCadastroConhecido = lido;
  }
  const valor = lido ?? globalThis.__ultimoModoDeCadastroConhecido ?? padraoDaInstalacao();

  if ((globalThis.__geracaoDoModoDeCadastro ?? 0) === geracao) {
    globalThis.__memoDoModoDeCadastro = { modo: valor, expiraEm: Date.now() + TTL_MS };
  }
  return valor;
}

/** `null` = o banco não falou. Linha ausente NÃO é isso: é o default, com sucesso. */
async function lerModo(): Promise<ModoDeCadastro | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("signup_mode")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      avisarUmaVez(`leitura|${error.code ?? "?"}`, {
        codigo: error.code,
        detalhe: error.message,
      });
      return null;
    }
    // Sem linha = instalação que nunca configurou nada. É uma resposta, não uma
    // falha: vale o default, e ele fica sendo o "último conhecido".
    if (!data) return padraoDaInstalacao();

    const bruto = (data as { signup_mode?: unknown }).signup_mode;
    // O CHECK do banco já garante o vocabulário. Um valor fora dele só aparece
    // se alguém editou a coluna à mão depois de dropar a constraint — e aí a
    // leitura honesta é "não sei", que cai no último conhecido.
    return ehModoDeCadastro(bruto) ? bruto : null;
  } catch (erro) {
    avisarUmaVez("leitura|excecao", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/**
 * Grava o modo. Devolve `false` quando o banco recusou — quem chama transforma
 * isso em mensagem na tela, nunca em silêncio.
 */
export async function gravarModoDeCadastro(
  modo: ModoDeCadastro,
  atorUserId: string,
): Promise<boolean> {
  try {
    // `upsert` e não `update`: a linha só passa a existir quando alguém
    // configura algo. Instalação que nunca abriu esta tela não tem linha, e é
    // por isso que a leitura trata "sem linha" como o default.
    const { error } = await createAdminClient()
      .from("platform_settings")
      .upsert({ id: 1, signup_mode: modo, updated_by: atorUserId }, { onConflict: "id" });
    if (error) {
      logger.error("política de cadastro: não deu para gravar", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    invalidarModoDeCadastro();
    return true;
  } catch (erro) {
    logger.error("política de cadastro: gravação falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

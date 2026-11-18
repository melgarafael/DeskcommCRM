/**
 * QUAL MODELO DE DECISÃO RESPONDE — e por onde.
 *
 * O Deskcomm nasceu com o Jev fixo (`./origem`), porque o limiar de passagem
 * para humano foi calibrado sobre ele. A issue #4710 abre a escolha: o OpenRouter
 * serve uma categoria inteira de modelos de decisão (`output_modalities:
 * ["decisions"]`), e uma instalação pode querer um modelo gratuito numa tarefa
 * que só observa antes de deixar qualquer um decidir.
 *
 * ═══ O PADRÃO NÃO MUDA ═══
 *
 * Ninguém que nunca abriu a tela muda de comportamento: `modeloDaChamada` só
 * olha o modelo gravado quando a origem é `openrouter`. Origem `typesafe` (o
 * caminho de sempre) ignora o campo e devolve `jev-1.13.0` — inclusive quando o
 * campo ficou gravado por uma tentativa anterior. Isso não é detalhe: um modelo
 * da OpenRouter mandado para `api.typesafe.ai` com a chave da TypeSafe é uma
 * chamada recusada, e "a tela diz que escolhi" com o decisor mudo é o defeito
 * que esta guarda evita.
 *
 * ═══ UM MODELO POR CHAMADA ═══
 *
 * A escolha é da INSTALAÇÃO, e não da tarefa. O desenho atual separa o ESTADO
 * por tarefa (`./config`), mas não a chamada: `./pedidos` manda as perguntas de
 * `humano` e `opt_out` no MESMO request, e o fornecedor recebe um `model` só.
 * Modelo por tarefa exigiria partir essa chamada em duas — mais uma ida à rede
 * por mensagem, com o aceite de LGPD valendo para as duas —, e não é o que esta
 * primeira entrega faz.
 *
 * Este módulo é PURO: vocabulário e resolução. A lista do OpenRouter (rede,
 * cache, validação) mora em `./catalogo`, que importa daqui.
 */
import type { ConfigDoJev } from "./config";
import { MODELO_DA_TYPESAFE, MODELO_NA_OPENROUTER, modeloDaOrigem, type OrigemDoJev } from "./origem";

/**
 * Os nomes do Jev, nas duas formas que os fornecedores conhecem. É a lista que
 * diz "este modelo não precisa ser conferido no catálogo": ele é o padrão, e o
 * padrão nunca depende de rede (ver `./catalogo`).
 */
export const MODELOS_DO_JEV: readonly string[] = [MODELO_DA_TYPESAFE, MODELO_NA_OPENROUTER];

/** O nome é o do Jev, em qualquer das formas? */
export function ehModeloDoJev(modelo: string): boolean {
  return MODELOS_DO_JEV.includes(modelo.trim());
}

/**
 * O caminho que a chamada usa para aquele modelo.
 *
 * A OpenRouter separa os dois mundos: o endpoint de compatibilidade com o SDK da
 * TypeSafe (`/v1/systemone`) atende o Jev, e os outros modelos de decisão
 * respondem em `/alpha/decisions` — `https://openrouter.ai/api/alpha/decisions`,
 * medido na referência da API em 15/11/2026: mesma interface, mesmo corpo
 * (`model`/`state`/`questions`) e mesma resposta tipada. Mandar um modelo que
 * não é o Jev para `/v1/systemone` devolve 404 de modelo, que o cliente
 * traduziria em "a pergunta é nossa e está errada".
 *
 * O caminho é relativo à BASE, que já termina em `/api` (`./origem`,
 * `https://openrouter.ai/api`) — por isso `/alpha/decisions`, e não
 * `/api/alpha/decisions`: o `/api` já está lá.
 *
 * Na TypeSafe direta e num gateway compatível só existe `/v1/systemone`: a
 * origem `typesafe` nunca chega aqui com um modelo de fora (`modeloDaChamada`).
 */
export function caminhoDaChamada(modelo: string): string {
  return ehModeloDoJev(modelo) ? "/v1/systemone" : "/alpha/decisions";
}

/**
 * O modelo desta chamada, a partir da config da instalação.
 *
 * - origem `typesafe` ⇒ o Jev (o campo é ignorado; ver o cabeçalho);
 * - origem `openrouter` sem modelo gravado ⇒ o Jev, com o nome da OpenRouter;
 * - origem `openrouter` com modelo gravado ⇒ ele, conferido na escrita
 *   (`./catalogo`, `conferirModeloDaConfig`).
 */
export function modeloDaChamada(config: Pick<ConfigDoJev, "origem" | "modelo">): string {
  if (config.origem === "openrouter") {
    const escolhido = config.modelo?.trim();
    // Um nome do Jev gravado vale como o padrão: `jev-1.13.0` (o nome da
    // TypeSafe) mandado à OpenRouter seria recusado a cada mensagem.
    if (escolhido && !ehModeloDoJev(escolhido)) return escolhido;
  }
  return modeloDaOrigem(config.origem);
}

/**
 * QUEM RECEBE a mensagem com aquele modelo, para o aceite e o aviso de dado de
 * saúde o nomearem (doc 369): o prefixo do id na OpenRouter (`perplexity/…` ⇒
 * `perplexity`). O Jev é da TypeSafe AI em qualquer das formas do nome.
 */
export function fornecedorDoModelo(modelo: string): string {
  const id = modelo.trim();
  if (ehModeloDoJev(id)) return "TypeSafe AI";
  const barra = id.indexOf("/");
  return barra > 0 ? id.slice(0, barra) : id;
}

/** O padrão daquela origem — o que a tela mostra como "não escolhi nada". */
export function modeloPadrao(origem: OrigemDoJev): string {
  return modeloDaOrigem(origem);
}

/**
 * O MODELO APROVADO QUE LEVA O AVISO À EQUIPE — a regra, num lugar só.
 *
 * ## O defeito que este módulo fecha
 *
 * Fora da janela de 24 h, o número oficial só fala por modelo aprovado. O aviso
 * à equipe (de caso, de teste e a ação "Mensagem para a equipe") era texto
 * livre, e a tela "Aviso no WhatsApp" só oferecia conexão que manda texto livre
 * a qualquer hora. Uma organização cujo único número estável é o oficial nunca
 * conseguia avisar ninguém: o switch travava, a ação pulava e o aviso de caso
 * era condenado. A migration 9094 pôs `config_aviso_de_caso.modelo_id`; este
 * arquivo diz QUAL modelo serve e COMO o texto entra nele.
 *
 * ## Qual modelo serve
 *
 * Aprovado (`isStatusSendable`), desta organização e DESTA conexão (a regra de
 * `linhaDoEspelho`: a linha da conexão ou, no número oficial direto, a linha
 * sem conexão da conta dele) e com UMA variável só, de texto, no corpo. Uma
 * variável porque o aviso é um texto pronto (`montarAvisoDeCaso`, o resumo do
 * negócio): não há como repartir esse texto entre `{{1}}`, `{{2}}`… sem
 * inventar uma ordem que o modelo não declarou. Variável no cabeçalho ou em
 * botão também recusa — ninguém teria o que pôr nela.
 *
 * A mesma regra responde à rota (antes de gravar), à tela (o que oferecer) e
 * ao envio (de novo, porque o status muda na plataforma sem passar por aqui).
 *
 * ## Por que o texto vira UMA linha
 *
 * A plataforma recusa valor de variável com quebra de linha, tabulação ou mais
 * de quatro espaços seguidos (erro 132018). O aviso tem várias linhas; cada uma
 * vira um trecho separado por " · ". O teto existe porque o corpo inteiro do
 * modelo, com a variável dentro, tem limite — e o link, quando há, é o que NÃO
 * pode ser cortado: sem ele o aviso não leva a lugar nenhum.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { linhaDoEspelho, modelosDaConexao } from "@/lib/channels/linha-do-espelho";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { logger } from "@/lib/logger";

import type { ModeloOferecido } from "./estado-do-aviso";

/**
 * O teto do valor da variável. O corpo inteiro do modelo tem 1024 caracteres na
 * plataforma, e o texto fixo dele divide esse espaço com o aviso: 700 deixa
 * mais de 300 para o texto fixo, que é muito mais do que um modelo de aviso usa.
 */
export const TETO_DO_VALOR_DO_MODELO = 700;

const SEPARADOR = " · ";
const RETICENCIAS = "…";
const TEM_LINK = /https?:\/\//i;

/** As colunas de `meta_templates` que a regra lê. */
const COLUNAS = "id, name, language, status, components, parameter_format";

/** Uma linha de `meta_templates`, no mínimo que a regra precisa. */
export interface LinhaDoModelo {
  id: string;
  name: string;
  language: string;
  status: string;
  components: unknown;
  parameter_format?: string | null;
}

/** Um modelo que serve: o que o envio precisa para mandá-lo. */
export interface ModeloDoAviso {
  id: string;
  name: string;
  language: string;
  /** A chave da única variável: `"1"` no posicional, o nome no nomeado. */
  chave: string;
  /** O texto do corpo, com o marcador — é o que a tela mostra de prévia. */
  corpo: string;
}


export type MotivoDoModeloRecusado =
  | "inexistente"
  | "outra_conexao"
  | "nao_aprovado"
  | "variaveis"
  | "indeterminado";

export type AvaliacaoDoModelo =
  | { ok: true; modelo: ModeloDoAviso }
  | { ok: false; motivo: MotivoDoModeloRecusado };

/**
 * O texto do aviso numa linha só, dentro do teto, sem cortar o link.
 *
 * Pura. Os trechos com link entram sempre e inteiros; os outros entram na
 * ordem enquanto couberem, e o que transborda é cortado com reticências. Um
 * link sozinho maior que o teto é cortado também — é o único caso em que não
 * há escolha.
 */
export function umaLinhaParaOModelo(texto: string, teto: number = TETO_DO_VALOR_DO_MODELO): string {
  const trechos = texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "");
  const inteiro = trechos.join(SEPARADOR);
  if (inteiro.length <= teto) return inteiro;

  const links = trechos.filter((t) => TEM_LINK.test(t));
  const espacoDosLinks = links.reduce((n, l) => n + l.length + SEPARADOR.length, 0);
  let sobra = teto - espacoDosLinks;
  const saida: string[] = [];
  for (const trecho of trechos) {
    if (TEM_LINK.test(trecho)) {
      saida.push(trecho);
      continue;
    }
    const custo = trecho.length + SEPARADOR.length;
    if (custo <= sobra) {
      saida.push(trecho);
      sobra -= custo;
      continue;
    }
    const cabe = sobra - SEPARADOR.length - RETICENCIAS.length;
    if (cabe > 0) saida.push(`${trecho.slice(0, cabe).trimEnd()}${RETICENCIAS}`);
    sobra = 0;
  }
  const resultado = saida.join(SEPARADOR);
  return resultado.length <= teto ? resultado : `${resultado.slice(0, teto - RETICENCIAS.length)}${RETICENCIAS}`;
}

/** O texto do componente BODY, que a tela mostra de prévia. */
function corpoDoModelo(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const c of components as Array<{ type?: unknown; text?: unknown }>) {
    if (String(c?.type ?? "").toUpperCase() === "BODY" && typeof c.text === "string") return c.text;
  }
  return "";
}

/**
 * Este modelo serve para o aviso? Pura — a regra que a rota, a tela e o envio
 * aplicam à linha que já acharam para a conexão.
 */
export function avaliarModeloDoAviso(linha: LinhaDoModelo): AvaliacaoDoModelo {
  if (!isStatusSendable(linha.status)) return { ok: false, motivo: "nao_aprovado" };
  const contrato = deriveTemplateContract({
    name: linha.name,
    language: linha.language,
    parameter_format: linha.parameter_format ?? undefined,
    components: (Array.isArray(linha.components) ? linha.components : []) as never,
  });
  const [unica, ...resto] = contrato.slots;
  if (!unica || resto.length > 0) return { ok: false, motivo: "variaveis" };
  if (unica.address.kind !== "body" || unica.expects !== "text") return { ok: false, motivo: "variaveis" };
  return {
    ok: true,
    modelo: {
      id: linha.id,
      name: linha.name,
      language: linha.language,
      chave: unica.key,
      corpo: corpoDoModelo(linha.components),
    },
  };
}

/**
 * O modelo `modeloId` serve para avisar pela conexão `channelSessionId`?
 *
 * O id aponta uma linha, mas quem vale é a definição DA CONEXÃO
 * (`linhaDoEspelho`, a mesma regra do passo de modelo do fluxo): dois números
 * podem espelhar o mesmo nome, e mandar a definição de outra conta é recusa
 * certa. `organization_id` filtrado à mão — quem chama pode estar com o client
 * de serviço.
 */
export async function carregarModeloDoAviso(
  db: SupabaseClient,
  entrada: { organizationId: string; channelSessionId: string; modeloId: string },
): Promise<AvaliacaoDoModelo> {
  const { data, error } = await db
    .from("meta_templates")
    .select("name, language")
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.modeloId)
    .maybeSingle();
  if (error) return { ok: false, motivo: "indeterminado" };
  const alvo = data as { name: string; language: string } | null;
  if (!alvo) return { ok: false, motivo: "inexistente" };

  const definicao = await linhaDoEspelho<LinhaDoModelo>(db, COLUNAS, {
    organizationId: entrada.organizationId,
    name: alvo.name,
    language: alvo.language,
    channelSessionId: entrada.channelSessionId,
  });
  if (definicao.error) return { ok: false, motivo: "indeterminado" };
  if (!definicao.data) return { ok: false, motivo: "outra_conexao" };
  return avaliarModeloDoAviso(definicao.data);
}

/**
 * O modelo EM VIGOR para avisar por esta conexão: o que está gravado em
 * `config_aviso_de_caso`, se a conexão gravada é esta e se ele ainda serve.
 * `null` em qualquer outro caso — quem chama decide o que a ausência significa.
 */
export async function modeloDoAvisoEmVigor(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ModeloDoAviso | null> {
  const { data, error } = await db
    .from("config_aviso_de_caso")
    .select("channel_session_id, modelo_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as { channel_session_id: string | null; modelo_id: string | null };
  if (linha.channel_session_id !== channelSessionId || !linha.modelo_id) return null;
  const avaliacao = await carregarModeloDoAviso(db, {
    organizationId,
    channelSessionId,
    modeloId: linha.modelo_id,
  });
  return avaliacao.ok ? avaliacao.modelo : null;
}

/**
 * Os modelos que a tela oferece para esta conexão: só os que servem.
 *
 * Falha de leitura vira lista VAZIA, com log: a tela então diz que não há
 * modelo, o que é verdade sobre o que ela conseguiu ver — e o switch fica
 * travado, que é o lado seguro.
 */
export async function modelosDoAvisoDaConexao(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ModeloOferecido[]> {
  const { data, error } = await modelosDaConexao<LinhaDoModelo>(db, COLUNAS, {
    organizationId,
    channelSessionId,
  });
  if (error) {
    logger.warn("[aviso-de-caso] modelos da conexão não lidos", {
      organizationId,
      channelSessionId,
      causa: error.message,
    });
    return [];
  }
  const oferecidos: ModeloOferecido[] = [];
  for (const linha of data) {
    const avaliacao = avaliarModeloDoAviso(linha);
    if (!avaliacao.ok) continue;
    oferecidos.push({
      id: avaliacao.modelo.id,
      nome: avaliacao.modelo.name,
      idioma: avaliacao.modelo.language,
      corpo: avaliacao.modelo.corpo,
    });
  }
  return oferecidos;
}

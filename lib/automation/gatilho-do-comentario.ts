/**
 * O gatilho "comentou a palavra num post do Instagram" (#4075).
 *
 * ─── Onde ele mora, e por que NÃO é um `if` paralelo ───────────────────────
 *
 * O motor de automação já sabe o que fazer com um evento: ele casa
 * `automation_rules.trigger_event` com `event_log.event_type`, avalia as
 * condições e executa as ações. O que faltava era (a) o comentário CHEGAR, e
 * (b) a regra poder RECORTAR o evento — "só o post Y", "só com a palavra X" —
 * do mesmo jeito que `lead.created` recorta por fonte de formulário
 * (`trigger_config.webhook_source_id`, #2553).
 *
 * Este módulo é o leitor dessa configuração e a régua do casamento. Quem o usa
 * é o registro de recortes (`lib/automation/recorte-do-gatilho.ts`), que o
 * motor consulta UMA vez por regra — não um ramo novo escrito dentro do motor.
 *
 * ─── A comparação é a MESMA das condições (`contains`) ─────────────────────
 *
 * `normalizarParaContains` (#2973) é a régua do repo para texto: minúsculas,
 * sem acento e pontuação virando espaço. Reusar a função — em vez de escrever
 * `toLowerCase().includes` aqui — é o que faz a palavra-chave do gatilho casar
 * exatamente o que a condição "texto contém" casaria. A diferença de
 * comportamento entre as duas seria invisível e o operador chamaria de azar.
 *
 * Limite declarado, herdado da mesma régua: é SUBSTRING do texto normalizado,
 * então "quero" casa "querosene". Quem precisa de palavra inteira escreve a
 * palavra inteira com o contexto ("quero o link"), que é o caso de uso real
 * ("comente QUERO que eu te mando o link").
 */
import { normalizarParaContains } from "@/lib/automation/conditions";

/** O nome do gatilho no `event_log`, na regra e no rótulo da tela. */
export const GATILHO_COMENTARIO = "instagram.comment";

/** Teto de posts por regra: um post viral não pode virar uma lista sem fim. */
export const MAXIMO_DE_POSTS = 20;

/** Teto de palavras por regra — o mesmo espírito do teto de condições. */
export const MAXIMO_DE_PALAVRAS = 20;

/** Tamanho máximo de uma palavra-chave, e de um id de post. */
export const TAMANHO_MAXIMO_DA_PALAVRA = 80;
export const TAMANHO_MAXIMO_DO_POST = 120;

/**
 * O que a regra guarda em `automation_rules.trigger_config`.
 *
 * `posts` VAZIO significa QUALQUER post do perfil — é o caso comum de quem
 * anuncia ("comente em qualquer post"). `palavras` NUNCA é vazio: sem palavra
 * não há gatilho, e uma regra assim responderia todo comentário do perfil,
 * inclusive os de reclamação.
 */
export interface ConfigDoComentario {
  posts: string[];
  palavras: string[];
}

function textoLimpo(v: unknown, limite: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > limite) return null;
  return t;
}

/** Lista de textos, sem vazios e sem repetição, preservando a ordem escrita. */
function listaDeTextos(bruto: unknown, limite: number, porItem: number): string[] | null {
  if (!Array.isArray(bruto) || bruto.length > limite) return null;
  const saida: string[] = [];
  for (const item of bruto) {
    const texto = textoLimpo(item, porItem);
    if (texto === null) return null;
    if (!saida.includes(texto)) saida.push(texto);
  }
  return saida;
}

/**
 * Lê a configuração como ela veio do banco (jsonb) ou da tela.
 *
 * `null` para linha malformada em vez de estourar: o motor avalia TODAS as
 * regras ativas do evento, e uma regra torta não pode derrubar as irmãs — ela
 * simplesmente não casa. É também o que o schema da API usa para recusar, na
 * porta, o que o operador mandaria errado.
 */
export function configDoComentario(bruto: unknown): ConfigDoComentario | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const c = bruto as Record<string, unknown>;

  const posts = listaDeTextos(c.posts ?? [], MAXIMO_DE_POSTS, TAMANHO_MAXIMO_DO_POST);
  if (posts === null) return null;

  const palavras = listaDeTextos(c.palavras, MAXIMO_DE_PALAVRAS, TAMANHO_MAXIMO_DA_PALAVRA);
  if (palavras === null || palavras.length === 0) return null;

  return { posts, palavras };
}

/** O comentário, na forma mínima que a régua precisa (payload do evento). */
export interface ComentarioDoEvento {
  post_id?: unknown;
  text?: unknown;
}

/**
 * O comentário casa com a configuração da regra?
 *
 * Sem configuração legível a resposta é `false` — e isso é o lado seguro: um
 * `trigger_config` torto não pode virar "vale para todo comentário".
 */
export function comentarioCasa(config: ConfigDoComentario | null, comentario: ComentarioDoEvento | null): boolean {
  if (!config || !comentario) return false;

  const post = typeof comentario.post_id === "string" ? comentario.post_id : null;
  if (!post) return false;
  if (config.posts.length > 0 && !config.posts.includes(post)) return false;

  const texto = typeof comentario.text === "string" ? comentario.text : "";
  const forma = normalizarParaContains(texto);
  if (!forma) return false;

  return config.palavras.some((palavra) => {
    const alvo = normalizarParaContains(palavra);
    // Palavra que a normalização esvazia (só pontuação) nunca casa: com alvo
    // vazio, `includes("")` casaria TODO comentário — a mesma armadilha que o
    // `formaDaRegra` das condições fecha (#2973).
    return alvo !== "" && forma.includes(alvo);
  });
}

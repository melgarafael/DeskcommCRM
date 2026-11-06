/**
 * O CONTATO DENTRO DE OUTRA ÁREA (Spec 33, F3; ADR-0005 D4).
 *
 * O consentimento por área vale para o DADO que vem na resposta, e não só para a rota. Conversa, negócio e
 * agenda trazem o contato junto (nome, telefone, etiquetas, bloqueio). Um módulo que tem `conversas` e não
 * tem `contatos` (leitura) recebe só o `id` do contato, que é opaco; o resto sai da resposta, no servidor.
 *
 * Sessão de navegador e token que não é de módulo não passam por aqui: veem tudo, como sempre viram.
 * LADO SEGURO: token de módulo SEM o campo `contatoVisivel` (nunca preenchido, teste que simula o
 * autorizador) é tratado como "não vê contato".
 *
 * A cerca `tests/unit/modulo-rota-com-contato-redige.test.ts` reprova rota que o módulo alcança, que
 * embute contato na resposta e não chama `redigirContatoParaModulo` (nem está justificada nela).
 */

interface AutorizacaoComModulo {
  actor: { type: string };
  contatoVisivel?: boolean;
}

/** `true` quando quem chama é um módulo que NÃO pode ver contato. */
export function moduloSemContato(authz: AutorizacaoComModulo): boolean {
  return authz.actor.type === "module" && authz.contatoVisivel !== true;
}

/** Chaves cujo valor é o OBJETO do contato (ou uma lista deles): ficam só com o `id`. */
const CHAVES_DO_OBJETO_DO_CONTATO: ReadonlySet<string> = new Set(["contacts", "contact"]);

/** Campos soltos de contato que algumas respostas trazem ao lado: viram `null`. */
const CAMPOS_SOLTOS_DE_CONTATO: ReadonlySet<string> = new Set([
  "contact_name",
  "contact_display_name",
  "contact_phone",
  "contact_email",
  "contact_links",
  "contact_tags",
]);

const PROFUNDIDADE_MAXIMA = 16;

function soOId(valor: unknown): unknown {
  if (valor === null || typeof valor !== "object") return null;
  const id = (valor as { id?: unknown }).id;
  return typeof id === "string" ? { id } : null;
}

function redigir(valor: unknown, profundidade: number): unknown {
  if (profundidade > PROFUNDIDADE_MAXIMA) return valor;
  if (Array.isArray(valor)) return valor.map((x) => redigir(x, profundidade + 1));
  if (valor === null || typeof valor !== "object") return valor;
  const saida: Record<string, unknown> = {};
  for (const [chave, x] of Object.entries(valor as Record<string, unknown>)) {
    if (CHAVES_DO_OBJETO_DO_CONTATO.has(chave)) {
      saida[chave] = Array.isArray(x) ? x.map(soOId) : x === null || x === undefined ? x : soOId(x);
    } else if (CAMPOS_SOLTOS_DE_CONTATO.has(chave)) {
      saida[chave] = null;
    } else {
      saida[chave] = redigir(x, profundidade + 1);
    }
  }
  return saida;
}

/**
 * Devolve `valor` como está, ou, para módulo sem `contatos`, uma cópia sem os dados do contato
 * (só `id`). Nunca altera o original: o handler é compartilhado com a sessão.
 */
export function redigirContatoParaModulo<T>(authz: AutorizacaoComModulo, valor: T): T {
  if (!moduloSemContato(authz)) return valor;
  return redigir(valor, 0) as T;
}

/**
 * Variáveis que o texto do e-mail aceita, e a prévia com um lead de exemplo.
 *
 * O nome da variável é português porque quem digita `{{primeiro_nome}}` no
 * corpo do e-mail é o vendedor, não o desenvolvedor.
 */

export interface VariavelDoEmail {
  chave: string;
  rotulo: string;
  exemplo: string;
}

export const VARIAVEIS_DO_EMAIL: VariavelDoEmail[] = [
  { chave: "primeiro_nome", rotulo: "Primeiro nome", exemplo: "Mariana" },
  { chave: "nome", rotulo: "Nome completo", exemplo: "Mariana Souza" },
  { chave: "empresa", rotulo: "Empresa", exemplo: "Celulose Riograndense" },
  { chave: "cargo", rotulo: "Cargo", exemplo: "Gerente de Compras" },
  { chave: "segmento", rotulo: "Segmento", exemplo: "Papel e celulose" },
  { chave: "vendedor", rotulo: "Nome do vendedor", exemplo: "Luiz" },
];

const PADRAO = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Troca `{{chave}}` pelo exemplo; variável desconhecida fica visível como está. */
export function renderizarExemplo(texto: string): string {
  const porChave = new Map(VARIAVEIS_DO_EMAIL.map((v) => [v.chave, v.exemplo]));
  return texto.replace(PADRAO, (inteiro, chave: string) => porChave.get(chave) ?? inteiro);
}

/** Variáveis usadas no texto que não existem — a tela avisa antes de ativar. */
export function variaveisDesconhecidas(texto: string): string[] {
  const validas = new Set(VARIAVEIS_DO_EMAIL.map((v) => v.chave));
  const out = new Set<string>();
  for (const m of texto.matchAll(PADRAO)) {
    if (m[1] && !validas.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

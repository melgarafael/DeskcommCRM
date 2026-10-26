/**
 * Substitui `{{variavel}}` pelo dado REAL do lead — a versão de produção de
 * `renderizarExemplo` (`variaveis.ts`, que usa dado fictício pra prévia).
 *
 * `empresa` e `cargo` NÃO têm coluna própria em `contacts` hoje (schema: id,
 * name, display_name, email, phone_number, tags...) — ficam com o placeholder
 * VISÍVEL quando não resolvidos, o mesmo comportamento de uma variável que não
 * existe: `{{empresa}}` aparecendo no e-mail é um sinal de dado faltando, e é
 * menos enganoso que um espaço em branco silencioso ("Vi que a  atua em...").
 * `segmento` resolve pela tag da PRÓPRIA cadência (`configuracao.tagDoSegmento`),
 * que é dado real e já existe — não precisa de coluna nova.
 */
const PADRAO = /\{\{\s*([a-z_]+)\s*\}\}/g;

export interface DadosParaRenderizar {
  nomeDoContato: string | null;
  nomeDoVendedor: string | null;
  segmento: string;
}

export function renderizarComLead(texto: string, dados: DadosParaRenderizar): string {
  const nomeCompleto = (dados.nomeDoContato ?? "").trim();
  const primeiroNome = nomeCompleto.split(/\s+/)[0] || "";
  const valores: Record<string, string | undefined> = {
    primeiro_nome: primeiroNome || undefined,
    nome: nomeCompleto || undefined,
    vendedor: dados.nomeDoVendedor?.trim() || undefined,
    segmento: dados.segmento || undefined,
  };
  return texto.replace(PADRAO, (inteiro, chave: string) => {
    if (!(chave in valores)) return inteiro; // variável desconhecida: fica visível
    return valores[chave] ?? inteiro; // conhecida mas sem dado: também fica visível
  });
}

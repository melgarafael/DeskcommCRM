import { requireAuth } from "@/lib/auth/server";
import { AjudaConteudo } from "./_client";

/**
 * A AJUDA DENTRO DO PRODUTO — o índice que faltava (issue #3567, fatia F1).
 *
 * ─── O problema que ela resolve ────────────────────────────────────────────
 *
 * O conteúdo sempre existiu — curso, guias e changelog. Só não existia ONDE a
 * dúvida acontece. Quem trava em "Vocabulário e campos" tinha de abrir outra
 * aba, procurar um artigo genérico e traduzi-lo para a tela onde estava. Cada
 * passo desse é um ponto de desistência que não aparece em relatório nenhum,
 * porque acontece antes do suporte.
 *
 * ─── O que esta fatia NÃO faz, de propósito ────────────────────────────────
 *
 * Não tem busca própria (o ⌘K já indexa o catálogo de navegação), não tem
 * prosa longa e não tem link externo. O artigo completo, versionado e com
 * capturas é a fatia F3; aqui é o índice do que dá para fazer agora.
 *
 * ─── Porta autenticada; conteúdo acompanha o contexto da interface ────────
 *
 * O corpo usa o MESMO AuthProvider do Sidebar, com papel, áreas combinadas,
 * módulos e capacidades já resolvidos no layout. O provider de idioma mantém
 * a troca instantânea pelo seletor; o servidor continua guardando esta porta.
 */
export const dynamic = "force-dynamic";

export default async function AjudaPage() {
  await requireAuth();
  return <AjudaConteudo />;
}

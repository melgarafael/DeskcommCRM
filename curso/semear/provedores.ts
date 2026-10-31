/**
 * Semente do módulo Provedores (/app/ai/providers).
 *
 * A tela já ensina com a base: o padrão da organização (Anthropic, Claude
 * Sonnet 5), o agente Bia publicado e o Jev desligado. A única coisa que uma
 * lição grava pela tela é a escolha de modelo de UM ponto — "Ver a imagem do
 * cliente" (`visao_de_imagem`) —, que vira uma linha em `ai_purpose_bindings`
 * (única por organização + ponto, com id gerado pela rota). Esta semente apaga
 * essa linha para a lição partir do ponto herdando o padrão
 * ("Usando o padrão da organização.").
 *
 * `limpar` é exportada porque a base a chama antes de QUALQUER aula: a escolha
 * gravada por uma rodada interrompida da lição não pode sobrar para a foto de
 * outro módulo (ela muda o "Usando:" do grupo "Ver e ouvir" e a contagem do
 * Modelo padrão).
 *
 * O "Modelo padrão" (organizations.settings.llm), o Jev e a chave de Mapas NÃO
 * são gravados pelas lições: o padrão vale para todas as telas e é devolvido ao
 * estado de fábrica pela base; o Jev e o "Testar" de Mapas chamariam serviços de
 * fora (TypeSafe, Google).
 *
 * Idempotente: só apaga; não cria linha nem texto visível (nada passa por demo()).
 */
import { type Contexto, semErro } from "../semear-demonstracao";

/**
 * Pontos cuja escolha as lições gravam pela tela. O `purpose` é o mesmo em PT e
 * em ES (não é texto visível), então esta lista cobre as duas línguas.
 */
const CRIADAS_NAS_LICOES = ["visao_de_imagem"];

export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(
    await db
      .from("ai_purpose_bindings")
      .delete()
      .eq("organization_id", org)
      .in("purpose", CRIADAS_NAS_LICOES),
    "limpar a escolha de modelo gravada pelas lições de Provedores",
  );
}

export async function semear(c: Contexto) {
  await limpar(c);
}

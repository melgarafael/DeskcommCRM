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
 * O "Modelo padrão" (organizations.settings.llm), o Jev e a chave de Mapas NÃO
 * são gravados pelas lições: o padrão vale para todas as telas e é devolvido ao
 * estado de fábrica pela base; o Jev e o "Testar" de Mapas chamariam serviços de
 * fora (TypeSafe, Google).
 *
 * Idempotente: só apaga; não cria linha nem texto visível (nada passa por demo()).
 */
import { type Contexto, semErro } from "../semear-demonstracao";

/** Pontos cuja escolha as lições gravam pela tela. */
const CRIADAS_NAS_LICOES = ["visao_de_imagem"];

export async function semear(c: Contexto) {
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

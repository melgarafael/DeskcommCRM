/**
 * O PRÓXIMO PASSO QUE O BANCO ESCREVE, e por que a tela o traduz.
 *
 * Quando uma mensagem nova abre uma demanda, a função do banco que a cria
 * (`fn_service_inbound`, no `supabase/baseline.sql`) grava este texto em
 * `demandas.proximo_passo` — fixo e em português, porque a função SQL não sabe o
 * idioma da organização. Numa operação em espanhol, o painel da conversa mostrava
 * "Responder à nova mensagem do cliente" em português (medido numa instalação
 * real em 27/09/2026: 90 demandas assim).
 *
 * É texto do SISTEMA, não de quem atende: a tela traduz só este valor exato. O
 * próximo passo escrito por uma pessoa sai como ela escreveu — dado, não interface.
 */
export const PROXIMO_PASSO_DA_MENSAGEM_NOVA = "Responder à nova mensagem do cliente";

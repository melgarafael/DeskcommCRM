/**
 * A etiqueta de quem já foi atendido.
 *
 * ⚠️ QUEM ESCREVE ESTE VALOR É O BANCO, não este arquivo: o trigger
 * `trg_agendamento_marca_cliente` (migration 0255) acrescenta a tag quando nasce
 * um agendamento, e o backfill da mesma migration a aplicou ao histórico. Aqui
 * ela existe para que a TELA não repita um literal que mora em SQL — e é por
 * isso que `tests/unit/tag-de-cliente.test.ts` compara esta constante com o que
 * a migration grava. Divergir seria um filtro que não acha ninguém, sem erro
 * nenhum para investigar.
 *
 * ⚠️ E ELA NÃO É A FONTE DA VERDADE. Quem responde "é cliente?" é
 * `contacts.first_service_at`: a tag é removível à mão e pelo PATCH de contatos
 * (que substitui `tags` por inteiro), e ancorar decisão nela faria alguém voltar
 * a ser lead por descuido de quem editou etiquetas. A tag serve para filtrar e
 * para o agente de IA ler; a coluna serve para decidir.
 */
export const TAG_DE_CLIENTE = "cliente";

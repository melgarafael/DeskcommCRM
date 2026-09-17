/**
 * A etiqueta de quem já foi atendido.
 *
 * ⚠️ QUEM ESCREVE ESTE VALOR É O BANCO, não este arquivo:
 * `fn_recalcular_cliente_do_contato` (migration 0262), chamada pelos triggers de
 * agendamento e por `fn_definir_cliente_pela_agenda` quando a organização liga
 * a regra. Aqui ela existe para que a TELA não repita um literal que mora em
 * SQL — e é por isso que `tests/unit/tag-de-cliente.test.ts` compara esta
 * constante com o que a migration grava. Divergir seria um filtro que não acha
 * ninguém, sem erro nenhum para investigar.
 *
 * ⚠️ E ELA NÃO É A FONTE DA VERDADE. Quem responde "é cliente?" é
 * `contacts.first_service_at`, e só com a regra ligada: a tag é removível à mão
 * e pelo PATCH de contatos (que substitui `tags` por inteiro), e ancorar decisão
 * nela faria alguém voltar a ser lead por descuido de quem editou etiquetas. A
 * tag serve para filtrar, para as automações e para o agente de IA ler; a
 * coluna serve para decidir.
 *
 * Este arquivo não importa nada de propósito: componentes de cliente o importam.
 */
export const TAG_DE_CLIENTE = "cliente";

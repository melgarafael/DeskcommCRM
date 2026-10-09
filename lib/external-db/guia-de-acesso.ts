/**
 * Comandos que o guia "Como criar um acesso só de leitura" mostra para MySQL.
 *
 * É texto de CÓDIGO, não de interface: não passa por t(). O formato (usuário novo
 * + view + GRANT SELECT só na view) é o que foi medido num MySQL 8 com
 * WordPress/WooCommerce (Spec 23, C1): o usuário só enxerga a view e é recusado
 * em wp_users. Nunca ensinar GRANT no banco inteiro (`banco.*`) nem ALL PRIVILEGES.
 */
export const SQL_MYSQL_CRIAR_USUARIO =
  "CREATE USER 'crm_leitura'@'%' IDENTIFIED BY 'TROQUE_POR_UMA_SENHA_FORTE';";

export const SQL_MYSQL_CRIAR_E_LIBERAR_VIEW = [
  "CREATE VIEW NOME_DO_BANCO.vitrine_do_assistente AS",
  "  SELECT id, nome, preco",
  "  FROM NOME_DO_BANCO.TABELA_DE_PRODUTOS",
  "  WHERE status = 'ativo';",
  "",
  "GRANT SELECT ON NOME_DO_BANCO.vitrine_do_assistente TO 'crm_leitura'@'%';",
].join("\n");

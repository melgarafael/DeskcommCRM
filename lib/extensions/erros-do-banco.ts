/**
 * Os códigos que as funções `fn_extensions_*` levantam (`raise … message='extension_…'`), com a
 * frase e o status HTTP de cada um.
 *
 * Um código que falte aqui não vira erro conhecido: o serviço responde 503 "não foi possível
 * confirmar o resultado", e a tela guarda o pedido como incerto até alguém reconciliar. Por isso
 * `lib/extensions/erros-do-banco.test.ts` lê o bloco da migration 0271 e exige cada código nesta
 * tabela. Módulo puro, sem cliente de banco.
 */
export const SQL_ERRORS: Readonly<Record<string, { message: string; status: number }>> = {
  extension_forbidden: {
    message: "Seu acesso mudou. Entre novamente para continuar.",
    status: 403,
  },
  extension_invalid_input: {
    message: "Confira os dados do pedido e tente novamente.",
    status: 422,
  },
  extension_idempotency_conflict: {
    message: "Este pedido já foi usado com outros dados. Recarregue a página.",
    status: 409,
  },
  extension_catalog_not_found: {
    message: "Catálogo não encontrado. Recarregue a lista de extensões.",
    status: 404,
  },
  extension_catalog_revision_conflict: {
    message:
      "O catálogo tem uma revisão anterior ou diferente da já admitida. Peça o arquivo atual ao mantenedor.",
    status: 409,
  },
  extension_catalog_stale: {
    message: "O catálogo mudou durante a preparação. Recarregue a lista antes de instalar.",
    status: 409,
  },
  extension_entry_not_found: {
    message: "Esta versão não está no catálogo admitido. Recarregue a lista.",
    status: 404,
  },
  extension_operation_not_found: {
    message: "Pedido não encontrado. Consulte o histórico da instalação.",
    status: 404,
  },
  extension_operation_conflict: {
    message: "Este pedido mudou de estado. Consulte o histórico antes de continuar.",
    status: 409,
  },
  extension_installation_not_found: { message: "Extensão não encontrada.", status: 404 },
  extension_version_conflict: {
    message: "Já existe conteúdo diferente para esta versão. Peça uma nova versão ao mantenedor.",
    status: 409,
  },
  extension_version_changed: {
    message: "A extensão mudou em outra sessão. Recarregue antes de continuar.",
    status: 409,
  },
  extension_no_previous_version: {
    message: "Não há troca para desfazer nesta extensão.",
    status: 409,
  },
  // 410 e não 404: a extensão existiu e foi tirada de propósito, e a tela diz isso em vez de
  // sugerir que ela foi desativada nesta organização.
  extension_removed: {
    message: "O responsável pela instalação removeu esta extensão de todas as organizações.",
    status: 410,
  },
  extension_artifact_mismatch: {
    message:
      "O arquivo recebido não corresponde à versão admitida. Peça ao mantenedor para conferir a publicação.",
    status: 422,
  },
  extension_revision_conflict: {
    message: "A configuração mudou em outra sessão. Recarregue antes de salvar.",
    status: 409,
  },
  extension_active_limit: {
    message: "O limite de extensões ativas foi atingido. Desative uma antes de ativar outra.",
    status: 409,
  },
  extension_catalog_limit: {
    message: "O limite de catálogos desta instalação foi atingido.",
    status: 409,
  },
  extension_installation_limit: {
    message: "O limite de pacotes desta instalação foi atingido.",
    status: 409,
  },
  extension_core_update_in_progress: {
    message: "O sistema está sendo atualizado. Aguarde a conclusão para alterar extensões.",
    status: 409,
  },
  extension_preparation_in_progress: {
    message:
      "Já existe uma preparação em andamento. Em Atividade recente, quem pediu pode retomá-la, e qualquer responsável pela instalação pode cancelá-la.",
    status: 409,
  },
};

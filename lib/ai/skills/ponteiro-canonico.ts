/**
 * Um ponteiro de skill só é listável com `name` e `version_id` preenchidos.
 *
 * Bancos que vieram do formato legado (`slug`/`active_version_id`, migration 0422)
 * podem ter ponteiros cujas colunas canônicas seguem nulas. As duas portas que
 * listam ponteiros — `GET /api/v1/ai/skills` e a página `/app/ai/skills` — passam
 * por aqui, para que um ponteiro sem versão fique fora da lista em vez de derrubá-la.
 */
export function temPonteiroCanonico<T extends { name: string | null; version_id: string | null }>(
  pointer: T,
): pointer is T & { name: string; version_id: string } {
  return Boolean(pointer.name && pointer.version_id);
}

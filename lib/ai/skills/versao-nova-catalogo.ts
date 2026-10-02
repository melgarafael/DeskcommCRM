/**
 * Uma cópia de playbook está atrás do catálogo quando a versão de plataforma de
 * onde ela foi copiada (`forked_from_version_id`) não é mais a que o ponteiro de
 * plataforma aponta hoje. Skill sem origem no catálogo (.zip, criada na org) ou
 * que saiu do catálogo nunca é avisada. Única fonte da regra: o GET
 * /api/v1/ai/skills e o primeiro paint de /app/ai/skills leem daqui.
 */
export function temVersaoNovaNoCatalogo(
  forkedFrom: string | null | undefined,
  versaoAtualDaPlataforma: string | undefined,
): boolean {
  return Boolean(forkedFrom && versaoAtualDaPlataforma && forkedFrom !== versaoAtualDaPlataforma);
}

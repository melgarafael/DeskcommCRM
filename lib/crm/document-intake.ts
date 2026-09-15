export const requeueDocumentIntake = (pessoaCodigo: number, descricao: string | undefined, now = new Date()) => ({
  pessoa_codigo: pessoaCodigo,
  descricao: descricao ?? null,
  status: 'pending' as const,
  failure_reason: null,
  attempts: 0,
  next_attempt_at: now.toISOString(),
  claimed_at: null,
  claimed_by: null,
})

/** Returns the positive Advomax file id carried by a successful upload receipt. */
export const advomaxFileCode = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') return null
  const codigo = (body as { codigo?: unknown }).codigo
  return typeof codigo === 'number' && Number.isInteger(codigo) && codigo > 0 ? codigo : null
}

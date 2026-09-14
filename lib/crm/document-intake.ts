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

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

export const DOCUMENT_INTAKE_MAX_ATTEMPTS = 5

export type DocumentIntakeStatus = 'pending' | 'processing' | 'uploaded' | 'failed' | 'ignored'

/** Fields safe for the inbox; storage paths, claims and identities stay server-side. */
export const publicDocumentIntake = (row: Record<string, unknown>) => {
  const contactId = typeof row.contact_id === 'string' ? row.contact_id : null
  const advomaxFileId = typeof row.advomax_file_id === 'number' ? row.advomax_file_id : null
  return {
    id: typeof row.id === 'string' ? row.id : null,
    message_id: typeof row.message_id === 'string' ? row.message_id : null,
    status: row.status as DocumentIntakeStatus,
    pessoa_codigo: typeof row.pessoa_codigo === 'number' ? row.pessoa_codigo : null,
    filename: typeof row.filename === 'string' ? row.filename : null,
    mime_type: typeof row.mime_type === 'string' ? row.mime_type : null,
    descricao: typeof row.descricao === 'string' ? row.descricao : null,
    attempts: typeof row.attempts === 'number' ? row.attempts : 0,
    max_attempts: DOCUMENT_INTAKE_MAX_ATTEMPTS,
    next_attempt_at: typeof row.next_attempt_at === 'string' ? row.next_attempt_at : null,
    advomax_file_id: advomaxFileId,
    documents_url: contactId
      ? `/app/contacts/${encodeURIComponent(contactId)}`
      : null,
    failure_reason: typeof row.failure_reason === 'string' ? row.failure_reason : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

/** Returns the positive Advomax file id carried by a successful upload receipt. */
export const advomaxFileCode = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') return null
  const codigo = (body as { codigo?: unknown }).codigo
  return typeof codigo === 'number' && Number.isInteger(codigo) && codigo > 0 ? codigo : null
}

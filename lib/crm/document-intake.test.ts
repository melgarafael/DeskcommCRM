import { describe, expect, it } from 'vitest'

import { requeueDocumentIntake } from './document-intake'

describe('requeue de documentos do WhatsApp', () => {
  it('zera tentativas e libera a linha para o cron imediatamente', () => {
    const now = new Date('2026-09-14T18:00:00.000Z')
    expect(requeueDocumentIntake(42, 'RG', now)).toEqual({
      pessoa_codigo: 42,
      descricao: 'RG',
      status: 'pending',
      failure_reason: null,
      attempts: 0,
      next_attempt_at: now.toISOString(),
      claimed_at: null,
      claimed_by: null,
    })
  })
})

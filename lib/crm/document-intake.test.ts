import { describe, expect, it } from 'vitest'

import { advomaxFileCode, publicDocumentIntake, requeueDocumentIntake } from './document-intake'

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

  it('aceita somente recibo com código inteiro positivo', () => {
    expect(advomaxFileCode({ codigo: 123 })).toBe(123)
    expect(advomaxFileCode({ codigo: 0 })).toBeNull()
    expect(advomaxFileCode({ codigo: '123' })).toBeNull()
    expect(advomaxFileCode(null)).toBeNull()
  })

  it('publica o recibo sem expor storage, identidade ou claim interno', () => {
    const publicRow = publicDocumentIntake({
      id: 'intake-1', message_id: 'message-1', organization_id: 'org-secret', contact_id: 'contact-1',
      status: 'uploaded', pessoa_codigo: 42, filename: 'whatsapp-pdf.pdf', mime_type: 'application/pdf',
      attempts: 1, advomax_file_id: 99, media_storage_path: 'whatsapp-media/org-secret/private.pdf',
      requested_by_email: 'atendente@example.com', claimed_by: 'request:secret',
    })

    expect(publicRow).toMatchObject({
      status: 'uploaded', advomax_file_id: 99,
      documents_url: '/app/contacts/contact-1',
    })
    expect(publicRow).not.toHaveProperty('organization_id')
    expect(publicRow).not.toHaveProperty('media_storage_path')
    expect(publicRow).not.toHaveProperty('requested_by_email')
    expect(publicRow).not.toHaveProperty('claimed_by')
  })
})

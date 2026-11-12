-- manifest: #4129 — o bucket `crm-materiais` aceita XML, como o upload do Inbox: a allowlist compartilhada cresceu na main depois da 9222
--
-- ─── O QUE MUDOU FORA DESTE PR ──────────────────────────────────────────────
--
-- A 9222 (esta entrega, 06/11) criou o bucket privado com a allowlist copiada de
-- `DOCUMENT_MIMES` (`lib/messaging/media/upload-validation.ts`) e escreveu no
-- próprio comentário a regra: "duas cópias da lista divergiriam em silêncio".
--
-- Em 10/11 a main ganhou XML nessa lista (617635a5f7, "suporta envio de arquivos
-- XML e amplia teto de upload"). A cópia do bucket ficou para trás: o Inbox
-- aceita `application/xml` e `text/xml`, o bucket RECUSA — e a recusa acontece
-- no Storage, antes de qualquer código da aplicação rodar, então o material
-- cadastrado a partir de um XML do cliente morre sem mensagem que explique.
--
-- `tests/invariants/crm-materiais-rls.test.ts:192` compara as duas listas de
-- propósito ("O que o upload do Inbox aceita tem de poder ser cadastrado como
-- material"). Vermelho com `bucket sem application/xml`.
--
-- ─── POR QUE `update`, e não `insert ... on conflict` ───────────────────────
--
-- O bucket já existe em todo clone que aplicou a 9222; o que precisa alcançar
-- quem instalou antes desta migration é a lista de MIME. Mesmo molde da 0310
-- (CSV no bucket `ai-policy`): `update` idempotente, sem tocar no resto da linha.
--
-- Idempotente: reaplicar reescreve a mesma lista.

update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg',
     'image/png',
     'image/webp',
     'image/gif',
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'text/plain',
     'text/csv',
     'application/zip',
     'application/xml',
     'text/xml'
   ]
 where id = 'crm-materiais';

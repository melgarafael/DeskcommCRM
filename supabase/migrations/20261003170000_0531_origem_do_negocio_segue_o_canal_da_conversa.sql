-- manifest: **O negócio que nasceu de uma conversa do Instagram ou do Facebook deixa de constar como vindo do WhatsApp.** Até esta versão, a ingestão compartilhada (`lib/channels/pos-entrada.ts`) chamava `garantirLeadDaConversa` sem origem, e o padrão dele é WhatsApp: o negócio aberto por uma mensagem no direct nascia com `crm_leads.source = 'whatsapp'`, e todo relatório por canal o contava no lugar errado. O código passa a repassar o canal (`lib/channels/origem-do-negocio.ts`); esta migration corrige os negócios que JÁ nasceram errados. Critério: o negócio tem a atividade `lead_created` de `source_module = 'canal.ingest'`, cuja `source_id` é a conversa que o fez nascer, e essa conversa não é de WhatsApp; só troca quem ainda está com `source = 'whatsapp'` (origem de anúncio e qualquer outra ficam intactas). A linha do tempo NÃO é reescrita: `crm_lead_activities` é só-acréscimo por desenho. Só dados, idempotente; apêndice no fim do `baseline.sql`. Gate: `tests/invariants/origem-do-negocio-segue-o-canal-da-conversa.test.ts` (o SQL) e `tests/unit/negocio-nasce-com-o-canal-da-conversa.test.ts` (o código). Reaplicada a cada `update.sh`, reverte troca manual de `source` para `whatsapp` nesses negócios.
-- 0531: a origem do negócio segue o canal da conversa que o fez nascer.
--
-- O DEFEITO: `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts`)
-- recebe a origem como parâmetro e, sem ela, assume WhatsApp — o único canal
-- que existia quando foi escrito. A ingestão compartilhada nunca a passava.
-- Medido numa VPS em 2026-10-03: conversa com `channel = 'instagram'`,
-- negócio com `source = 'whatsapp'`.
--
-- POR QUE O CRITÉRIO É A ATIVIDADE, E NÃO O CONTATO: o vínculo exato entre o
-- negócio e a conversa que o fez nascer só existe na atividade `lead_created`
-- gravada por `garantirLeadDaConversa` (`source_module = 'canal.ingest'`,
-- `source_id = conversa`). Um contato pode ter conversas em mais de um canal;
-- casar pelo contato poderia trocar a origem de um negócio que nasceu, de
-- fato, no WhatsApp.
--
-- O QUE NÃO SE TOCA:
--   - `source` diferente de 'whatsapp' — a origem de anúncio (`meta_ads` e
--     afins) vence o canal no próprio nascimento, e continua vencendo aqui;
--   - a linha do tempo: a atividade antiga segue com o motivo que gravou.
--     `crm_lead_activities` não tem política de UPDATE para os papéis da API,
--     e reescrever o registro do passado seria apagar o que aconteceu;
--   - nenhum evento é emitido: `fn_emit_event_on_lead_change` só reage a
--     `status` e dono. O `updated_at` do negócio corrigido avança, pelo
--     `trg_crm_leads_updated_at` — é o rastro de que ele foi alterado.
--
-- Genérica para qualquer banco (nenhum id fixo) e idempotente: a segunda
-- aplicação não acha mais `source = 'whatsapp'` nesses negócios.
update public.crm_leads l
   set source = c.channel
  from public.crm_lead_activities a
  join public.conversations c
    on c.organization_id = a.organization_id
   and c.id = a.source_id
 where a.organization_id = l.organization_id
   and a.lead_id = l.id
   and a.type = 'lead_created'
   and a.source_module = 'canal.ingest'
   and c.channel <> 'whatsapp'
   and l.source = 'whatsapp';

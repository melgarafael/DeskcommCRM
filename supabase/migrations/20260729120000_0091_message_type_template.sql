-- 0091 — `template` vira um tipo de mensagem de primeira classe.
--
-- Por que isto NÃO podia ser `type: 'text'` com o texto renderizado no corpo:
-- compilaria, gravaria na conversa e avançaria o ledger de idempotência. E seria
-- **mentira no banco** — a linha diria "texto" para uma mensagem que é template.
--
-- O que se perde com a mentira, e não volta depois:
--   * **custo**: template é COBRADO por entrega (desde 01/07/2025 a Meta cobra por
--     mensagem, não por conversa); texto livre dentro da janela é grátis. Sem o tipo,
--     ninguém consegue somar a fatura a partir do histórico.
--   * **conformidade**: fora da janela de 24h só template é permitido. Uma auditoria
--     que pergunte "esse envio respeitou a janela?" precisa do tipo para responder.
--   * **o que o contato viu**: template tem cabeçalho, rodapé e botões que o corpo
--     renderizado não carrega.
--
-- O tipo é a única coluna que carrega essas três coisas. Falsificá-lo para economizar
-- uma migration é o anti-pattern nº 1 do CLAUDE.md ("duplicação sem source of truth")
-- com outra roupa — e o prejuízo aparece meses depois, num relatório que não fecha.
--
-- ── Por que ALTERAR o CHECK e não removê-lo ────────────────────────────────
-- `messages.type` é vocabulário FECHADO: quem escreve é o nosso código, não uma
-- plataforma externa. Diferente de `meta_templates.status` (aberto, a Meta inventa
-- estado novo) e de `crm_lead_activities.type` (aberto, clone pode ter valor legado).
-- Aqui o CHECK se paga: move para o INSERT um erro que apareceria no envio.
--
-- ── Backfill: nenhum, por construção ──────────────────────────────────────
-- A migration só ACRESCENTA um valor ao conjunto permitido. Toda linha existente já
-- satisfaz o CHECK novo, porque o conjunto antigo é subconjunto do novo. Vale para
-- qualquer clone, não só para este banco — é o que garante o `update.sh`.

do $$ begin
  alter table public.messages drop constraint if exists messages_type_check;
  alter table public.messages add constraint messages_type_check
    check (type = any (array[
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'location', 'contact', 'reaction', 'system',
      -- novo: envio de template aprovado (canal oficial, fora da janela de 24h)
      'template'
    ]));
end $$;

-- Nome do template disparado. Fica em coluna, não só em `metadata`, porque é o que
-- responde "quanto gastei com o template X?" sem varrer jsonb — e porque `metadata`
-- é vocabulário aberto por desenho, o que tornaria a consulta uma aposta.
alter table public.messages
  add column if not exists template_name text,
  add column if not exists template_language text;

comment on column public.messages.template_name is
  'Nome do template da Meta quando type = template. Null nos demais tipos. Em coluna (não em metadata) porque é a chave de custo e de auditoria de janela.';

create index if not exists messages_template_idx
  on public.messages (organization_id, template_name)
  where template_name is not null;

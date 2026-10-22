-- manifest: Campanhas — chave seletora `split_messages` (boolean) em `campaigns`: permite alternar entre envio em múltiplos balões por parágrafo (\n\n) ou balão único, respeitando o intervalo configurado ou a Proteção de Envio quando em branco.
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- Mensagens de campanha com múltiplas quebras de parágrafo agora podem ser
-- enviadas como balões separados e humanizados ou preservadas como um bloco único,
-- com controle direto pelo operador no card "Ritmo desta campanha".
--
-- ─── Compatibilidade ────────────────────────────────────────────────────────
-- `add column if not exists` com `default true`: campanhas já criadas continuam
-- funcionando normalmente com o comportamento padrão retrocompatível.

alter table public.campaigns
  add column if not exists split_messages boolean default true;

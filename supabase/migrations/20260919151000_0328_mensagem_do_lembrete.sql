-- 0328 — A MENSAGEM DO LEMBRETE MORA NO TIPO, NÃO SÓ NO CÓDIGO
--
-- O cron `agenda-reminder` monta "Oi, Fulano! Passando pra lembrar do seu
-- compromisso: …" no TypeScript, e a tela do tipo só deixava ligar o aviso e
-- escolher quantos minutos antes. Quem quer outra frase — clínica, imobiliária,
-- o tom da casa — não tinha campo. `reminder_template_name` existe desde a 0177
-- para o NOME de um template do provedor oficial (Meta/Zernio); não é o corpo
-- em texto livre, e a tela nunca o expôs.
--
-- DIRC: a frase é do MOLDE (`calendar_event_types`), não do compromisso marcado
-- e não de `message_templates` (scripts do inbox). Mudar o texto do tipo não
-- reescreve o que já saiu. NULL = o texto padrão do cron, o comportamento
-- anterior, zero backfill.
--
-- Aditiva e nullable. Nenhuma linha atual passa a violar nada.

alter table public.calendar_event_types
  add column if not exists reminder_body text;

comment on column public.calendar_event_types.reminder_body is
  'Texto do lembrete no WhatsApp. NULL = a frase padrão do cron. Variáveis {{nome}}, {{titulo}}, {{dia}}, {{hora}}, {{endereco}}. Distinto de reminder_template_name, que é o nome do template aprovado no provedor oficial.';

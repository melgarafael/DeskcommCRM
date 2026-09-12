-- O transporte de e-mail deixou de depender de um provedor específico.
-- A tabela anterior não tem mais consumidores; removê-la evita duas fontes de
-- configuração da mesma saída em instalações que atualizam.
drop table if exists public.platform_resend_settings;

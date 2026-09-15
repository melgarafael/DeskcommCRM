-- Migration 0220: fuso horário padrão da instalação vira Africa/Luanda
--
-- `organizations.timezone` e `calendar_appointments.time_zone` nasceram com
-- default 'America/Sao_Paulo'. As duas colunas são declaradas em
-- `CREATE TABLE IF NOT EXISTS` no baseline.sql — mudar o DEFAULT ali dentro
-- só alcança instalação nova (a tabela já existente não roda o CREATE de
-- novo). Esta migration é o ALTER que falta para quem já instalou.
--
-- `FUSO_PADRAO` (`lib/tempo/fusos.ts`) e o default do schema de disponibilidade
-- (`lib/schemas/routing.ts`) já apontam para `Africa/Luanda` no código — esta
-- migration alinha o banco ao que o TypeScript já assume.
alter table public.organizations
  alter column timezone set default 'Africa/Luanda';

alter table public.calendar_appointments
  alter column time_zone set default 'Africa/Luanda';

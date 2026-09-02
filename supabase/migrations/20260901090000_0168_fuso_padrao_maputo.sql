-- 0165 — FUSO PADRÃO DA ORGANIZAÇÃO PASSA DE America/Sao_Paulo PARA Africa/Maputo.
--
-- Esta instalação opera em Moçambique (ver rebrand SonghaiCRM/Songhai, Lda);
-- organização criada sem fuso explícito deve nascer em Africa/Maputo (UTC+2,
-- sem DST), não em America/Sao_Paulo — herança do template original do curso
-- WAHA. `organizations.timezone` é NOT NULL com DEFAULT; nenhuma constraint
-- de conjunto amarra o valor, só o piso para linha NOVA.
--
-- Não altera nenhuma organização existente: quem já tem 'America/Sao_Paulo'
-- gravado continua com esse fuso real (é o que o operador escolheu ou herdou
-- na instalação). `alter column ... set default` é idempotente por natureza —
-- reaplicar não tem efeito colateral.

alter table public.organizations alter column timezone set default 'Africa/Maputo';

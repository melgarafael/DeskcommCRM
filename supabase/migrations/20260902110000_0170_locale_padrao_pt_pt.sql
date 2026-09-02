-- 0167 — LOCALE PADRÃO PASSA DE pt-BR PARA pt-PT.
--
-- Mesma lógica da 0165 (fuso padrão): esta instalação opera em Moçambique
-- (rebrand SonghaiCRM/Songhai, Lda), e organização ou item de FAQ criado sem
-- locale explícito deve nascer em pt-PT (português europeu), não pt-BR —
-- herança do template original do curso WAHA. `organizations.locale` e
-- `ai_faq_items.locale` são NOT NULL com DEFAULT; nenhuma constraint de
-- conjunto amarra o valor, só o piso para linha NOVA.
--
-- Não altera nenhuma organização/FAQ existente: quem já tem 'pt-BR' gravado
-- continua com esse locale (é o que o operador escolheu ou herdou na
-- instalação, mesma cautela da 0165 com o fuso). `alter column ... set
-- default` é idempotente por natureza — reaplicar não tem efeito colateral.

alter table public.organizations alter column locale set default 'pt-PT';
alter table public.ai_faq_items alter column locale set default 'pt-PT';

-- manifest: **O endereço do servidor SMTP passa a aceitar `_` (issue #2804, decisão do item 2).** O `.env` sempre aceitou e só a tela recusava; quem roda um relé na própria VPS em Docker (`meu_relay`, `supabase_inbucket_…`) é o público do self-host. A CHECK `platform_smtp_settings_host` troca o formato para `^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$` — segue recusando espaço, barra e esquema (`http://`), que não são nome de máquina. O drop e o add da constraint vão no MESMO bloco `DO`, porque o `update.sh` roda sem `ON_ERROR_STOP` e uma interrupção entre os dois deixaria a tabela SEM validação nenhuma. Número `0669`: próximo livre na `main` (0670–0676 já entraram; 0674 e 0675 estão em PRs abertos) mais o carimbo de hoje. O bloco é o MESMO, letra a letra, no apêndice do `baseline.sql` (antes da varredura anon). A validação da tela (`lib/email/config.ts`) espelha a regra nova, e `app/actions/settings/smtp.test.ts` prova os dois lados: o `_` do relato ACEITO e espaço/barra/esquema recusados antes da escrita.

-- 0669: o endereço do servidor aceita sublinhado (issue #2804, item 2).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- o endereço do servidor aceita sublinhado (migration 0669, issue #2804) ----
-- A CHECK `platform_smtp_settings_host` recusava `_`, e o `.env` sempre aceitou:
-- quem roda um relé na própria VPS em Docker (`meu_relay`,
-- `supabase_inbucket_…`) apontava o CRM para o contêiner e recebia a mensagem
-- crua do Postgres na tela. O que não é nome de máquina — espaço, barra,
-- `http://` — segue recusado.
--
-- Drop e add JUNTOS, no mesmo bloco: o `update.sh` roda sem `ON_ERROR_STOP`, e
-- a versão que soltasse a constraint para recriá-la em seguida deixaria uma
-- janela sem validação se a atualização morresse no meio. Idempotente: reaplicar
-- derruba e recria a mesma constraint.

do $constraint$
begin
  alter table public.platform_smtp_settings
    drop constraint if exists platform_smtp_settings_host;
  alter table public.platform_smtp_settings
    add constraint platform_smtp_settings_host
    check (smtp_host is null or smtp_host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$');
end
$constraint$;

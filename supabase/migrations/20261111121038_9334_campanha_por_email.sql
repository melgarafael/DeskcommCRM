-- manifest: **Campanha por e-mail, fatia E2a (#3441): conteúdo e público.** `campaigns` ganha `email_subject` e passa a aceitar `message_mode = 'email'`; `channel_session_id` deixa de ser obrigatório PARA ESSE MODO, porque campanha de e-mail não fala por número — o remetente é a conta Resend da organização (`organization_resend_accounts`, #3560) e o endereço de cada destinatário é `contacts.email`. A regra contrária continua de pé: todo modo que não é `email` exige o número, e o CHECK é o que impede a campanha de WhatsApp sem conexão. Idempotente (`add column if not exists`, constraints recriadas por nome); apêndice espelhado no `supabase/baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.
--
-- ═══ Por que a coluna do número vira anulável, e só para o e-mail ═══
--
-- A FK composta `campaigns_channel_org_fk` (0375) amarra a campanha ao número da
-- MESMA organização; e-mail não tem número, não tem `channel_sessions`, não tem
-- janela de 24 horas e não é despachado por worker nenhum nesta fatia. Manter a
-- coluna obrigatória obrigaria a inventar uma conexão falsa — e uma linha falsa
-- em `channel_sessions` é pior que uma coluna nula: ela apareceria na tela de
-- conexões e no rodízio.
--
-- O `not null` sai, mas a REGRA não: `campaigns_numero_ou_email_check` exige
-- número em todo modo que não é `email`. Uma campanha de WhatsApp sem conexão
-- continua impossível, no banco e não só na rota.
--
-- ═══ Por que o assunto mora em coluna própria ═══
--
-- O corpo do e-mail é o MESMO `message_body` do WhatsApp (texto puro, sem HTML
-- nesta fatia); o assunto não é — e enfiá-lo no começo do corpo faria o texto
-- enviado ter uma linha que ninguém escreveu como corpo. `email_subject` é
-- nulo em todo modo que não é `email`, e o CHECK exige conteúdo nele quando é.

alter table public.campaigns
  add column if not exists email_subject text;

do $campanha_email$
begin
  alter table public.campaigns alter column channel_session_id drop not null;

  alter table public.campaigns drop constraint if exists campaigns_numero_ou_email_check;
  alter table public.campaigns
    add constraint campaigns_numero_ou_email_check check (
      channel_session_id is not null or message_mode = 'email'
    );

  alter table public.campaigns drop constraint if exists campaigns_message_mode_check;
  alter table public.campaigns
    add constraint campaigns_message_mode_check check (message_mode in ('text', 'template', 'email'));

  -- Assunto vazio não é rascunho: é um e-mail que o cliente abriria sem saber do
  -- que se trata. A tela já recusa (`conferirConteudoDeEmail`); o CHECK é a
  -- mesma régua no banco, para o caminho que um dia escrever por fora.
  alter table public.campaigns drop constraint if exists campaigns_email_exige_assunto;
  alter table public.campaigns
    add constraint campaigns_email_exige_assunto check (
      message_mode <> 'email' or coalesce(btrim(email_subject), '') <> ''
    );

  -- Assunto é do e-mail e de mais ninguém: nos outros modos a coluna é nula.
  alter table public.campaigns drop constraint if exists campaigns_assunto_so_email;
  alter table public.campaigns
    add constraint campaigns_assunto_so_email check (
      message_mode = 'email' or email_subject is null
    );
end
$campanha_email$;

comment on column public.campaigns.email_subject is
  'Assunto do e-mail, quando message_mode = email (#3441). Nulo nos modos do WhatsApp; texto puro, até 150 caracteres.';
comment on column public.campaigns.message_mode is
  'text = corpo livre em message_body (número por QR); template = modelo aprovado (número oficial); email = assunto em email_subject + corpo em message_body, sem número (migration 9334).';
comment on column public.campaigns.channel_session_id is
  'O número principal da campanha. Nulo só em message_mode = email (#3441): campanha de e-mail não fala por conexão.';

-- manifest: **Campanha pelo número oficial com modelo aprovado (issue #1330, fatia 4).** `campaigns` ganha `message_mode` (`text` | `template`) e `provider_template_name`/`_language`/`_variables` — os nomes que a 0375 reservou ("Spec 12 §2.1") e deixou para "quando o canal oficial entrar".
--
-- ═══ Por que a campanha precisa de modelo ═══
--
-- Número oficial (API da plataforma, direto ou por provedor parceiro) só aceita
-- texto livre para quem escreveu nas últimas 24 horas. Uma campanha fala
-- justamente com quem NÃO escreveu: com `message_body` sozinho, cada destinatário
-- de um número oficial virava falha (`131047`, ou recusa do parceiro antes de
-- sair). O corpo da campanha oficial é um modelo aprovado, e cada variável dele
-- (`{{1}}`, `{{2}}`…) diz DE ONDE sai o valor — nome do contato, campo do
-- negócio, texto fixo —, nunca o valor: quem resolve é a preparação, contato a
-- contato, e o valor resolvido fica em `campaign_recipients.variables`.
--
-- ═══ Por que `message_mode` tem CHECK ═══
--
-- Vocabulário FECHADO: só existe o que o despacho sabe mandar. Linha legada não
-- existe (a coluna nasce aqui com default `text`, que é o que toda campanha
-- anterior é). Vigiado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`
-- contra `MODOS_DA_MENSAGEM` em `lib/campanhas/tipos.ts`.
--
-- Idempotente: `add column if not exists`, constraints recriadas por nome.

alter table public.campaigns
  add column if not exists message_mode text not null default 'text',
  add column if not exists provider_template_name text,
  add column if not exists provider_template_language text,
  add column if not exists provider_template_variables jsonb not null default '{}'::jsonb;

-- A troca das duas restrições vai num bloco DO só: o `update.sh` reaplica o
-- baseline sem ON_ERROR_STOP e em autocommit, e com `drop` e `add` soltos uma
-- falha no `add` deixaria `campaigns` SEM a guarda. Dentro do bloco, ou as duas
-- trocas valem, ou nada muda e a restrição de antes continua. Não há dado a
-- corrigir antes: as colunas nascem aqui com default que cumpre as duas, e quem
-- já tem as restrições só tem linhas que já as cumprem (CHECK validado).
do $campanha_modelo$
begin
  alter table public.campaigns drop constraint if exists campaigns_message_mode_check;
  alter table public.campaigns
    add constraint campaigns_message_mode_check check (message_mode in ('text', 'template'));

  -- Modelo sem nome ou sem idioma não sai: a plataforma identifica a definição
  -- pelos DOIS (o mesmo nome em `es` e `es_AR` são modelos diferentes).
  alter table public.campaigns drop constraint if exists campaigns_modelo_exige_nome_e_idioma;
  alter table public.campaigns
    add constraint campaigns_modelo_exige_nome_e_idioma check (
      message_mode <> 'template'
      or (coalesce(btrim(provider_template_name), '') <> ''
          and coalesce(btrim(provider_template_language), '') <> '')
    );
end
$campanha_modelo$;

comment on column public.campaigns.message_mode is
  'text = corpo livre em message_body (número por QR); template = modelo aprovado (número oficial). Migration 0710.';
comment on column public.campaigns.provider_template_name is
  'Nome do modelo aprovado na plataforma, quando message_mode = template.';
comment on column public.campaigns.provider_template_language is
  'Idioma exato do modelo (es, es_AR, pt_BR…): nome + idioma identificam a definição.';
comment on column public.campaigns.provider_template_variables is
  'slotKey ("1", "header:1", "button0:1") → origem do valor ({kind: contact_first_name|contact_name|lead_custom|fixed}). Nunca o valor: ele é resolvido por contato na preparação.';

-- O ack pelos carimbos de entrega e leitura (`fn_campanha_sincroniza_ack`) já
-- vem da #2937: esta migration não o redefine.

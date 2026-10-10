-- ============================================================================
-- 0127 — PROVIDER VIRA VOCABULÁRIO ABERTO. É o que destrava a OpenRouter.
--
-- Três CHECKs travavam `provider` em anthropic|openai|google:
--   ai_agent_versions_provider_check
--   ai_models_provider_check
--   ai_provider_credentials_provider_check
--
-- Enquanto eles existem, cadastrar uma chave da OpenRouter é impossível — o
-- INSERT viola constraint antes de qualquer código rodar. E o mesmo vale para
-- o próximo provedor, e para um modelo rodando na máquina do próprio cliente,
-- que é o roteiro declarado do produto.
--
-- ## Por que remover, e não estender a lista
--
-- Estender para quatro valores compraria o mesmo problema mais adiante: cada
-- provedor novo viraria uma migration, e um clone que não a aplicasse recusaria
-- a chave sem que a tela soubesse explicar por quê. A doutrina de migrations
-- deste repo já prevê o caso — coluna de vocabulário ABERTO não leva CHECK,
-- porque a constraint faria o `update.sh` do clone quebrar; o vocabulário vive
-- no TypeScript e o guarda é o registry, que recusa provider desconhecido com
-- erro tipado (`LlmProviderUnknownError`) em vez de violação de constraint.
--
-- ## O que NÃO se perde ao remover
--
-- O CHECK nunca foi a defesa real. Ele impedia `provider = 'xyz'` no banco, mas
-- quem executa a chamada é `createDefaultRegistry()`, e um provider fora do
-- registry já falha ali, com mensagem que diz o que fazer. O que o CHECK
-- garantia de fato era que a tela não oferecesse opção inválida — e isso passa
-- a ser garantido por `lib/ai/pontos/provedores.ts` mais o teste que casa a
-- lista do TypeScript com as chaves do registry.
--
-- Removível com segurança em qualquer ordem: nenhuma linha existente viola a
-- ausência de constraint.
-- ============================================================================

alter table public.ai_agent_versions      drop constraint if exists ai_agent_versions_provider_check;
alter table public.ai_models              drop constraint if exists ai_models_provider_check;
alter table public.ai_provider_credentials drop constraint if exists ai_provider_credentials_provider_check;

-- `provider` continua NOT NULL e não-vazio: vocabulário aberto não é campo
-- livre. String vazia aqui seria uma linha que nenhum registry resolve e que
-- nenhuma tela consegue exibir — o pior dos dois mundos.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_models_provider_nao_vazio'
  ) then
    alter table public.ai_models
      add constraint ai_models_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'ai_provider_credentials_provider_nao_vazio'
  ) then
    alter table public.ai_provider_credentials
      add constraint ai_provider_credentials_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'ai_agent_versions_provider_nao_vazio'
  ) then
    alter table public.ai_agent_versions
      add constraint ai_agent_versions_provider_nao_vazio check (length(btrim(provider)) > 0);
  end if;
end $$;

-- ── Catálogo: o que a OpenRouter precisa que ai_models saiba guardar ────────
--
-- O catálogo dela tem 400 modelos e muda sozinho. Sincronizar exige saber (a)
-- de onde a linha veio, para não apagar o que foi cadastrado à mão, e (b)
-- quando foi vista pela última vez, para marcar como obsoleto o que sumiu da
-- origem em vez de deletar — deletar levaria junto o histórico de preço de quem
-- usou aquele modelo mês passado.
alter table public.ai_models add column if not exists source text not null default 'manual';
alter table public.ai_models add column if not exists synced_at timestamptz;
alter table public.ai_models add column if not exists supports_vision boolean not null default false;

comment on column public.ai_models.source is
  'Migration 0127: ''manual'' (semeado por migration ou cadastrado na tela) ou o nome do sincronizador '
  '(ex.: ''openrouter''). O sincronizador só mexe nas linhas da PRÓPRIA origem — apagar o que um humano '
  'cadastrou seria perder configuração sem aviso.';

comment on column public.ai_models.synced_at is
  'Migration 0127: quando a origem confirmou este modelo pela última vez. Modelo que some do catálogo '
  'da origem recebe deprecated_at, nunca DELETE: a linha ainda é referenciada pelo histórico de custo.';

-- Deduplicar ANTES do índice único: `ai_models` nunca teve essa garantia, e um
-- clone que rodou duas vezes uma migration de seed pode ter a mesma dupla
-- repetida. O `update.sh` roda SEM ON_ERROR_STOP, então o índice falharia em
-- silêncio e o upsert do sincronizador cairia de volta em duplicação infinita.
-- Fica a linha mais informativa (a que tem preço), depois a mais recente.
delete from public.ai_models a
 using public.ai_models b
 where a.provider = b.provider
   and a.model_id = b.model_id
   and (
     (a.input_price_per_million_cents is null and b.input_price_per_million_cents is not null)
     or (
       (a.input_price_per_million_cents is null) = (b.input_price_per_million_cents is null)
       and a.id < b.id
     )
   );

-- Sincronizador faz upsert por (provider, model_id); sem isto seria SELECT+
-- INSERT com corrida entre duas execuções do cron.
create unique index if not exists ai_models_provider_model_unique
  on public.ai_models (provider, model_id);

create index if not exists ai_models_source_idx on public.ai_models (source) where deprecated_at is null;

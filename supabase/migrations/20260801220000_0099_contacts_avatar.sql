-- 0099 — foto de perfil do contato (avatar do WhatsApp).
--
-- POR QUE GUARDAR O ARQUIVO, E NÃO A URL
-- --------------------------------------
-- O WAHA devolve a foto como URL assinada do CDN do WhatsApp:
--
--   https://pps.whatsapp.net/v/t61.24694-24/...&oe=6A7B69D2&...
--                                              ^^^^^^^^^^^ expira
--
-- Esse `oe` é a validade. Medido numa instalação real: **9 dias**. Guardar a URL
-- crua faria TODOS os avatares quebrarem em pouco mais de uma semana, sem erro
-- nenhum — só o rosto sumindo da tela.
--
-- Então o arquivo é baixado e persistido no bucket privado `whatsapp-media`,
-- exatamente como já se faz com a mídia das mensagens (media_storage_path). O
-- que fica aqui é o CAMINHO no bucket; a tela pede URL assinada na hora.
--
-- Isso também é o que torna a LGPD cumprível: foto de perfil é dado pessoal e
-- precisa sumir na anonimização. Só dá para garantir a remoção de um arquivo que
-- é nosso — sobre uma URL do WhatsApp não se tem controle nenhum.
--
-- `avatar_updated_at` existe para o refresh periódico saber o que está velho:
-- as pessoas trocam de foto, e sem esse carimbo o cron não teria como escolher
-- quem revisitar (nem evitar martelar a API do WAHA a cada rodada).
--
-- Ambas NULLABLE: contato sem foto (ou de antes desta migration) é o estado
-- normal, não um defeito. NULL em `avatar_updated_at` = nunca tentado.

alter table public.contacts
  add column if not exists avatar_storage_path text,
  add column if not exists avatar_updated_at   timestamptz;

comment on column public.contacts.avatar_storage_path is
  'Caminho da foto de perfil no bucket whatsapp-media. NULL = sem foto. Guardamos o arquivo, não a URL do WhatsApp, que expira em ~9 dias.';
comment on column public.contacts.avatar_updated_at is
  'Quando a foto foi buscada pela última vez. NULL = nunca tentado. Usado pelo cron de refresh para escolher quem revisitar.';

-- Índice PARCIAL: o cron procura "quem está velho ou nunca foi buscado". Sem ele
-- essa varredura vira seq scan na tabela inteira a cada rodada.
--
-- Parcial, e NÃO composto liderado por organization_id — que foi a primeira
-- versão deste índice e não servia para nada. A varredura do cron não filtra
-- organização nenhuma (app/api/v1/cron/contact-avatars/route.ts varre a
-- plataforma inteira), e sem restrição na coluna líder o planner não consegue
-- percorrer o índice em ordem de avatar_updated_at: cai em seq scan + top-N
-- sort, exatamente o que o índice deveria evitar. Medido num Postgres
-- descartável (pgvector/pgvector:pg17) com 20.000 contatos em 5 organizações,
-- 17.665 elegíveis, melhor de 3 execuções:
--
--   composto (organization_id, …)   Seq Scan + heapsort · 17.665 linhas · 10,272 ms
--   parcial  (avatar_updated_at)    Index Scan          ·      25 linhas ·  0,090 ms
--
-- 114x mais rápido, e o parcial ocupa 160 kB nessas 20 mil linhas — menor que o
-- composto, porque só indexa quem o cron pode escolher.
--
-- Os dois predicados do WHERE são os imutáveis. O terceiro
-- (`avatar_updated_at < now() - 7 dias`) não pode entrar: now() não é imutável e
-- o Postgres recusa a criação. Não faz falta — os NULL vêm primeiro, que é por
-- onde o cron começa, e o Index Scan para nas 25 primeiras linhas.
--
-- O drop é auto-curativo, para quem tenha aplicado a versão composta antes desta
-- correção: só dispara se o índice presente for o antigo. Em banco novo, e na
-- re-aplicação, é no-op — nada é reconstruído à toa.
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname  = 'idx_contacts_avatar_refresh'
      and indexdef ilike '%organization_id%'
  ) then
    execute 'drop index public.idx_contacts_avatar_refresh';
  end if;
end
$$;

create index if not exists idx_contacts_avatar_refresh
  on public.contacts (avatar_updated_at nulls first)
  where wa_identity is not null and is_anonymized = false;

notify pgrst, 'reload schema';

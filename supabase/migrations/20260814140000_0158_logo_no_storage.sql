-- ============================================================================
-- 0158 — O LOGO SAI DA CAIXA DE TEXTO E VIRA ARQUIVO.
--
-- Até aqui, "logo" no produto era `platform_branding.logo_url` — uma URL que
-- alguém colava. Quem instala o sistema para clientes não tem onde hospedar um
-- PNG, então o campo ficava vazio e a marca do revendedor não aparecia. Esta
-- migration traz o arquivo para dentro: bucket próprio, caminho por escopo, e as
-- duas camadas (instalação e organização) com o mesmo desenho.
--
-- ─── Por que o bucket é PÚBLICO — o primeiro do repositório ─────────────────
--
-- Os quatro buckets que já existiam (`ai-policy`, `lgpd-exports`,
-- `skill-assets`, `whatsapp-media`) nascem `public = false`. Este não, e a razão
-- é medida, não estética: o logo é renderizado num `<img>` da tela de LOGIN
-- (`app/(public)/layout.tsx`), servida a quem NÃO tem sessão. URL assinada exige
-- um segredo por requisição e vence — a marca da instalação sumiria da fachada
-- no dia do vencimento, sem ninguém tocar em nada, e o sintoma ("o logo sumiu")
-- não apontaria para a causa.
--
-- O que mantém a exceção contida, e o que `tests/invariants/marca-logo.test.ts`
-- mede:
--   * bucket EXCLUSIVO de logo — nada de conversa, export ou base de conhecimento
--     mora aqui, então "público" não vaza histórico de cliente nenhum;
--   * ZERO policy em `storage.objects` para ele: escrita só por `service_role`,
--     pela rota, depois dos gates. `public = true` no Supabase abre a LEITURA
--     pelo endpoint `/object/public/...`; não abre INSERT nem DELETE;
--   * caminho não-enumerável (`<prefixo>/<uuid v4>.<png|jpg>`): saber o id da
--     organização não dá o caminho do arquivo dela;
--   * `allowed_mime_types` é BACKSTOP, não a defesa — o Storage compara com o
--     header que QUEM SOBE escolheu. Quem decide é o farejador de bytes em
--     `lib/branding/logo-arquivo.ts`.
--
-- Registrado em `docs/threat-model.md` ao lado da linha de `whatsapp-media`.
--
-- ─── Por que 512 KB ────────────────────────────────────────────────────────
--
-- `next.config.ts` roda com `images.unoptimized` e os dois renders do logo usam
-- `<img>` cru (a URL é de quem hospeda; `next/image` exige allowlist fechada em
-- BUILD e a imagem é pré-buildada). O arquivo vai INTEIRO para o navegador em
-- toda página. E a cota do Supabase é do CLIENTE — 1 GB no plano gratuito,
-- compartilhado com `whatsapp-media`, que não tem poda.
--
-- ─── Por que uma FUNÇÃO PRÓPRIA para o logo da organização ─────────────────
--
-- `fn_definir_marca_da_organizacao` (0157) faz
-- `jsonb_set(settings, '{branding}', p_marca)` — substitui o objeto INTEIRO. Se
-- o logo fosse gravado por ela, salvar o nome pela tela apagaria o logo, em
-- silêncio, e a tela diria "salvo". Duas escritas independentes precisam de duas
-- funções que façam merge cada uma no seu campo.
--
-- ─── O forward-fix da 0157, que é a metade não-óbvia desta migration ───────
--
-- Pelo mesmo motivo acima, a 0157 é RECRIADA aqui preservando `logo_path`. Sem
-- isso, a ordem "sobe o logo, depois troca o nome" perde o logo — e é a ordem
-- natural de quem configura a marca.
--
-- ─── Onde este bloco entra no `baseline.sql` (e por que em DOIS pedaços) ───
--
-- `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe `create function` e
-- `grant ... to anon` DEPOIS do bloco da varredura (`-- ---- VARREDURA anon:`).
-- Mas `platform_branding` é criada num bloco que vem DEPOIS dela (a 0155 é o
-- último bloco do arquivo). Um bloco único, em qualquer posição, quebraria uma
-- das duas coisas: antes da varredura, o `alter table public.platform_branding`
-- roda sobre tabela inexistente e o `install.sh` (que usa `ON_ERROR_STOP=1`)
-- aborta; depois dela, as funções nascem com EXECUTE para `anon`.
--
-- Por isso o apêndice vai em DOIS blocos rotulados: as FUNÇÕES antes da
-- varredura, o BUCKET e a COLUNA no fim do arquivo. Aqui, no arquivo de
-- migration, a ordem é livre — o runner aplica tudo numa transação e a tabela já
-- existe desde a 0155.
--
-- Idempotente e auto-curativa: `create ... if not exists`, `create or replace
-- function`, `on conflict do update` no bucket (o `update.sh` de um clone precisa
-- CONVERGIR, não só criar), e o backfill vem ANTES da constraint — o `update.sh`
-- roda SEM `ON_ERROR_STOP`, então uma constraint que estourasse deixaria a coluna
-- sem validação em silêncio.
-- ============================================================================

-- ── O bucket ────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-logos', 'brand-logos', true, 524288, array['image/png', 'image/jpeg'])
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- NENHUMA policy em `storage.objects` para `brand-logos`, de propósito: leitura
-- vem do endpoint público do bucket, escrita e remoção só pelo `service_role`
-- (que é `bypassrls`) a partir de `app/api/v1/marca/logo/route.ts`.

-- ── A coluna da INSTALAÇÃO ──────────────────────────────────────────────────

alter table public.platform_branding
  add column if not exists logo_path text;

comment on column public.platform_branding.logo_path is
  'Caminho do arquivo de logo em storage/brand-logos, sempre platform/<uuid>.<png|jpg>. Caminho e NÃO url: a url é função determinística do caminho + host do projeto (DIRC-C), e gravá-la amarraria a marca ao host de hoje. Vence logo_url, que continua como rede de rollback do .env. Escrito por app/api/v1/marca/logo/route.ts.';

-- BACKFILL ANTES DA CONSTRAINT. A coluna nasce agora, então num banco limpo isto
-- não casa nada — existe para o clone que aplicou uma versão intermediária, ou
-- que teve o valor editado à mão. Sem ele, o `update.sh` (sem ON_ERROR_STOP)
-- engoliria o 23514 e a coluna ficaria SEM validação, com o gate verde.
update public.platform_branding
   set logo_path = null
 where logo_path is not null
   and logo_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';

-- `drop ... if exists` + `add`, e não `add ... if not exists` (que o Postgres não
-- tem para constraint): é o que torna a REGRA idempotente, e não só a criação —
-- um clone com a constraint antiga converge para esta.
alter table public.platform_branding
  drop constraint if exists platform_branding_logo_path;
alter table public.platform_branding
  add constraint platform_branding_logo_path check (
    logo_path is null
    or logo_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
  );

-- ⚠️ CHECK de REGEX, não de conjunto: fica FORA da lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`, cujo extrator só
-- reconhece `= ANY (ARRAY[...])` e estoura sobre regex. Mesma razão de
-- `platform_branding_accent_hex`.

-- ── A função da ORGANIZAÇÃO ─────────────────────────────────────────────────

create or replace function public.fn_definir_logo_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_path  text
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_path   text;
begin
  if p_org is null or p_actor is null then
    raise exception 'logo_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  v_path := nullif(btrim(coalesce(p_path, '')), '');

  -- O PREFIXO ASSEVERADO DENTRO DO BANCO — o gate que sobrevive ao segundo
  -- chamador. A rota já monta o caminho a partir da organização resolvida do
  -- cookie, mas "a rota monta certo" é promessa de UM chamador; esta linha é a
  -- regra. Sem ela, um caminho de outro escopo (o `platform/...` que qualquer
  -- pessoa lê no HTML da tela de login) entraria como logo da organização — e o
  -- delete-on-replace da rota, rodando como `service_role`, apagaria o logo da
  -- instalação inteira na troca seguinte.
  if v_path is not null
     and v_path !~ ('^' || p_org::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$')
  then
    raise exception 'logo_da_organizacao_caminho_fora_do_escopo'
      using errcode = '22023';
  end if;

  -- MESMO gate de papel da 0157, e repetido pela mesma razão: o chamador é uma
  -- rota cujo papel vem do snapshot de membership, não do banco. Repetir aqui é
  -- o que faz a regra valer para qualquer chamador futuro.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'logo_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  -- Merge no CAMPO, nunca no objeto: `jsonb_set` direto em '{branding,logo_path}'
  -- NÃO funcionaria com `branding` ausente (create_missing só cria a última
  -- chave, e o caminho intermediário faltando devolve o jsonb original intocado —
  -- silenciosamente). Por isso a chave `branding` é reconstruída a partir dela
  -- mesma, com `|| ` acrescentando ou substituindo só `logo_path`.
  update public.organizations o
     set settings = case
           when v_path is null
             then jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb) - 'logo_path', true)
           else jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    coalesce(o.settings -> 'branding', '{}'::jsonb)
                      || jsonb_build_object('logo_path', v_path), true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_logo_da_organizacao(uuid, uuid, text) is
  'Grava (ou apaga) organizations.settings.branding.logo_path com merge no CAMPO — não toca em app_name, accent_hex nem nas demais chaves de settings. Assevera que o caminho começa pelo proprio organization_id: caminho de outro escopo levanta 22023. Papel insuficiente levanta 42501. Devolve linhas afetadas: 0 = a organização não existe. Chamador: app/api/v1/marca/logo/route.ts.';

-- ── O FORWARD-FIX DA 0157 ───────────────────────────────────────────────────
--
-- Sem as três linhas de `logo_path` abaixo, salvar nome/cor pela tela apaga o
-- logo da organização — em silêncio, com a tela dizendo "salvo". Sabotá-las tem
-- de reprovar `tests/invariants/marca-logo.test.ts` e só ele.

create or replace function public.fn_definir_marca_da_organizacao(
  p_org   uuid,
  p_actor uuid,
  p_marca jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_hex    text;
  v_limpar boolean;
begin
  if p_org is null or p_actor is null then
    raise exception 'marca_da_organizacao_argumento_nulo'
      using errcode = '22023';
  end if;

  v_limpar := p_marca is null or jsonb_typeof(p_marca) = 'null';

  if not v_limpar and jsonb_typeof(p_marca) <> 'object' then
    raise exception 'marca_da_organizacao_forma_invalida: %', jsonb_typeof(p_marca)
      using errcode = '22023';
  end if;

  v_hex := nullif(p_marca ->> 'accent_hex', '');
  if v_hex is not null and v_hex !~ '^#[0-9a-f]{6}$' then
    raise exception 'marca_da_organizacao_accent_hex_invalido'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'marca_da_organizacao_sem_permissao'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = case
           -- "Limpar" com logo gravado NÃO apaga o logo: o campo tem controle
           -- próprio na tela (upload/remover), e limpar nome+cor é a resposta a
           -- OUTRA pergunta. Sem logo, a chave `branding` some inteira — é o
           -- comportamento da 0157 e o que o resolvedor espera para "esta
           -- organização não fala de marca".
           when v_limpar and coalesce(o.settings #>> '{branding,logo_path}', '') = ''
             then coalesce(o.settings, '{}'::jsonb) - 'branding'
           when v_limpar
             then jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    jsonb_build_object('logo_path', o.settings #> '{branding,logo_path}'), true)
           -- `p_marca ||  preservado`: o lado DIREITO vence em `||`, então o
           -- `logo_path` que já estava gravado sobrevive à substituição do
           -- objeto. `jsonb_strip_nulls` só no fragmento preservado (nunca em
           -- `p_marca`, cujo `app_name: null` é um valor com significado):
           -- sem logo gravado, `{"logo_path": null}` vira `{}` e nada é
           -- acrescentado.
           else jsonb_set(
                    coalesce(o.settings, '{}'::jsonb), '{branding}',
                    p_marca || jsonb_strip_nulls(
                      jsonb_build_object('logo_path', o.settings #> '{branding,logo_path}')), true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb) is
  'Grava organizations.settings.branding com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb (llm, routing, visibility_mode, atrito, ai_dispatch_mode, canonical_conversation_tags, lost_reasons_extra, plan) e PRESERVANDO branding.logo_path, que tem escritor próprio (fn_definir_logo_da_organizacao, migration 0158). Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501. Chamador: app/actions/settings/updateMarcaDaOrganizacao.ts.';

-- ── OS DOIS REVOKES EM CADA FUNÇÃO (CLAUDE.md, item 9) ──────────────────────
--
-- São origens DISTINTAS de EXECUTE e tratar uma só deixa a função exposta com o
-- gate verde:
--   (A) `from public` — o grant que o Postgres dá a PUBLIC ao criar QUALQUER
--       função; `revoke ... from anon` não o remove.
--   (B) `from anon`   — o grant DIRETO do `ALTER DEFAULT PRIVILEGES ... GRANT
--       ALL ON FUNCTIONS TO anon` do baseline, que vale para toda função criada
--       depois dele; `revoke ... from public` não o remove.
-- `from authenticated` pelo motivo de (B) e mais um: as duas são VOLÁTEIS
-- (escrevem). Definer volátil alcançável por qualquer usuário logado é escrita
-- cross-tenant. O único chamador é o admin client (`service_role`).

revoke execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_logo_da_organizacao(uuid, uuid, text)
  to service_role;

revoke execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_marca_da_organizacao(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';

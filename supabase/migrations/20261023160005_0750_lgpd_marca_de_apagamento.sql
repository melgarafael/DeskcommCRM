-- manifest: Ao anonimizar um contato, guarda só uma marca embaralhada (HMAC com sal próprio) do telefone e do lid do WhatsApp, e expõe ao servidor a pergunta "este número foi apagado a pedido?" — a trava que a importação do histórico do WhatsApp (#999, PR #3194) consulta para não trazer de volta quem pediu para sair (doc 186 do dono, resposta 2=B).
--
-- O PROBLEMA. A anonimização zera o telefone do contato. O WhatsApp do número,
-- porém, ainda guarda as conversas antigas dessa pessoa, e a importação do
-- histórico as traria de volta — como contato novo, porque nada no CRM lembra
-- que aquele número pediu para ser apagado. Apagar a pedido não se desfaz
-- (403 `lgpd_anonymization_irreversible`); esta função o desfaria calada.
--
-- O MECANISMO É O DA PROSPECÇÃO (migration 0370), não um novo: ao apagar, a
-- prospecção guarda `hmac(telefone, sal)` com um sal aleatório por linha e
-- recusa recadastrar quem casa. Aqui é igual, numa tabela própria porque o
-- contato não é candidato de prospecção:
--   - nada em claro: só o sal e os dois HMACs. Sem o número na mão, a linha não
--     diz de quem é;
--   - só o servidor lê: RLS ligada, nenhuma policy, nenhum grant a anon nem a
--     authenticated. Sal + HMAC ao alcance do navegador seriam reversíveis por
--     força bruta (o espaço de celulares é pequeno), por isso a marca NÃO mora
--     numa coluna de `contacts`;
--   - nasce num gatilho AFTER UPDATE OF is_anonymized, como os outros
--     consumidores da anonimização (`trg_reply_redact`,
--     `trg_anonimizar_aviso_de_remetente`). Todo caminho que anonimiza — a
--     cascata, o passo 1 legado, o store-redact — vira `is_anonymized` e zera o
--     telefone no MESMO update, então `old` ainda tem o número. Um gatilho
--     alcança todos sem copiar a cascata de ~650 linhas.
--
-- A COMPARAÇÃO É POR VARIANTE (`fn_telefone_variantes`): grava-se o HMAC dos
-- dígitos como estavam, e a pergunta testa as duas grafias do nono dígito do
-- número consultado. O lid entra porque a importação também acha conversas que
-- só têm lid (sem telefone).
--
-- O QUE NÃO COBRE: contato anonimizado ANTES desta migration. O telefone dele
-- já foi zerado e não há de onde tirar a marca — não há backfill possível.

create table if not exists public.lgpd_marcas_de_apagamento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sal bytea not null,
  marca_telefone bytea,
  marca_lid bytea,
  created_at timestamptz not null default now(),
  constraint lgpd_marcas_de_apagamento_alguma_marca
    check (marca_telefone is not null or marca_lid is not null)
);
create index if not exists lgpd_marcas_de_apagamento_org
  on public.lgpd_marcas_de_apagamento(organization_id);
alter table public.lgpd_marcas_de_apagamento enable row level security;
revoke all on public.lgpd_marcas_de_apagamento from public, anon, authenticated, service_role;
grant select on public.lgpd_marcas_de_apagamento to service_role;

create or replace function public.fn_lgpd_guardar_marca_de_apagamento()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_telefone text := nullif(regexp_replace(coalesce(old.phone_number, ''), '\D', '', 'g'), '');
  v_lid text := old.wa_lid;
  v_sal bytea;
begin
  if v_telefone is null and v_lid is null then
    return null;
  end if;
  v_sal := gen_random_bytes(32);
  insert into public.lgpd_marcas_de_apagamento (organization_id, sal, marca_telefone, marca_lid)
  values (
    new.organization_id,
    v_sal,
    case when v_telefone is null then null else hmac(convert_to(v_telefone, 'UTF8'), v_sal, 'sha256') end,
    case when v_lid is null then null else hmac(convert_to(v_lid, 'UTF8'), v_sal, 'sha256') end
  );
  return null;
end $$;
revoke execute on function public.fn_lgpd_guardar_marca_de_apagamento() from public, anon, authenticated, service_role;

drop trigger if exists trg_lgpd_guardar_marca_de_apagamento on public.contacts;
create trigger trg_lgpd_guardar_marca_de_apagamento after update of is_anonymized on public.contacts
  for each row when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_lgpd_guardar_marca_de_apagamento();

-- A pergunta. Invoker (não definer): quem chama é o servidor, que já tem SELECT.
create or replace function public.fn_titular_apagado_a_pedido(p_org uuid, p_telefone text, p_lid text)
returns boolean language sql stable
set search_path = public, extensions, pg_temp as $$
  select exists (
    select 1
      from public.lgpd_marcas_de_apagamento m
     where m.organization_id = p_org
       and (
         (m.marca_telefone is not null and exists (
            select 1 from unnest(public.fn_telefone_variantes(p_telefone)) as v(digitos)
             where m.marca_telefone = hmac(convert_to(v.digitos, 'UTF8'), m.sal, 'sha256')))
         or (m.marca_lid is not null
             and nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '') is not null
             and m.marca_lid = hmac(convert_to(regexp_replace(p_lid, '@.*$', ''), 'UTF8'), m.sal, 'sha256'))
       )
  );
$$;
revoke execute on function public.fn_titular_apagado_a_pedido(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_titular_apagado_a_pedido(uuid, text, text) to service_role;

notify pgrst, 'reload schema';

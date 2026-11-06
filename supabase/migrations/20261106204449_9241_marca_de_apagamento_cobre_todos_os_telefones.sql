-- manifest: **A marca de apagamento cobre todos os telefones do contato.** `fn_lgpd_guardar_marca_de_apagamento` passa a gravar em `lgpd_marcas_de_apagamento` uma linha por telefone da ficha, o principal e os extras de `contact_phones`, cada uma com sal próprio, o HMAC dos dígitos e o `lid` daquele número; mesma tabela, mesma normalização, nada em claro, e `fn_titular_apagado_a_pedido` segue igual. Corpo novo, assinatura, `search_path`, `security definer`, gatilho e grants inalterados. Vale para as anonimizações feitas a partir desta versão. Idempotente; espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116). Prova em `tests/invariants/lgpd-marca-de-apagamento.test.ts`.
--
-- O gatilho roda no `update` do passo 1 da cascata, antes de o passo 1b apagar
-- `contact_phones`: é por isso que os extras ainda estão aqui para serem lidos,
-- como em `fn_redigir_conversas_ao_anonimizar`. A virada de `is_anonymized`
-- acontece uma vez só, então a segunda anonimização não grava nada de novo.
create or replace function public.fn_lgpd_guardar_marca_de_apagamento()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_alvo record;
  v_sal bytea;
begin
  for v_alvo in
    select distinct nullif(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g'), '') as telefone, a.lid
      from (
        select old.phone_number as telefone, old.wa_lid as lid
        union all
        select t.phone_number, t.wa_lid
          from public.contact_phones t
         where t.organization_id = new.organization_id and t.contact_id = new.id
      ) as a
  loop
    continue when v_alvo.telefone is null and v_alvo.lid is null;
    v_sal := gen_random_bytes(32);
    insert into public.lgpd_marcas_de_apagamento (organization_id, sal, marca_telefone, marca_lid)
    values (
      new.organization_id,
      v_sal,
      case when v_alvo.telefone is null then null else hmac(convert_to(v_alvo.telefone, 'UTF8'), v_sal, 'sha256') end,
      case when v_alvo.lid is null then null else hmac(convert_to(v_alvo.lid, 'UTF8'), v_sal, 'sha256') end
    );
  end loop;
  return null;
end $$;
revoke execute on function public.fn_lgpd_guardar_marca_de_apagamento() from public, anon, authenticated, service_role;

-- manifest: Revalidar a sessão Auth na criação delegada para impedir provisionamento por sessão encerrada ou expirada.
create or replace function public.fn_agencia_criar_cliente(p_agencia uuid,p_chave uuid,p_nome text,p_slug text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_recibo public.agencia_criacoes; v_pedido jsonb;
begin
 -- Mesma ordem de lock da hierarquia; habilitação, cota e criação se serializam.
 perform pg_advisory_xact_lock(739021,1);
 perform 1 from agencia_configuracoes where organization_id=p_agencia for update;
 if not exists(select 1 from auth.sessions where id=nullif(auth.jwt()->>'session_id','')::uuid
 and user_id=auth.uid() and (not_after is null or not_after>now())) then
 raise exception 'agencia_sessao_invalida' using errcode='42501'; end if;
 if not public.fn_agencia_pode_gerir(p_agencia) then raise exception 'agencia_acesso_negado' using errcode='42501'; end if;
 if p_chave is null or p_nome is null or length(btrim(p_nome)) not between 2 and 120
 or p_slug is null or length(p_slug) not between 2 and 40 or p_slug !~ '^[a-z0-9-]+$' then
 raise exception 'agencia_cadastro_invalido' using errcode='22023'; end if;
 if exists(select 1 from auth.mfa_factors where user_id=auth.uid() and status='verified')
 and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required' using errcode='42501'; end if;
 v_pedido:=jsonb_build_object('display_name',btrim(p_nome),'slug',p_slug);
 select * into v_recibo from agencia_criacoes where organization_id=p_agencia and actor_user_id=auth.uid() and chave=p_chave;
 if found then
 if v_recibo.pedido<>v_pedido then raise exception 'agencia_chave_divergente' using errcode='PT409'; end if;
 return jsonb_build_object('id',v_recibo.cliente_id,'created',false);
 end if;
 -- Só a plataforma autoriza clientes inclusos no acordo comercial da agência.
 if public.fn_cobranca_ligada() and not (select clientes_inclusos from agencia_configuracoes where organization_id=p_agencia) then raise exception 'agencia_cobranca_exige_plataforma' using errcode='PT409'; end if;
 insert into organizations(display_name,legal_name,slug,status,settings,created_by)
 values(btrim(p_nome),btrim(p_nome),p_slug,'active','{}'::jsonb,null) returning id into v_id;
 -- Evita o trial do cadastro público: o acordo da agência já autorizou a inclusão.
 -- Ator real preservado antes de concluir a mesma transação.
 update organizations set created_by=auth.uid() where id=v_id;
 insert into agencia_clientes(organization_id,agencia_id) values(v_id,p_agencia);
 insert into agencia_criacoes values(p_agencia,auth.uid(),p_chave,v_pedido,v_id);
 return jsonb_build_object('id',v_id,'created',true);
end; $$;
revoke all on function public.fn_agencia_criar_cliente(uuid,uuid,text,text) from public,anon;
grant execute on function public.fn_agencia_criar_cliente(uuid,uuid,text,text) to authenticated;

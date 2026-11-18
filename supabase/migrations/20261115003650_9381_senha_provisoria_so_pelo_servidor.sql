-- manifest: `user_organizations.senha_provisoria` só muda pelo servidor — gatilho recusa (42501) INSERT marcado e UPDATE da coluna feitos pela sessão (authenticated/anon); a rota de criação e a troca de senha escrevem com service role.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9381 — A marca da senha provisória não é escrita pela sessão.
--
-- A 9380 criou a coluna, mas a policy `user_orgs_update` deixa o admin da
-- organização reescrever qualquer coluna do vínculo — inclusive esta. Como a
-- troca obrigatória vale para a PESSOA (qualquer vínculo marcado tranca a
-- sessão inteira), o admin de uma empresa conseguiria forçar a troca de senha
-- de alguém que também é membro de outra empresa; e conseguiria desligar a
-- marca de quem ele mesmo criou, pulando a troca.
--
-- Quem liga a marca é a rota de criação (`POST /api/v1/team/users`); quem
-- desliga é a troca de senha (primeiro acesso ou recuperação). Os dois usam o
-- cliente de serviço. A sessão não tem motivo para tocar nesta coluna.
--
-- Molde: `fn_membro_provisorio_so_pelo_servidor` (mesma tabela) e
-- `fn_contacts_fusao_e_anonimizacao_so_pelo_servidor`: o alvo é o PAPEL da
-- sessão (`current_user`), não a policy. `security invoker`, então dentro de
-- uma função `security definer` do servidor o papel é o dono e passa.
--
-- Reaplicação: `create or replace` + `drop trigger if exists`.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_senha_provisoria_so_pelo_servidor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.senha_provisoria)
     or (tg_op = 'UPDATE' and new.senha_provisoria is distinct from old.senha_provisoria) then
    raise exception 'senha_provisoria_so_pelo_servidor'
      using errcode = '42501',
            detail = 'A marca da senha provisória é escrita pela criação da pessoa e pela troca de senha, nunca pela sessão.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_senha_provisoria_so_pelo_servidor() from public, anon, authenticated;

drop trigger if exists trg_senha_provisoria_so_pelo_servidor on public.user_organizations;
create trigger trg_senha_provisoria_so_pelo_servidor
  before insert or update of senha_provisoria
  on public.user_organizations
  for each row execute function public.fn_senha_provisoria_so_pelo_servidor();

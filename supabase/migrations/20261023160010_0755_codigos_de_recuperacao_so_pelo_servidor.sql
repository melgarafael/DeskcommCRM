-- manifest: **A tabela de códigos de recuperação (`user_recovery_codes`) passa a ser lida e gravada só pelo servidor.** Quem a escreve são três ações do app — confirmar o cadastro da verificação em duas etapas, gerar códigos novos em Configurações › Segurança e usar um código na tela de entrada —, e as três passam a usar o client de serviço, DEPOIS das checagens de sessão que cada uma faz. Nenhuma tela lê a tabela pelo client do usuário. Por isso os privilégios de `anon` e `authenticated` saem por inteiro (`revoke all`), e a policy `recovery_codes_self` (FOR ALL, `user_id = auth.uid()`) é trocada por uma negação escrita só de leitura (`user_recovery_codes_ninguem_le`, `using (false)`) — o molde de `calendar_oauth_nonces` (0192): RLS ligada sem policy já nega tudo, mas no catálogo negação deliberada e esquecida são indistinguíveis. A troca de policy vai num bloco DO (o `revoke` fica fora dele, para não ser desfeito junto se a troca falhar): o `update.sh` re-aplica o baseline SEM `ON_ERROR_STOP`, e drop + create soltos podem deixar a tabela sem a policy nova se o segundo falhar. `service_role` não muda (bypassa RLS e mantém o GRANT). Vigiado por `tests/invariants/codigos-de-recuperacao-so-o-servidor-grava.test.ts`. Idempotente, psql puro, sem BEGIN/COMMIT; espelho no apêndice do `baseline.sql`, antes da VARREDURA anon; o corpo do baseline deixa de conceder a `anon`/`authenticated` e de criar a policy antiga (a cerca `baseline-nao-constroi-o-que-derruba` reprova grant e policy reaplicados só para serem desfeitos adiante).

-- O revoke fica FORA do bloco: se a troca de policy falhar, ele não é desfeito
-- junto, e a policy antiga sem privilégio nenhum não abre nada.
revoke all on table public.user_recovery_codes from anon, authenticated;

do $$
begin
  drop policy if exists recovery_codes_self on public.user_recovery_codes;
  drop policy if exists user_recovery_codes_ninguem_le on public.user_recovery_codes;
  create policy user_recovery_codes_ninguem_le
    on public.user_recovery_codes
    for select
    using (false);
end
$$;

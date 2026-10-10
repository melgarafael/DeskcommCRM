-- ============================================================================
-- 0192 — A PODA DE NONCES ERA EXECUTÁVEL POR QUALQUER USUÁRIO LOGADO
--
-- `fn_expurgar_nonces_de_oauth` nasceu na 0190 com
-- `revoke ... from public, anon` — e as DUAS irmãs de assinatura idêntica
-- revogam de `public, anon, authenticated`:
--
--   fn_expurgar_auditoria_vencida(int,int)  from public, anon, authenticated
--   fn_expurgar_espelho_da_agenda(int,int)  from public, anon, authenticated
--   fn_expurgar_nonces_de_oauth(int,int)    from public, anon          ← esta
--
-- O `authenticated` não vem de um grant escrito: vem do
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO authenticated` do
-- baseline, que alcança toda função criada depois dele. Então a omissão não
-- aparece como uma linha errada — aparece como uma linha AUSENTE, que é o modo
-- de falha que a doutrina de função exposta deste repo já nomeia.
--
-- ⚠️ O QUE ISTO PERMITIA, concretamente: qualquer usuário logado de QUALQUER
-- organização podia chamar a RPC pelo PostgREST e apagar os nonces de OAuth de
-- TODOS os tenants — a função é `security definer` e não tem recorte por org
-- (não precisa ter: o único chamador é o cron de retenção, com service role).
-- Não vaza dado; derruba a conexão do Google de quem estivesse no meio do
-- fluxo, de graça e sem rastro de quem foi.
--
-- Não é vazamento de dado, e é exatamente por isso que passou: quem revisa
-- procura leitura indevida, e esta função só APAGA.
--
-- Achado por `tests/invariants/hardening-definer-varredura.test.ts`, que varre
-- TODA definer volátil de `public` — não uma lista fixa. Foi a varredura que
-- pegou, não a leitura.
--
-- Forward-fix em vez de editar a 0190: quem já aplicou a 0190 numa base local
-- não reexecutaria o arquivo editado.
-- ============================================================================

revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int)
  from public, anon, authenticated;
grant  execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;

-- ─── E A NEGAÇÃO PASSA A SER ESCRITA, NÃO IMPLÍCITA ──────────────────────
-- `calendar_oauth_nonces` tem RLS ligada e ZERO policy. Isso já nega tudo para
-- `anon`/`authenticated`, e é o estado certo: quem escreve é o callback do
-- OAuth com service role, e ninguém precisa LER isto pela API.
--
-- Mas `tests/invariants/agenda-nenhuma-tabela-sem-rls.test.ts` cobra ao menos
-- uma policy em tabela de agenda com `organization_id`, e ele está CERTO em
-- cobrar: negação implícita e negação esquecida têm exatamente a mesma
-- aparência no catálogo. A primeira tentativa de conserto foi declarar a tabela
-- numa allowlist do invariante — o catraca de `tests/invariants/**` bloqueou, e
-- também estava certo: invariante incômodo se ESCALA, não se edita.
--
-- A policy abaixo não abre nada. Ela escreve no schema o que antes era
-- ausência, e quem ler o catálogo vê a decisão em vez de deduzi-la de um vazio.
drop policy if exists tenant_isolation_calendar_oauth_nonces_all on public.calendar_oauth_nonces;
drop policy if exists calendar_oauth_nonces_ninguem_le on public.calendar_oauth_nonces;
create policy calendar_oauth_nonces_ninguem_le
  on public.calendar_oauth_nonces
  for select
  using (false);

-- Por que SELECT e não ALL: a primeira versão desta policy era `for all
-- using(false)`, e um SEGUNDO invariante a reprovou —
-- `rbac-config-ia-canais.test.ts` proíbe tabela nova entrar com policy `ALL` que
-- não cite `role_at_least`. Os dois invariantes estavam certos ao mesmo tempo, e
-- a discordância deles apontou a forma correta: a intenção escrita na 0190 é
-- "ninguém precisa LER isto pela API", que é uma frase sobre SELECT. Escrita
-- segue negada pelo RLS sem policy que a case — mais estreito, não menos.

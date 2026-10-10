-- manifest: **O teto do nome de sessão WAHA deixa de ser asserção e passa a ser recusa do banco (issue #686).** O `@MaxLength(54)` do WAHA era conferido em três lugares de CÓDIGO — teste de banco, teste unitário, guarda antes do transporte — e em nenhum deles do lado de quem ESCREVE a linha: um INSERT direto (PostgREST, script, ou uma migration que copie o corpo da 0230, que ainda traz o gerador de 69 caracteres) gravava `waha_session_name` acima do teto sem que nada recusasse, e o 400 só aparecia contra o WAHA de verdade no primeiro Conectar. Agora `channel_sessions` recusa a linha (`trg_teto_nome_de_sessao_waha`, BEFORE INSERT OR UPDATE, `22023`): o teto mora no banco, junto do dado. **Instalação existente com nome antigo não quebra por construção**: a recusa olha só o nome que está sendo ESCRITO — uma linha de 69 caracteres continua atualizável (status, metadata, lease) enquanto o nome não muda, e o rename para outro nome grande é que cai; nenhuma escrita de produção passa de 54 hoje (gerador da 0232 = 45, `nomeCurtoDaSessao` = 12, `nomeDaSessaoNovo` = 45). Idempotente: `create or replace` + `drop trigger if exists`; apêndice igual no fim do `baseline.sql`.

-- ============================================================================
-- 0543 — O TETO DO NOME DE SESSÃO WAHA FICA NO BANCO, NÃO SÓ NO TESTE
--
-- A issue #686 nasceu de um invariante que media ESTABILIDADE (mesmo nome no
-- retry) enquanto o gerador emitia 69 caracteres e o WAHA recusava acima de 54:
-- 100% das criações de canal morriam com `waha_create_400`. O #658 pôs o
-- `toBeLessThanOrEqual(54)` no teste de banco, a 0232 consertou o gerador
-- (`org_<8>_<32>` = 45) e o CRM passou a conferir o teto antes do transporte.
-- Todos os consertos, porém, são asserções e guarda de LEITURA: nada impedia a
-- próxima escrita de um nome acima do teto.
--
-- Medido no que ainda escreve nome hoje:
--   * `fn_reserve_channel_connection` (0232)          → 45
--   * `nomeCurtoDaSessao` no onboarding               → 12
--   * `nomeDaSessaoNovo` (cura em `connect-waha.ts`)  → 45
--   * o backfill da 0232                              → 45
-- Nenhum passa de 54 — mas os três lugares que CONFEREM são o teste de banco,
-- o teste unitário e a guarda do transporte, e nenhum deles roda dentro do
-- INSERT. Um script, um PostgREST à mão ou uma migration que copie o corpo da
-- 0230 (`supabase/migrations/20260907060000_0230_reserva_pre_go_live.sql:37`
-- ainda traz `'org_'||replace(p_org::text,'-','')||...` = 69) reabria o defeito
-- em silêncio, e ele só voltaria a aparecer no primeiro canal conectado contra
-- um WAHA de verdade.
--
-- ─── A recusa ────────────────────────────────────────────────────────────────
--
-- BEFORE INSERT OR UPDATE, `22023` (mesmo errcode das recusas de domínio da
-- reserva). Ela olha o nome que está sendo escrito, e só ele:
--
--   INSERT com nome > 54                              → recusa;
--   UPDATE que MUDA o nome para > 54                  → recusa;
--   UPDATE que mantém o nome antigo > 54 (status etc) → passa;
--   qualquer nome ≤ 54                                → passa.
--
-- A terceira linha é a compatibilidade da instalação existente, medida como
-- propriedade do próprio trigger e não suposta: uma linha `org_<32>_<32>` que a
-- 0232 não renomeou (o WHERE dela poupa pareado e WORKING) continua operável —
-- atualizar status, metadata ou lease não pode depender de a gente ter consertado
-- o nome antes. Renomear para CIMA do teto continua proibido, que é o que a
-- 0232 já decidia do lado do CRM (`podeRenomearSessaoDoWaha`).
--
-- `old` só existe em UPDATE; por isso a recusa é IF aninhado em `tg_op` e não
-- `A or B` num único teste — a avaliação de `old.campo` num INSERT não é
-- garantida a nenhum dos dois lados.
--
-- O número 54 vive em dois lados (aqui e `TETO_NOME_DE_SESSAO_WAHA`), e o
-- `tests/unit/nome-da-sessao-do-waha.test.ts` confere que os dois são o mesmo:
-- mudar de um lado só reprova o teste.
-- ============================================================================

create or replace function public.fn_teto_nome_de_sessao_waha() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if length(coalesce(new.waha_session_name,'')) > 54 then
  if tg_op = 'INSERT' then
   raise exception 'waha_session_name_acima_do_teto: % caracteres; o WAHA aceita no máximo 54', length(new.waha_session_name) using errcode='22023';
  elsif new.waha_session_name is distinct from old.waha_session_name then
   raise exception 'waha_session_name_acima_do_teto: % caracteres; o WAHA aceita no máximo 54', length(new.waha_session_name) using errcode='22023';
  end if;
 end if;
 return new;
end;$$;
revoke all on function public.fn_teto_nome_de_sessao_waha() from public,anon,authenticated;
drop trigger if exists trg_teto_nome_de_sessao_waha on public.channel_sessions;
create trigger trg_teto_nome_de_sessao_waha before insert or update on public.channel_sessions
 for each row execute function public.fn_teto_nome_de_sessao_waha();

notify pgrst,'reload schema';

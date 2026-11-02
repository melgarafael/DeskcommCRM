-- manifest: A vaga de número do plano deixa de ser ocupada por sessão WAHA que morreu SEM parear (#3416); quem tem número — FAILED inclusive — e quem tem conexão em curso continua contando.
-- 0809 — O SLOT DO PLANO É DO NÚMERO, NÃO DA LINHA (#3416).
--
-- ── A causa, medida no produto ──────────────────────────────────────────────
-- Plano com "Máximo de números conectados: 1", canal QR (WAHA NOWEB). No
-- assistente do primeiro acesso a pessoa abre o QR e não lê com o celular; o QR
-- expira e o transporte entrega `FAILED`. A sessão fica `status = 'FAILED'` e
-- `phone_number` NULO, porque nunca houve pareamento — e a contagem do teto, que
-- era `archived_at is null and provider <> 'wacalls'` (0583), a tratava como o
-- número ocupado da empresa. O cliente seguinte era recusado com "Seu plano
-- permite 1 número conectado" e a vaga ficava presa numa conexão que não existe.
--
-- ── O conserto é NA REGRA DE CONTAGEM ───────────────────────────────────────
-- Não há tela a corrigir e nada a arquivar: quem decide a cobrança é o
-- `count(*)` deste gatilho, e é ele que passa a perguntar "esta linha ocupa um
-- número?" antes de somar. Uma linha só ocupa a vaga quando:
--
--   · tem `phone_number` — número pareado é número ocupado, e `FAILED` também
--     conta: a queda do transporte não devolve a vaga enquanto o número existir;
--   · ou está numa conexão EM CURSO (`STARTING`/`SCAN_QR_CODE`) ou `WORKING`
--     sem número ainda gravado. `WORKING` sem número é atraso do espelho (o
--     número é gravado na leitura de saúde, com o transporte em WORKING,
--     `app/api/v1/channel-sessions/[id]/route.ts` + `numeroObservadoDaSessao`),
--     não ausência de conexão.
--
-- Fica de fora só a linha MORTA e SEM NÚMERO do WAHA: `FAILED`/`STOPPED` com
-- `phone_number` nulo e `provider = 'waha'`. É a sessão que nasceu de um QR que
-- ninguém leu. Nos outros provedores o número não identifica a conexão (ela é
-- endereçada por conta/id do provedor), e a linha sem número continua ocupando.
--
-- ⚠️ A metade do RESERVADO é o que impede trocar um defeito de cobrança por
-- outro maior. A trava é de CRIAÇÃO de linha; o pareamento não passa por ela
-- (o UPDATE que grava `phone_number` não dispara este gatilho, de propósito —
-- recusar ali deixaria o número pareado no WhatsApp e o CRM sem ele, e uma org
-- acima do teto não pode virar PT402 por reconectar um número que já está no
-- ar). Se `STARTING`/`SCAN_QR_CODE` também não contassem, abrir N QRs com teto 1
-- passaria e o pareamento de todos daria N números: o teto deixaria de existir.
--
-- ── O que NÃO muda ──────────────────────────────────────────────────────────
-- A guarda de transição do UPDATE (reconexão/troca de número de canal que já
-- está no ar continua saindo antes da contagem), a trava consultiva — a MESMA
-- de `fn_reserve_channel_connection`, `hashtextextended(org, 2281)` —, a
-- mensagem `limite_do_plano:<recurso>:<teto>` com o DETAIL `{recurso, limite,
-- em_uso}` (contrato de `lib/cobranca/limites.ts`), o `wacalls` fora da conta e
-- o arquivamento liberando a vaga.
--
-- LIMITE DECLARADO: uma linha morta sem número pode ser ressuscitada pelo
-- "Reconectar" (o `status` volta a `STARTING` por UPDATE, que este gatilho não
-- observa) e pareada com outro número. Fechar isso exigiria disparar no UPDATE
-- de `status`, e aí o próprio espelho do webhook (`lib/waha/ingest.ts`) viraria
-- PT402 no meio de uma reconexão já pareada. A régua escolhida é a da casa:
-- tolerar a org acima do teto, nunca derrubar número que já está no ar — e a
-- criação SEGUINTE continua recusada.
--
-- Gêmeo do app na mesma régua: `lib/cobranca/uso.ts` (`lerUsoDaOrganizacao`),
-- que é quem diz à tela e à troca de plano quantas vagas estão em uso.
-- Gates: `tests/invariants/cobranca-canais-sem-numero-nao-ocupa.test.ts`
-- (a régua de quem ocupa) e `tests/invariants/cobranca-canais.test.ts`
-- (a contagem em si, intacta).
--
-- Idempotente: `create or replace`. Sem BEGIN/COMMIT. A função perde EXECUTE de
-- public, anon e authenticated, como na 0583 — ela é gatilho, não API; o grant
-- explícito que interessa é o da `fn_limite_do_plano`, já dado a service_role.

create or replace function public.fn_trava_canais_do_plano()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite integer;
  v_em_uso integer;
begin
  if new.archived_at is not null or new.provider = 'wacalls' then
    return new;
  end if;
  -- #3416: a linha que morreu sem nunca ter número não ocupa vaga — nem é
  -- recusada quando a empresa já está no teto, porque recusar seria cobrar por
  -- uma vaga que ela não ocupa (e o espelho de status do webhook congelaria).
  -- Só no WAHA: nos outros provedores o número não identifica a conexão, e a
  -- linha sem número segue sendo uma conexão da empresa.
  if new.provider = 'waha' and new.phone_number is null and new.status in ('FAILED', 'STOPPED') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.archived_at is null
       and old.provider <> 'wacalls'
       and new.organization_id is not distinct from old.organization_id then
      return new;
    end if;
  end if;

  v_limite := public.fn_limite_do_plano(new.organization_id, 'canais');
  if v_limite is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2281));

  select count(*) into v_em_uso
    from public.channel_sessions cs
   where cs.organization_id = new.organization_id
     and cs.archived_at is null
     and cs.provider <> 'wacalls'
     and (cs.provider <> 'waha' or cs.phone_number is not null or cs.status not in ('FAILED', 'STOPPED'))
     and cs.id <> new.id;

  if v_em_uso >= v_limite then
    raise exception 'limite_do_plano:canais:%', v_limite
      using errcode = 'PT402',
            detail = jsonb_build_object('recurso', 'canais', 'limite', v_limite, 'em_uso', v_em_uso)::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_trava_canais_do_plano() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- manifest: **Três tabelas saem da publicação `supabase_realtime` porque nenhum código as assina (#3697).** `ai_agents`, `crm_lead_risk_states` e `crm_lead_reactivations` estavam publicadas e não têm UMA assinatura `postgres_changes` em `hooks/`, `components/`, `app/`, `lib/`, `workers/` nem `scripts/` — cada escrita nelas passava pela decodificação do Realtime sem consumidor nenhum. Antes de tirar, a pergunta da issue foi medida: não há consumidor FORA do front (nenhum `.channel(`/`.on("postgres_changes"` fora de `hooks/`, nenhum worker ou script assinando as três). Idempotente e guardado por `pg_publication_tables`: só remove o que está de fato publicado.

-- ============================================================================
-- 9046 — O QUE NINGUÉM ASSINA SAI DA PUBLICAÇÃO (#3697)
--
-- A publicação `supabase_realtime` tinha 14 tabelas. Três delas não têm uma
-- única assinatura no código:
--
--   ai_agents              — a tela de agentes LÊ a tabela por PostgREST
--                            (`.from("ai_agents")`, dezenas de vezes) e nunca
--                            abre canal nela. Os workers de resposta e de
--                            sentimento também só leem.
--   crm_lead_risk_states   — o estado de risco é lido junto do negócio pelo
--                            board; nenhum `postgres_changes` a assina.
--   crm_lead_reactivations — a proposta de reativação é lida pela tela de
--                            retenção; nenhum canal a assina.
--
-- Custo de manter publicada sem consumidor: cada INSERT/UPDATE/DELETE nelas é
-- decodificado pelo Realtime, entra no WAL lógico decodificado e é descartado
-- — trabalho por escrita, em três tabelas que a IA escreve com frequência
-- (`ai_agents` a cada edição de cadastro e de versão).
--
-- ## A pergunta da issue, respondida por medição (não por leitura da tela)
--
-- "Existe consumidor FORA do front?" Não. O que foi varrido:
--
--   * `hooks/`, `components/`, `app/`, `lib/` — todo `table: "..."` dentro de
--     arquivo que tem `postgres_changes`/`postgresChanges`/`useRealtimeChannel`:
--     nenhuma das três aparece. As tabelas de fato assinadas são
--     `messages`, `conversations`, `crm_leads`, `crm_lead_activities`,
--     `voice_calls`, `conversation_notes`, `conversation_participants`,
--     `ai_knowledge_sources`, `ai_agent_runs` e `user_organizations`.
--   * `workers/` (ai-response, ai-sentiment, media-derive, lgpd-redact…) e
--     `scripts/` — só `.from("ai_agents")`/SQL de leitura e seed; nenhum
--     `channel(`/`.on(` de supabase-js em cima das três.
--   * `.channel(` e `.on(` de supabase-js fora de `hooks/` — o único canal de
--     fora é o broadcast `alerts-platform` (`lib/realtime/channels.ts`), que
--     não é `postgres_changes` e não toca tabela nenhuma.
--
-- O invariante `tests/unit/realtime-assinatura-tem-publicacao.test.ts` passa a
-- cobrar a volta: se alguma tela voltar a assinar uma destas três, o teste
-- reprova e a tabela tem que ser republicada. É a trava contra "tirei e alguém
-- dependia" daqui a seis meses.
--
-- ## Por que `drop` guardado, e não `drop table if exists`
--
-- `alter publication ... drop table` NÃO aceita `if exists`: numa instalação
-- onde a tabela saiu da publicação (ou nunca entrou) o comando levanta erro e
-- derruba a migration inteira. A guarda é a mesma das 0071/0075/0078/0082 e é
-- lida da própria publicação: só executa quando a tabela ESTÁ em
-- `pg_publication_tables`. `execute` com string literal (molde da 0075) também
-- mantém o nome visível no arquivo — um `format('... public.%I', t)` ficaria
-- invisível para o extrator do invariante, e a tabela continuaria contando
-- como publicada.
--
-- O comentário da tabela de risco também mentiria depois disto ("DENTRO da
-- publicação", texto da 0078): corrigido aqui para quem MIGRA, e editado no
-- lugar no `baseline.sql` para quem instala do zero — os dois caminhos têm que
-- terminar com o mesmo banco, comentários inclusive.
-- ============================================================================

comment on table public.crm_lead_risk_states is
  'Estado de risco por negócio (wave 7 — o ciclo). FORA de crm_leads pelos motivos da 0075 (pulso que mente, 409 fantasma). Saiu da publicação supabase_realtime na 9046 (#3697): nenhuma tela assina esta tabela, e publicada sem consumidor ela só custava decodificação por escrita. O escritor só grava quando o bucket muda.';

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    -- publicação ausente: nada a tirar (instância que nunca ligou realtime).
    return;
  end if;

  -- ai_agents: a tela de agentes lê por PostgREST; nenhum canal assina.
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'ai_agents'
  ) then
    execute 'alter publication supabase_realtime drop table public.ai_agents';
  end if;

  -- crm_lead_risk_states: risco é lido junto do negócio; nenhum canal assina.
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_risk_states'
  ) then
    execute 'alter publication supabase_realtime drop table public.crm_lead_risk_states';
  end if;

  -- crm_lead_reactivations: proposta de reativação é lida pela tela; nenhum
  -- canal assina.
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_reactivations'
  ) then
    execute 'alter publication supabase_realtime drop table public.crm_lead_reactivations';
  end if;
end $$;

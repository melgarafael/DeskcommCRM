-- ============================================================================
-- 0128 — O LOG DE IA PASSA A REGISTRAR O QUE DEU ERRADO.
--
-- `llm_calls` grava uma linha por chamada de modelo — e só quando ela dá certo.
-- O INSERT vive DEPOIS do `generateText` em `run-model-call.ts`, sem `try`
-- em volta: se o provedor recusa a chave, se o modelo não existe, se a conta
-- estourou o limite, a exceção sobe e NADA fica gravado.
--
-- É por isso que o operador "não vê o erro, não vê por que falha". A tabela que
-- deveria explicar é justamente a que fica vazia no caso que precisa de
-- explicação: chamada bem-sucedida deixa rastro, chamada que falhou não deixa
-- nenhum. O painel de uso mostra o mês inteiro sem uma linha vermelha, e o
-- agente simplesmente não responde.
--
-- ## O que entra
--
-- `status` — 'ok' | 'erro'. Default 'ok' para que toda linha histórica (todas
-- bem-sucedidas, por construção) continue correta sem backfill.
--
-- `error_code` / `error_message` — o código normalizado e o texto do provedor,
-- truncado. NUNCA o prompt, nunca a resposta, nunca a chave: mensagem de erro
-- de provedor às vezes ecoa o corpo da requisição, e este repo trata conteúdo
-- de mensagem como PII.
--
-- `http_status` — separa o que é problema de credencial (401/403) do que é
-- limite de uso (429) e do que é indisponibilidade (5xx). São três conversas
-- diferentes com quem instalou.
--
-- `origem_da_escolha` — de ONDE veio a decisão de usar aquele modelo (painel,
-- agente publicado, variável de ambiente, padrão). É o campo que transforma o
-- log de "o que aconteceu" em "por que aconteceu", e sem ele a tela de
-- execuções mostraria um modelo errado sem dizer quem o escolheu.
--
-- `purpose` já existia e agora é o eixo de leitura da tela de execuções.
--
-- Tudo aditivo e idempotente; nenhuma linha existente muda de significado.
-- ============================================================================

alter table public.llm_calls add column if not exists status text not null default 'ok';
alter table public.llm_calls add column if not exists error_code text;
alter table public.llm_calls add column if not exists error_message text;
alter table public.llm_calls add column if not exists http_status int;
alter table public.llm_calls add column if not exists origem_da_escolha text;

-- CHECK só depois de garantir que os dados o respeitam (o default já cobre as
-- linhas antigas, mas um clone que rodou versão intermediária pode ter outro
-- valor — e o update.sh roda sem ON_ERROR_STOP, então a constraint seria pulada
-- em silêncio e o vocabulário ficaria sem guarda nenhuma).
update public.llm_calls set status = 'ok' where status is null or status not in ('ok', 'erro');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_calls_status_check') then
    alter table public.llm_calls
      add constraint llm_calls_status_check check (status in ('ok', 'erro'));
  end if;
end $$;

-- A tela de execuções lê "as falhas recentes desta organização" e "as chamadas
-- deste ponto". Sem índice, as duas viram varredura na tabela que mais cresce
-- do sistema.
create index if not exists llm_calls_erros_idx
  on public.llm_calls (organization_id, created_at desc) where status = 'erro';
create index if not exists llm_calls_purpose_idx
  on public.llm_calls (organization_id, purpose, created_at desc);

comment on column public.llm_calls.status is
  'Migration 0128: ''ok'' | ''erro''. Antes desta migration a tabela só registrava sucesso — o INSERT '
  'vinha depois da chamada, sem try, então toda falha de provedor sumia sem rastro. Era a causa direta '
  'de "o agente não responde e não aparece erro em lugar nenhum".';

comment on column public.llm_calls.error_message is
  'Migration 0128: texto do provedor, truncado. NUNCA prompt, resposta ou chave — mensagem de erro de '
  'provedor às vezes ecoa o corpo da requisição, e conteúdo de mensagem é PII neste repo.';

comment on column public.llm_calls.origem_da_escolha is
  'Migration 0128: quem decidiu usar este modelo — ''binding'' (painel de provedores), '
  '''agente_publicado'', ''variavel_de_ambiente'' ou ''padrao_da_organizacao''. É o que transforma o log '
  'de "o que aconteceu" em "por que aconteceu".';

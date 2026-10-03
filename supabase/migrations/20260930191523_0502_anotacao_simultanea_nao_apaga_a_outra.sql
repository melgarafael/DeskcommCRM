-- manifest: **Campos diferentes gravados ao mesmo tempo no mesmo negócio não se apagam mais (corrida no servidor; a ficha que reenvia o valor velho segue à parte).** `updateLeadHandler` mesclava `custom_fields` no aplicativo (`{ ...prev, ...novo }`, com `prev` de uma leitura anterior): duas escritas simultâneas com chaves diferentes perdiam uma, sem erro e sem log. Vale para o `PATCH /api/v1/leads/[id]` e para a ferramenta MCP `crm_update_lead`; a rota `move` já estava protegida pelo `expected_updated_at`. A mescla passa para `fn_lead_anotar_campos`, que faz `custom_fields || $1` numa única instrução `UPDATE`: em READ COMMITTED quem chega depois espera o commit e recalcula sobre a linha vigente. `security definer`, `EXECUTE` só para `service_role`. Idempotente, sem dado a corrigir.
-- 0502 — duas anotações ao mesmo tempo não apagam uma à outra.
--
-- ─── O defeito, medido na main de 2026-09-30 ────────────────────────────────
--
-- `updateLeadHandler` (`app/api/v1/leads/_handler.ts`) mesclava `custom_fields`
-- NO APLICATIVO:
--
--     const prev = existing.custom_fields …        -- lido no SELECT, lá em cima
--     patch.custom_fields = { ...prev, ...input.custom_fields };
--
-- `existing` vem de uma leitura anterior. Duas escritas simultâneas com chaves
-- DIFERENTES perdem uma: a segunda leu `prev` antes de a primeira gravar, e
-- sobrescreve a coluna inteira com a versão velha mais a chave dela. Ninguém
-- recebe erro. O dado some.
--
-- ─── Quem chega a esse ponto ────────────────────────────────────────────────
--
-- O handler serve dois caminhos: o `PATCH /api/v1/leads/[id]` (o formulário do
-- dossiê) e a ferramenta MCP `crm_update_lead` (o assistente, integrações). Os
-- dois podem escrever a mesma ficha ao mesmo tempo — quem atende salvando na
-- tela enquanto o assistente anota. A rota `move` NÃO tem este defeito: o
-- `update` dela exige `updated_at = expected_updated_at`, então uma leitura velha
-- vira conflito, não dado perdido. O `PATCH` do lead não tem esse controle.
--
-- ⚠️ Limite: o formulário do dossiê (`LeadFieldsForm`, `CRMSidePanel`) envia o
-- objeto `custom_fields` INTEIRO que carregou ao abrir. Uma chave que a ficha
-- não tinha ao abrir agora sobrevive à gravação dela; uma chave que a ficha já
-- mostrava ainda volta ao valor velho do formulário. Esta função fecha a
-- corrida no servidor, não o payload velho do cliente.
--
-- ─── Por que uma função, e não uma linha no handler ─────────────────────────
--
-- O handler grava pelo PostgREST (`supabase.update()`), e ele não sabe dizer
-- `custom_fields = coalesce(custom_fields,'{}'::jsonb) || $1::jsonb` — só sabe
-- mandar um VALOR pronto, que é justamente o valor calculado a partir de uma
-- leitura velha. A conta tem de acontecer DENTRO do `UPDATE`.
--
-- ─── Por que isso basta (medido, não suposto) ──────────────────────────────
--
-- Numa ÚNICA instrução `update … set custom_fields = custom_fields || $1`, em
-- READ COMMITTED (o padrão do PostgREST), a segunda transação ESPERA o commit
-- da primeira e RECALCULA a expressão sobre a versão nova da linha. Por isso ela
-- soma sobre o que a primeira gravou, em vez de sobre o que leu antes.
--
-- Um `select … for update` antes NÃO é necessário: o invariante
-- `anotacao-simultanea-nao-apaga-a-outra.test.ts` passou igual com e sem ele.
-- O que quebra o conserto é o oposto — ler o valor para uma variável e gravar
-- depois, que reintroduz a leitura velha (o invariante fica vermelho assim).
-- Em REPEATABLE READ ou SERIALIZABLE a segunda transação recebe 40001 em vez de
-- sobrescrever: falha alta, nunca dado perdido em silêncio.
--
-- ─── O que esta função NÃO faz ──────────────────────────────────────────────
--
-- Ela não decide QUEM pode escrever o quê: papel e organização são de quem
-- chama (o handler resolve a organização de fonte confiável, nunca do body).
-- Aqui só se garante que nenhuma escrita apague a outra por acidente de relógio.
-- Misturar as duas coisas faria uma função que ninguém consegue auditar.
--
-- `||` em `jsonb` é raso de propósito: campo de funil é chave→valor, sem
-- aninhamento. Merge profundo mudaria o significado de "apagar um campo".
--
-- Idempotente: `create or replace` e revoke/grant reaplicáveis. Sem constraint
-- nem dado a corrigir.

create or replace function public.fn_lead_anotar_campos(
  p_org uuid, p_lead uuid, p_campos jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  resultado jsonb;
begin
  if p_campos is null or jsonb_typeof(p_campos) <> 'object' then
    raise exception 'campos_precisa_ser_objeto' using errcode = '22023';
  end if;

  -- UMA instrução, sem leitura prévia: a conta `custom_fields || p_campos` é
  -- refeita sobre a linha vigente quando há escrita concorrente (ver cabeçalho).
  -- Sem linha (lead inexistente OU de outra organização) nada é gravado e
  -- `resultado` fica nulo. Silêncio de propósito: quem pede um lead que não é da
  -- organização dele não recebe confirmação de que ele existe em outro lugar.
  update public.crm_leads
     set custom_fields = coalesce(custom_fields, '{}'::jsonb) || p_campos
   where organization_id = p_org and id = p_lead
   returning custom_fields into resultado;

  return resultado;
end $fn$;

-- Função nova em `public` NASCE EXPOSTA, e são DUAS origens de EXECUTE: o
-- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS` do corpo do baseline (que
-- alcança toda função criada depois dele, para anon, authenticated E
-- service_role) e o grant a PUBLIC que o Postgres dá a qualquer função ao
-- criá-la. Revogar só de `public, anon` deixaria esta função — que ESCREVE —
-- executável por qualquer usuário logado de QUALQUER organização.
-- `tests/invariants/hardening-definer-varredura.test.ts` cobra as duas origens.
revoke all on function public.fn_lead_anotar_campos(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_lead_anotar_campos(uuid, uuid, jsonb) to service_role;

comment on function public.fn_lead_anotar_campos(uuid, uuid, jsonb) is
  'Mescla campos personalizados no lead DENTRO do banco, numa única instrução atômica. '
  'Existe porque o merge no aplicativo perdia escrita concorrente em silêncio. '
  'Não decide papel nem organização — isso é de quem chama.';

notify pgrst, 'reload schema';

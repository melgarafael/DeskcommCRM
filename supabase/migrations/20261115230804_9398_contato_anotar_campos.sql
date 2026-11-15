-- manifest: **Campos personalizados do CONTATO mesclados dentro do banco (`fn_contato_anotar_campos`).** A ferramenta `crm_save_lead_diagnosis` grava o diagnóstico da empresa em `contacts.custom_fields` sem ler e regravar o objeto inteiro: numa única instrução `update`, `(custom_fields - p_remover) || p_campos`, filtrada por `organization_id` e recusando ficha anonimizada (`is_anonymized`), em que gravar depois devolveria dado apagado pela LGPD. Mesmo molde da `fn_lead_anotar_campos` (0502), agora no contato: os `link_*`, os campos da organização e as observações da equipe não passam pelo aplicativo, e uma escrita concorrente espera e soma em vez de ser desfeita. `security definer`, EXECUTE revogado de `public`, `anon` e `authenticated` e concedido só a `service_role`. Sem tabela, coluna, policy ou dado a corrigir. Idempotente (`create or replace`, revoke/grant reaplicáveis); espelho idêntico no apêndice do `baseline.sql`. Prova em `tests/invariants/contato-anotar-campos.test.ts`.

-- CAMPOS PERSONALIZADOS DO CONTATO MESCLADOS NO BANCO
--
-- Por que uma função, e não o PATCH da ficha: o `PATCH /api/v1/contacts/:id`
-- SUBSTITUI `custom_fields` inteiro, e o PostgREST não sabe dizer
-- `custom_fields || x` — só manda um valor pronto, calculado a partir de uma
-- leitura anterior. Entre a leitura e a gravação, o que outro caminho gravou
-- (o "Completar fichas" da campanha, a aba Diagnóstico, uma proposta aprovada)
-- era desfeito em silêncio.
--
-- Em READ COMMITTED (o padrão do PostgREST), a segunda transação ESPERA o
-- commit da primeira e RECALCULA a expressão sobre a versão nova da linha. O que
-- quebraria o conserto é ler para uma variável e gravar depois.
--
-- `p_remover` sai ANTES do `||`, na mesma instrução: é por ele que a autoria
-- antiga (`diag_por`, `diag_em`) deixa de assinar um texto que ela não escreveu.
--
-- A recusa da ficha anonimizada mora no `where`: se a anonimização confirma
-- primeiro, a releitura da linha já não casa e nada é gravado (retorno nulo).
-- O gatilho `trg_contacts_anonimizado_limpa_custom_fields` zera os campos no
-- momento da anonimização; esta função não pode trazê-los de volta depois.
--
-- O que ela NÃO faz: decidir papel, contato do turno ou ficha pessoal. Isso é
-- de quem chama (o handler resolve a organização de fonte confiável, nunca do
-- corpo). Contato de OUTRA organização devolve nulo, sem confirmar que existe.

create or replace function public.fn_contato_anotar_campos(
  p_org uuid, p_contato uuid, p_campos jsonb, p_remover text[]
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  resultado jsonb;
begin
  if p_campos is null or jsonb_typeof(p_campos) <> 'object' then
    raise exception 'campos_precisa_ser_objeto' using errcode = '22023';
  end if;

  update public.contacts
     set custom_fields = (coalesce(custom_fields, '{}'::jsonb) - coalesce(p_remover, '{}'::text[])) || p_campos
   where organization_id = p_org
     and id = p_contato
     and is_anonymized is not true
   returning custom_fields into resultado;

  return resultado;
end $fn$;

-- Função nova em `public` nasce exposta pelas DUAS origens (o grant a PUBLIC do
-- Postgres e o `alter default privileges` do baseline): revogar das três.
revoke all on function public.fn_contato_anotar_campos(uuid, uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.fn_contato_anotar_campos(uuid, uuid, jsonb, text[]) to service_role;

comment on function public.fn_contato_anotar_campos(uuid, uuid, jsonb, text[]) is
  'Mescla campos personalizados no CONTATO dentro do banco, numa única instrução atômica, '
  'e recusa ficha anonimizada. Não decide papel nem organização — isso é de quem chama.';

notify pgrst, 'reload schema';

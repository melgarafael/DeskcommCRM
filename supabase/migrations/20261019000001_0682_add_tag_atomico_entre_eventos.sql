-- manifest: **O `add_tag` junta as etiquetas DENTRO do UPDATE, e dois eventos concorrentes sobre o mesmo negócio ou contato não se apagam mais (issue #2888).** O PR #2864 fez a ação reler a linha antes do merge, o que resolveu as duas regras do MESMO evento — mas o `event_log` é drenado por DOIS consumidores em paralelo (o laço do agent-worker e o cron `app/api/v1/cron/event-log-drain`) e o claim é exclusivo por LINHA, não por negócio: dois eventos DISTINTOS do mesmo negócio (um em cada dreno) leem a mesma lista, cada um grava a lista lida mais as suas etiquetas, e a última gravação apaga a etiqueta da outra. Funções `fn_lead_adicionar_etiquetas` e `fn_contato_adicionar_etiquetas` fazem a junção `tags = tags || array(select unnest(p) except select unnest(tags))` na PRÓPRIA instrução `UPDATE`, com `RETURNING tags`: em READ COMMITTED quem chega depois espera o commit da linha e recalcula sobre a linha vigente. A ação passa a anunciar o que o `RETURNING` devolveu, em vez de calcular a lista antes. `security definer`, `EXECUTE` só para `service_role`, `revoke` de `public`, `anon` e `authenticated`.

-- ---- o add_tag junta no UPDATE, sob a trava da linha (migration 0682, #2888) ----
-- DUAS execuções ao mesmo tempo sobre o mesmo negócio ou contato não se apagam.
--
-- ─── O defeito, e por que o #2864 não o fechou ──────────────────────────────
--
-- O #2864 fez `lib/automation/actions/add-tag.ts` reler `tags` do banco antes de
-- mesclar, consertando o caso que a correção pública jmpo/DeskcommCRM#89
-- descreve: o motor monta o contexto UMA vez por evento, e TODAS as regras
-- daquele evento recebem a mesma foto; a segunda regra gravava `foto + as suas`
-- e apagava o que a primeira tinha acabado de gravar.
--
-- O que continua aberto é o caso de DOIS EVENTOS DIFERENTES processados ao mesmo
-- tempo sobre a mesma linha. Eles não são hipótese: o `event_log` tem dois
-- consumidores concorrentes — o laço do worker (`workers/agent-worker/main.ts`,
-- as linhas do `drainEventLog`) e o cron `app/api/v1/cron/event-log-drain`. O
-- claim é exclusivo por LINHA, então dois eventos distintos do mesmo negócio
-- podem rodar um em cada dreno, em paralelo:
--
--     dreno A: select tags --> (janela) --> update lista_lida + etiqueta_A
--     dreno B:       select tags --> update lista_lida + etiqueta_B
--
-- As duas leem a MESMA lista. A última gravação sobrescreve a coluna inteira com
-- a foto que ela leu mais as suas etiquetas, e a etiqueta da outra some — sem
-- erro, sem log, sem ninguém saber. É a mesma classe da 0502 (`custom_fields`) e
-- da 0673 (excluir uma etiqueta preserva as outras), aqui no eixo do `add_tag`.
--
-- ─── Por que a correção é na GRAVAÇÃO, e não no dreno ──────────────────────
--
-- Fechar a janela por fora exigiria serializar por NEGÓCIO a execução das
-- automações — um claim por negócio no lugar do claim por linha. Isso muda o
-- motor, o claim e os dois drenos, e o preço apareceria em toda instalação: a
-- fila de eventos do mesmo negócio passa a ser sequencial, e a ação paga por uma
-- corrida que é dela. A linha já é o alvo da escrita; é ali que a corrida se
-- resolve, como nas 0502/0673.
--
-- ─── Por que uma FUNÇÃO, e não uma linha no handler ────────────────────────
--
-- A ação grava pelo PostgREST (`supabase.update()`), e ele não sabe dizer
-- `tags = tags || array(...)`: só sabe mandar um VALOR pronto — que é justamente
-- o valor calculado a partir de uma leitura anterior. O que o app não expressa,
-- o `UPDATE` expressa. `fn_lead_anotar_campos` (0502) é o precedente exato.
--
-- ─── Por que isso basta (medido, não suposto) ──────────────────────────────
--
-- Numa ÚNICA instrução `update ... set tags = coalesce(tags,'{}'::text[]) ||
-- array(select unnest(p_etiquetas) except select unnest(coalesce(tags,'{}'::text[])))`,
-- em READ COMMITTED (o padrão do PostgREST), a segunda transação ESPERA o commit
-- da primeira, RECALCULA a expressão sobre a versão nova da linha e soma sobre o
-- que a primeira gravou. Em REPEATABLE READ ou SERIALIZABLE a segunda recebe
-- 40001 em vez de sobrescrever: falha alta, nunca dado perdido em silêncio.
-- O gate é `tests/invariants/add-tag-concorrente-nao-apaga.test.ts`, com duas
-- transações abertas sobre a mesma linha.
--
-- `EXCEPT` já é operação de conjunto: ele devolve cada etiqueta nova uma vez só,
-- então repetir na lista pedida não duplica nada. A ordem das etiquetas que já
-- estavam é preservada (a junção acrescenta no fim).
--
-- ─── A leitura sob a TRAVA, e o que ela é (e não é) ────────────────────────
--
-- O `select ... for update` que abre cada função NÃO é o que conserta a corrida
-- — quem conserta é a junção dentro do `UPDATE`, e é por isso que a sabotagem
-- que reintroduz o merge em memória fica vermelha. Ele existe para uma segunda
-- pergunta, que o `RETURNING tags` sozinho não responde: QUAIS etiquetas esta
-- chamada de fato acrescentou.
--
-- Isso importa: a ação só anuncia `lead.tag_added`/`contact.tag_added` quando
-- alguma etiqueta entrou de verdade (é o que evita evento à toa e laço de
-- automação), e o `event.added_tags` é condição de regra. Calcular o delta fora
-- do UPDATE sobre uma leitura que não segura a linha reintroduziria exatamente a
-- foto velha — agora só no relatório, mas mentindo para a automação.
--
-- Com a trava, a pré-imagem é a vigente e `p_etiquetas menos v_antes` é exato. Se
-- ela fosse removida, a JUNÇÃO continuaria correta: o que se perderia é a
-- exatidão do delta (ele passaria a superestimar). As duas metades são
-- independentes de propósito.
--
-- ─── O que estas funções NÃO fazem ─────────────────────────────────────────
--
-- Não decidem QUEM pode escrever: papel e organização são de quem chama (a ação
-- roda no dreno, com o client de serviço, e `p_org` vem do evento, nunca do
-- corpo de uma requisição). O filtro por `organization_id` é defesa em
-- profundidade e o que faz uma linha de OUTRA organização devolver nulo em vez
-- de ser tocada. Não emitem evento — quem emite é a ação, que é dona do
-- `caused_by_rule` (o anti-laco).
--
-- Não normalizam o vocabulário: `btrim`, dedupe por chave canônica e cor são de
-- `fn_tags_normalizar`/`fn_vocabulario_de_tags_operar` (0336/0673), que operam em
-- lote. Aqui o contrato é o de sempre da `add_tag`: a lista pedida entra como
-- veio, e o que muda é só ONDE a junção acontece.
--
-- Idempotente: `create or replace`, `revoke`/`grant` reaplicáveis. Sem tabela,
-- coluna, policy ou dado a corrigir.

create or replace function public.fn_lead_adicionar_etiquetas(
  p_org uuid,
  p_lead uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_antes       text[];
  v_adicionadas text[];
  v_depois      text[];
begin
  if p_etiquetas is null or cardinality(p_etiquetas) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  -- A PRÉ-IMAGEM SOB A TRAVA (ver cabeçalho: é o delta, não a junção).
  -- Sem linha — lead inexistente OU de outra organização — nada é lido e a
  -- função devolve nulo. Silêncio de propósito: quem pede um negócio que não é
  -- da organização dele não recebe confirmação de que ele existe em outro lugar.
  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.crm_leads
   where organization_id = p_org and id = p_lead
     for update;
  if not found then
    return null;
  end if;

  v_adicionadas := array(select unnest(p_etiquetas) except select unnest(v_antes));

  -- Nada a acrescentar: não há escrita e não há o que anunciar. A ação traduz
  -- `adicionadas` vazio em `success` sem evento, como sempre fez.
  if cardinality(v_adicionadas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'adicionadas', '[]'::jsonb);
  end if;

  -- UMA instrução: a conta é refeita sobre a linha vigente quando há escrita
  -- concorrente (ver cabeçalho). O `RETURNING tags` é o que a ação anuncia.
  update public.crm_leads
     set tags = coalesce(tags, '{}'::text[])
                || array(select unnest(p_etiquetas) except select unnest(coalesce(tags, '{}'::text[]))),
         updated_at = now()
   where organization_id = p_org and id = p_lead
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'adicionadas', to_jsonb(v_adicionadas)
  );
end
$fn$;

create or replace function public.fn_contato_adicionar_etiquetas(
  p_org uuid,
  p_contato uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_antes       text[];
  v_adicionadas text[];
  v_depois      text[];
begin
  if p_etiquetas is null or cardinality(p_etiquetas) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  -- Irmã da de cima, na tabela do CONTATO: o destino `contato` da #2498 escreve
  -- aqui, e ali a corrida é a MESMA — dois eventos distintos do mesmo contato em
  -- drenos diferentes. Corpo idêntico trocando a tabela e o nome do parâmetro.
  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.contacts
   where organization_id = p_org and id = p_contato
     for update;
  if not found then
    return null;
  end if;

  v_adicionadas := array(select unnest(p_etiquetas) except select unnest(v_antes));

  if cardinality(v_adicionadas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'adicionadas', '[]'::jsonb);
  end if;

  update public.contacts
     set tags = coalesce(tags, '{}'::text[])
                || array(select unnest(p_etiquetas) except select unnest(coalesce(tags, '{}'::text[]))),
         updated_at = now()
   where organization_id = p_org and id = p_contato
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'adicionadas', to_jsonb(v_adicionadas)
  );
end
$fn$;

-- Função nova em `public` NASCE EXPOSTA, e são DUAS origens de EXECUTE: o
-- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS` do corpo do baseline (que
-- alcança toda função criada depois dele, para anon, authenticated E
-- service_role) e o grant a PUBLIC que o Postgres dá a qualquer função ao
-- criá-la. Revogar só de `public, anon` deixaria estas funções — que ESCREVEM —
-- executáveis por qualquer usuário logado de QUALQUER organização.
-- `tests/invariants/hardening-definer-varredura.test.ts` cobra as duas origens.
revoke all on function public.fn_lead_adicionar_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.fn_contato_adicionar_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.fn_lead_adicionar_etiquetas(uuid, uuid, text[]) to service_role;
grant execute on function public.fn_contato_adicionar_etiquetas(uuid, uuid, text[]) to service_role;

comment on function public.fn_lead_adicionar_etiquetas(uuid, uuid, text[]) is
  'Acrescenta etiquetas ao negócio DENTRO do UPDATE, numa única instrução atômica, e devolve as etiquetas gravadas. '
  'Existe porque o merge no aplicativo perdia a etiqueta de outro evento concorrente do mesmo negócio. '
  'Não decide papel nem organização — isso é de quem chama.';
comment on function public.fn_contato_adicionar_etiquetas(uuid, uuid, text[]) is
  'Acrescenta etiquetas ao contato DENTRO do UPDATE, numa única instrução atômica, e devolve as etiquetas gravadas. '
  'Mesma corrida e mesmo desenho de fn_lead_adicionar_etiquetas, no destino `contato` da add_tag.';

notify pgrst, 'reload schema';

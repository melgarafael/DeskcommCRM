-- manifest: A Resposta rápida ganha ORDEM própria, definida por arrastar e soltar na tela `/app/templates` e respeitada pelo slash-menu do Inbox: coluna `ordem` (numeric, como `position_in_stage`) em `message_templates` (issue #3244). A resposta NOVA nasce no topo — um passo acima da primeira, gravado pela criação —, como a mais recente já nascia, e o backfill preserva a ordem que a tela mostrava (`updated_at` desc); ele só roda quando a coluna nasce, então reaplicar o `baseline.sql` num banco já ordenado não reescreve a escolha de ninguém.
--
-- 0729: `message_templates.ordem` é a POSIÇÃO da resposta rápida na lista da organização.
--
-- ─── O defeito que isto resolve ─────────────────────────────────────────────
-- A listagem (`app/api/v1/message-templates/route.ts`) devolvia as respostas
-- rápidas por `updated_at desc`: a ordem era a de mais recentemente EDITADO, não
-- a que o operador escolhe. Editar o corpo de uma resposta a empurrava para o
-- topo da lista e para o topo do slash-menu do Inbox, e não havia como voltar —
-- a tela não oferecia reordenar. A ordem passa a ser DADO da linha, e é ela que
-- a tela arrasta e o Inbox herda.
--
-- ─── Por que fracionária (numeric) e não inteiro ────────────────────────────
-- A posição nasce do VIZINHO (`depois_de`), não de um número mandado pela tela:
-- soltar entre duas respostas grava a média entre elas (`lib/templates/ordem.ts`)
-- e só a linha arrastada é escrita — as vizinhas ficam intactas, e um PATCH de
-- conteúdo não reescreve a lista. Inteiro exigiria renumerar a lista inteira a
-- cada arrasto (e renumerar linha que o papel não pode escrever pela RLS).
-- `numeric`, como `position_in_stage`: a coluna guarda exatamente o número que a
-- rota gravou. A média é calculada em JS (double); quando ela não cabe mais
-- estritamente entre as duas vizinhas, ou quando elas empatam, a rota renumera a
-- lista visível com passos de `1000`.
--
-- ─── Idempotente ────────────────────────────────────────────────────────────
-- O `do` abaixo não é enfeite: `install.sh` (banco novo) e `update.sh` (banco
-- existente) aplicam ESTE arquivo, e o apêndice do `baseline.sql` repete o mesmo
-- texto. O `if not exists` da coluna seria suficiente para não quebrar, mas não
-- para o BACKFILL: sem o guarda da coluna, cada `update.sh` renumeraria a lista
-- pela data de edição e apagaria a ordem que o operador escolheu. O guarda mede
-- o nascimento da coluna, não o conteúdo — por isso a escolha do usuário
-- sobrevive a toda atualização. Em banco novo a tabela está vazia e o backfill
-- não escreve linha nenhuma.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'message_templates'
      and column_name = 'ordem'
  ) then
    alter table public.message_templates
      add column ordem numeric not null default 0;

    with numeradas as (
      select
        id,
        row_number() over (
          partition by organization_id
          order by updated_at desc, id
        )::numeric * 1000 as posicao
      from public.message_templates
    )
    update public.message_templates as m
      set ordem = numeradas.posicao
      from numeradas
      where numeradas.id = m.id;
  end if;
end $$;

-- O índice da LEITURA: a listagem filtra por organização e ordena por `ordem`
-- (é o caminho de toda abertura do Inbox e da tela). O `idx_message_templates_org`
-- da 0060 fica: ele serve a RLS e as contagens por organização.
create index if not exists idx_message_templates_org_ordem
  on public.message_templates (organization_id, ordem);

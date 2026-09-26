-- O vocabulário de `contact_field_proposals.campo` ganha `birthdate` (issue #1546).
--
-- A 0123 nasceu fechado em três vocábulos de propósito: o que entra nessa fila
-- vira escrita em `contacts`, e campo livre deixaria a IA propor qualquer
-- coluna. O fechamento continua — o que muda é o tamanho do conjunto, não o
-- princípio.
--
-- Por que este alargamento, e não outro caminho: `lib/contacts/proposta-de-dado.ts`
-- já nasce com `CAMPOS_PROPONIVEIS` igual a esta lista, e sem a mudança aqui a
-- proposta de nascimento passaria pela validação do código e MORRERIA em 23514
-- na confirmação — o modo de falha silencioso, com a IA ouvindo "não consegui
-- registrar" para um dado que o cliente repete com naturalidade. As duas
-- listas são a mesma fronteira vista de lados diferentes e têm de andar juntas.
--
-- A coluna é a MESMA `contacts.birthdate` que já existe desde cedo: nada de
-- coluna nova, nada de backfill. Idempotente pelo par `drop if exists` + `add`
-- (o mesmo molde da 0385 e da 0405) — o nome existe desde a 0123, e um `add`
-- sem o drop à frente reprovaria em 42710 no clone que segue a cadeia.
--
-- Dado tocado: nenhum. As linhas existentes da fila já cabem no conjunto novo,
-- e nenhuma proposta antiga usa o vocábulo.
--
-- No `baseline.sql` (o que o kit self-host aplica), o vocábulo entrou por
-- EDIÇÃO NO LUGAR do bloco ÚNICO da constraint — não por um bloco novo no
-- apêndice: `tests/unit/baseline-constraint-reconstruida.test.ts` reprova
-- `add constraint` repetido no mesmo arquivo, porque o bloco antigo falharia no
-- `update.sh` de um clone cuja fila já tenha uma proposta de nascimento, e a
-- tabela ficaria SEM constraint entre o `drop` e o `add` que funciona.
alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_campo_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_campo_check check (
    campo = any (array['email', 'name', 'phone_number', 'birthdate']::text[])
  );

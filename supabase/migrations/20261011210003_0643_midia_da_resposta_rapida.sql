-- manifest: A Resposta rápida ganha imagem carregada pelo próprio operador: coluna `midias` (jsonb) em `message_templates`, com os arquivos no bucket privado `whatsapp-media` (issue #2526).
-- 0643: `message_templates.midias` guarda a DESCRIÇÃO das imagens do template.
--
-- ─── Por que uma coluna, e por que jsonb ───────────────────────────────────
--
-- A ligação é com UM template e não tem histórico próprio: a lista é reescrita
-- por inteiro quando o operador remove ou substitui uma imagem — o mesmo
-- desenho de `catalog_products.fotos` (text[] desde a 0390), que é a referência
-- técnica citada na issue. Uma tabela de filhas acrescentaria RLS, cascade e
-- uma contagem de linha para uma relação que só se lê inteira.
--
-- jsonb (e não text[]) porque a linha guarda os TRÊS campos que o envio
-- precisa: `storage_path`, `media_mime` e `media_size_bytes` — os mesmos
-- `media_*` de `messages` que o dispatcher de mídia já consome. Guardar só o
-- caminho empurraria a leitura do mime e do tamanho para o momento do envio,
-- e o mime seria adivinhado da extensão.
--
-- ─── Idempotente ───────────────────────────────────────────────────────────
--
-- `add column if not exists` + `drop constraint if exists` antes de cada
-- `add constraint`: instalação nova e `update.sh` de banco existente correm o
-- mesmo arquivo. Nada é backfillado — o default `[]` cobre as linhas atuais e
-- um template SÓ de texto continua saindo byte a byte como antes (#2526, o
-- caso que não pode mudar de comportamento).
alter table message_templates
  add column if not exists midias jsonb not null default '[]';

-- O teto do formulário (MAXIMO_DE_MIDIAS = 5) também no banco: a rota e o
-- schema Zod já recusam mais, e este CHECK é a régua de quem grava direto pelo
-- PostgREST. O `case when` existe porque `jsonb_array_length` de um não-array
-- ERRA, e um erro em CHECK não vira violação de constraint — vira falha obscura
-- no insert de quem mandou json torto.
alter table message_templates drop constraint if exists message_templates_midias_maxima;
alter table message_templates
  add constraint message_templates_midias_maxima
  check (case when jsonb_typeof(midias) = 'array' then jsonb_array_length(midias) <= 5 else false end);

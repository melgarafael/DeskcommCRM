-- manifest: **`companies.normalized_cnpj` aceita o CNPJ alfanumérico da Receita (#3495).** A coluna nasceu com `check (normalized_cnpj ~ '^\d{14}$')` e o cadastro gravava só dígito; com a régua de código passando a aceitar as 12 posições alfanuméricas + 2 dígitos verificadores, o documento legítimo morria no INSERT com 500 em vez de mensagem. A constraint `companies_normalized_cnpj_digits` é trocada pela forma `'^[0-9A-Z]{14}$'` (mesmas 14 posições, letra só em MAIÚSCULA — `normalizeCnpj` sobe a caixa antes de gravar). O índice único por organização `companies_org_normalized_cnpj_uidx` fica como está: a unicidade não muda, muda só o alfabeto aceito. Idempotente (`drop constraint if exists` antes do `add`); espelho no `baseline.sql` editado no lugar e repetido no fim do arquivo; `MANIFEST.md` é histórico e não recebe linha.

-- 9056 — o CNPJ alfanumérico da Receita cabe em `companies.normalized_cnpj` (#3495).
--
-- ─── O defeito ─────────────────────────────────────────────────────────────
--
-- A Receita passou a emitir CNPJ alfanumérico: 12 posições de dígito OU letra
-- maiúscula (`[0-9A-Z]`) e 2 dígitos verificadores, conferidos pelo mesmo
-- mod-11 de sempre (`código do caractere − 48`, então `A` vale 17). O exemplo
-- canônico da Nota Técnica é `12.ABC.345/01DE-35`.
--
-- O código já sabia ler esse formato desde a cobrança (`isValidCnpj`, em
-- `lib/cobranca/documento.ts`), mas `normalizeCnpj` — a régua do cadastro de
-- empresa — filtrava `\D` antes de conferir: as letras sumiam, o tamanho dava
-- 9, e a empresa era RECUSADA como "CNPJ inválido". Mesmo que a régua de código
-- fosse corrigida sozinha, o INSERT continuaria morrendo aqui: a constraint
-- desta migration exigia 14 DÍGITOS.
--
-- ─── O que muda ────────────────────────────────────────────────────────────
--
--   1. `companies_normalized_cnpj_digits` passa de `'^\d{14}$'` para
--      `'^[0-9A-Z]{14}$'`. O `[0-9A-Z]` é literalmente a classe que o
--      `isValidCnpj` usa (`/^[0-9A-Z]{12}\d{2}$/`): 12 posições alfanuméricas e
--      os 2 verificadores numéricos. O CHECK continua sendo uma cerca grossa de
--      formato — quem confere o dígito é o código, como já era.
--   2. A letra é guardada em MAIÚSCULA: `[A-Z]` no CHECK é o que impede a mesma
--      empresa entrar duas vezes como `12abc...` e `12ABC...` — o índice único
--      por organização compara texto, e `a` ≠ `A` para ele. `normalizeCnpj`
--      sobe a caixa antes de gravar; linhas antigas são todas numéricas, então
--      não há backfill.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- `companies_org_normalized_cnpj_uidx` (único por organização, `where
-- normalized_cnpj is not null`) fica como está: a unicidade do documento não
-- muda, muda só o alfabeto que a coluna aceita. `companies.cnpj` (a forma com
-- máscara) também continua livre em texto.

alter table public.companies
  drop constraint if exists companies_normalized_cnpj_digits;

alter table public.companies
  add constraint companies_normalized_cnpj_digits
  check (normalized_cnpj is null or normalized_cnpj ~ '^[0-9A-Z]{14}$');

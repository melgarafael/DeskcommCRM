-- 0247 · O catálogo aprende o papel `versao` e o nome pode ser composto.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- A tela de Integração de dados não reconhecia uma coluna `versao` (nem
-- `versão`, `submodelo`): `detectarPapelColuna` devolvia `null`, o checkbox
-- ficava desabilitado e a coluna não podia ser marcada. O papel `versao` entra
-- na lista de papéis e ganha aliases.
--
-- Com isso, o nome exibido/casável da moto passa a ser a JUNÇÃO das colunas de
-- prioridade 1 (ex.: `nome` + `versao` = "Biz 125 Flex"), e `criteriosDeSimilaridade`
-- passa a considerar o critério textual `nome` junto de cilindrada/preço.
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não acionado.

alter table public.catalog_mappings
  add column if not exists col_versao text;

comment on column public.catalog_mappings.col_versao is
  'Coluna de versão/submodelo, se existir. Marque `nome` e `versao` como prioridade 1 para o nome exibido ser a junção dos dois (ex.: "Biz 125" + "Flex").';

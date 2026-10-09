# Evidência de segurança e isolamento — agenda no turno

PR #2523. Medição em 07/10/2026, com dados fictícios, PostgreSQL descartável e
canal de captura. Nenhuma leitura ou escrita de dados de produção, nenhum envio
pelo WhatsApp e nenhuma credencial consta destes artefatos.

## Revisão do diff

`report.md`, `results.sarif` e `artifacts/agenda-diff-review.md` são saídas do
Codex Security 0.1.32, scan `11ab7568-2e7a-48f5-9bd5-9aae81927444`, concluído
em `2026-10-07T20:38:55Z`. Os seis arquivos de produção do intervalo imutável
`17a67d3da..1adb4ee92` foram revisados; não foi identificada vulnerabilidade
reportável nesse diff. Isso não certifica o repositório inteiro.

Os commits posteriores do mantenedor (`6c4250817` e `b62f68fa1`) estão fora desse
scan imutável. Foram lidos separadamente: a releitura mantém os filtros de
organização e contato; o aviso de falha conserva uma causa truncada; a conversão
da fita em texto não acrescenta ferramentas nem escritores ao fechamento.

## Regressões repetidas após os ajustes do mantenedor

Código medido: `b62f68fa11dee48cc051856e4ea6b8b39bba7ee5`.

```text
pnpm test:db \
  tests/invariants/agenda-atual-no-fechamento.test.ts \
  tests/invariants/o-agente-nao-le-compromisso-de-outra-organizacao.test.ts \
  tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts

Test Files  3 passed (3)
Tests       8 passed (8)
Start at    17:41:07
Duration    11.90s
==> test:db verde
==> teardown: removendo container deskcomm-test-db-11839
```

O executor instalou e reaplicou o baseline com `ON_ERROR_STOP=1`, conferindo
as 164 regras de isolamento antes dos testes. Os casos verificam que:

- O agente não recebe compromissos de outra organização.
- A ferramenta não lista compromissos de outro contato durante a conversa.
- Uma alteração de 17h30 para 17h durante o turno chega ao registro persistido;
  a ação de envio anterior continua visível e nenhuma parte de ferramenta é
  entregue à chamada de fechamento sem ferramentas.

Os cinco arquivos unitários de agenda e o novo arquivo de fechamento do
mantenedor passaram no mesmo código: **6 arquivos, 78 testes**, em 7,66 segundos.
Esse recorte cobre fusos, preservação do instante, falha de leitura, reserva
cancelada, listagem/escrita e a fita de ferramentas convertida em texto.

`pnpm typecheck` passou com `NODE_OPTIONS=--max-old-space-size=8192`; a primeira
tentativa atingiu o limite padrão de memória do processo. O código não mudou
entre essas tentativas. O verificador dos cinco arquivos de código/testes
alterados pelo mantenedor terminou com zero erros e dois avisos existentes.

## Limites

- Os invariantes usam modelo determinístico; os cinco ensaios com modelo real
  registrados em `docs/testing/agenda-horarios-e-fechamento.md` pertencem à
  contribuição anterior aos dois ajustes do mantenedor.
- Não houve teste de transporte WhatsApp, autenticação completa da instalação
  ou implantação em produção.
- A suíte completa local teve falhas de ambiente e limites de tempo documentados;
  estes 78 testes e oito invariantes verdes não significam suíte inteira verde.

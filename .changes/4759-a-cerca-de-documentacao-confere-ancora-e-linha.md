---
impacto: nada_mudou
secao: corrigido
titulo: A cerca de documentação passa a conferir a âncora e a linha, não só o arquivo
---

A cerca `tests/unit/documentacao-aponta-para-o-que-existe.test.ts` olhava só o
arquivo citado: o padrão de link relativo cortava tudo a partir do `#` e
`caminho/arquivo.ext:NNN` nem casava com o padrão de path em crase. Medido nesta
árvore: 450 links relativos, 75 com âncora e 34 referências de linha — nenhuma das
34 era conferida. Por isso ela passou verde com o `README.md` apontando para
`#5-quando-o-compute-nano-...` numa seção 6 e com o runbook de custo citando
`:163` para um cron que mora na `:175`, os defeitos dos #4759 e #4760.

Agora o link relativo com `#slug` para um `.md` do repo exige que o cabeçalho de
slug equivalente exista (régua do GitHub: minúsculas, pontuação e emoji fora,
cada espaço por hífen), e a referência `arquivo:linha` exige arquivo existente,
linha existente e — quando a frase nomeia um símbolo que aparece uma única vez no
arquivo — que a linha citada seja a dele. Violação antiga fica declarada com
motivo em `ANCORAS_QUE_ENVELHECERAM` / `LINHAS_QUE_ENVELHECERAM`; violação nova
reprova.

Nada muda para quem usa o produto: é gate de documentação. Contribuição de
@webtecnica (#4759, #4760).

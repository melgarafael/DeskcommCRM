---
name: deskcomm-curso
description: 'Atualizar o curso visual.'
metadata:
  fonte-de-verdade: curso/publicacao.json
  procedimento: docs/runbooks/atualizar-curso.md
---

# Manter o curso atual

Invocação: `/deskcomm-curso` no Claude Code; `$deskcomm-curso` no Codex, seguido do pedido.

Esta skill é a automação com IA: você lê as mudanças, corrige o material e executa os
capturadores existentes. O planejador só faz a triagem determinística. Não inicie um daemon,
agendamento pago nem outra CLI de IA para substituir o trabalho desta sessão.

Localize o clone do **melgarafael/DeskcommCRM** e leia `CLAUDE.md` e
[`docs/runbooks/atualizar-curso.md`](../../../docs/runbooks/atualizar-curso.md) no clone antes de
operar a bancada. A publicação do site vive em outro repositório,
**melgarafael/deskcomm-site**. Quando instalada globalmente, resolva esses caminhos a partir
do clone; o diretório global da skill não contém o curso.

## Decisões essenciais

- A base é `commit_fonte` de `curso/publicacao.json`, conferida contra o curso que foi
  efetivamente publicado. Não use “última tag”, data de imagem ou `package.json` como substituto.
  O recibo exige também `site_commit` com SHA completo. Se falta esse vínculo ou uma publicação
  anterior comprovada, faça rodada completa e diga por quê.
- Compare commits exatos. Alteração local ainda não faz parte de `head`; registre o estado da
  fonte que o app usa e recalcule o plano depois de correções e merges.
- O plano oferece **candidatos**, não cobertura exata. Leia o diff inteiro e os arquivos ligados
  às telas. Mudança compartilhada/API sem mapa pede revisão global. Reduza um recorte só com
  justificativa pública sustentada pelo código e pela interface observada.
- Aula em espanhol exige a interface real em espanhol, seletores que existem nessa interface e
  geometria medida de novo. Nunca reutilize a foto ou as caixas de PT como se fossem ES.
- Não abra nem mostre `.env*`, chaves ou `curso/saida/contas.json`. Os programas podem carregar a
  configuração local gerada. Use somente a bancada descartável, dados fictícios e worker parado;
  não se conecte ao CRM de um cliente para fotografar ou semear.

## Executar a atualização

1. Confira a fonte publicada e o commit a ensinar. Rode:

   ```bash
   pnpm exec tsx curso/planejar-atualizacao.ts --head HEAD --saida curso/saida/plano-atualizacao.json
   ```

   `--idioma pt-BR` e `--idioma es` restringem idiomas; sem eles o plano inclui ambos.
   `--base <ref>` é triagem com **base informada**, nunca prova de publicação, e exige revisão IA.
   Se der `sem-recaptura`, confira que a base corresponde à publicação; não fotografe nem altere
   datas/versões para simular uma atualização. Se houver pendências, resolva o alcance antes de
   capturar só um subconjunto.

2. Revise as aulas candidatas, os roteiros das jornadas e o que o aluno faz na tela. Corrija
   textos, ordem dos passos, seletores e sementes com base no comportamento real. Se aparecer
   recurso novo, atualize o catálogo; não esconda a novidade porque o mapa anterior não a conhece.
   Traduza também título, instruções, busca, dicas, rótulos e o conteúdo correspondente no site.
   ES não pode recorrer silenciosamente ao texto ou às imagens de PT.
   Prepare também as dependências declaradas da história: a consulta de pedidos, por exemplo,
   usa uma fonte fictícia real separada, descrita no runbook. Uma tela de erro ou outra conexão
   não substitui a integração exigida pelo roteiro.

3. Prepare a bancada pelo runbook. Fotografe somente o recorte confirmado, em cada idioma pedido,
   usando `capturar.ts [modulo] [licao]` e `capturar-jornadas.ts [nicho/jornada]` com
   `CURSO_IDIOMA` e `CURSO_SAIDA`. Restaure a semente antes de cada aula que muda o estado.
   Preserve as falhas persistidas: foto antiga existente não conclui uma tentativa nova.

4. Monte o curso, verifique manifestos e arquivos, abra o resultado no browser e percorra leitura,
   simulador e jornadas nos dois idiomas. Confira setas, caixas, cliques, textos, mobile e erros.
   Em falha, corrija a causa, restaure o estado e repita a aula/jornada inteira afetada. Não apague
   a pendência à mão nem mude metadados da foto para conseguir montar.

5. Sincronize o conteúdo canônico e as traduções no `deskcomm-site`. Exporte o conjunto completo
   concluído com `pnpm exec tsx curso/exportar-capturas.ts --idioma es --saida curso/saida/es --site <clone-do-site>`.
   O comando valida IDs, procedência, medidas e JPEGs antes da troca, preserva a geometria e não
   altera o HTML PT. Arquivos alheios, conjunto incompleto ou falhas bloqueiam a exportação.
   Confira o diff dos assets e do manifesto no site e execute os checks que existem lá.
   Use PRs e os checks obrigatórios dos dois repositórios; publicar significa também verificar o
   deploy final pela tela. Só registre a nova publicação depois dessa prova, com SHA da fonte,
   idiomas concluídos, data real e SHA do site. Não avance o registro durante uma rodada parcial
   ou falha. Na entrega, informe links, idiomas, o que foi recapturado/reutilizado e pendências
   concretas; nunca afirme automação, quantidade ou publicação que você não observou.

O runbook detalha os comandos de bancada, o recibo de publicação e a retomada de falhas.
Os cenários de avaliação estão em [`evals/evals.json`](evals/evals.json).

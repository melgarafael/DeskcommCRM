---
impacto: nada_mudou
secao: corrigido
titulo: Toda resposta montada à mão sob /api leva o X-Request-Id da requisição
---

Desde o #3991, `ok()`/`fail()` já devolvem o `X-Request-Id`; as respostas
montadas à mão — arquivo (CSV, vCard, PDF, planilha), imagem, QR, página de
callback de OAuth, `405` de método não permitido, redirecionamento de login e
webhook de entrada — saíam sem ele, e o pedido ficava sem id correlacionável.

Agora essas saídas passam por `comIdDaRequisicao(res, req)`, em
`lib/api/wrappers.ts`: o id é o mesmo da requisição (o que o `proxy.ts` pôs no
cabeçalho e que a rota grava no `audit`/log), e um id que a própria rota já
resolveu para a auditoria é preservado. Corpo, status, `Location`, cookies e
`Content-Disposition` não mudam — só o cabeçalho é acrescentado.

Uma catraca estática varre os `route.ts` sob `app/api/` e reprova a próxima
resposta montada à mão sem carimbo. Duas exceções declaradas, com motivo, no
próprio teste: o pixel de abertura e a página de descadastro das cadências —
rotas públicas consumidas pelo cliente de e-mail, sem registro com `requestId`,
onde o cabeçalho publicaria um id que não existe em log nenhum.

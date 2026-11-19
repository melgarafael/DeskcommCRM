---
impacto: nada_mudou
secao: corrigido
titulo: Sair da lista de conversas cancela a leitura em voo, e o retry do cliente passa a deixar rastro
---

A lista de conversas não repassava ao `fetch` o sinal de cancelamento que o
react-query já mantinha. Sair da tela, trocar de aba ou trocar o filtro
cancelava a CONSULTA, mas não a REQUISIÇÃO: o pedido seguia em voo até o
timeout de 10 s (ou até três tentativas, quando a API estava fora), e a resposta
que chegasse depois era descartada. Agora o sinal chega ao `fetch`, o pedido em
voo é abortado no mesmo instante, e uma resposta que resolva depois do
cancelamento é recusada em vez de aplicada — nada de resposta velha
sobrescrevendo a lista nova. Cancelamento não mostra mais o toast de erro da
lista, porque cancelar não é falha.

O cliente HTTP também passou a registrar cada repetição numa linha estruturada
com o nome estável `request_retried`, com método, rota lógica (sem query string
e sem identificador no caminho), número da tentativa, `X-Request-Id` e o motivo
(status HTTP ou tipo da falha). É o que separa "a API está fora" de "a API está
lenta" sem abrir o código: um 200 direto não gera linha nenhuma, um 503 seguido
de 200 gera uma, com tentativa 2.

Nada muda para quem usa a tela além do cancelamento: o número de tentativas
(três), o timeout (10 s por tentativa), o backoff e a forma do erro que chega à
tela continuam os mesmos. O registro é log, não tabela — não há migration nem
contador em banco.

Contribuição de @webtecnica (#4508).

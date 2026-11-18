# Atendimento, avisos e QR — candidato de integração

Destino: **núcleo**. São correções da operação comum de atendimento, negócios e
conexões, que precisa funcionar sem extensão ativada. Não mudam política de
papel, tolerância de tempo do produto nem schema.

Contribuição original: @webtecnica, PRs #3452, #3438 e #3423. Os quatro commits
originais foram preservados por merges. Base desta integração: main
`18ca52b1429762df60070c4807aacacd0de1f0d7`.

## Prova observada localmente

Os testes existentes focados passaram antes dos ajustes: **7 arquivos, 75 casos**.
Os casos discriminantes acrescentados ficaram inicialmente **14 vermelhos / 27
verdes** antes da correção; o mesmo recorte ficou **41 verdes** após o ajuste.
Ao acrescentar controles do recibo vazio, a prova contra o código original ficou
**16 vermelhos / 26 verdes**, seguido de **42 verdes** no mesmo recorte. A
regressão ampliada final ficou **11 arquivos,
206 casos verdes**, com um worker e sem paralelismo de arquivos. As quatro
cercas selecionadas passaram **62 casos**. ESLint dos 19 arquivos TypeScript
alterados, lint de canais e análise sintática passaram; a última não é typecheck.

- A consulta de responsável com erro recusa a operação. As disputas controladas
  ocorrem entre respostas independentes do banco: os snapshots não compartilham
  referência com o estado persistido. A comparação de responsável e o recibo da
  RPC precisam confirmar a liberação antes dos efeitos de retomada. Permanecem
  os testes de `ai_opt_out`, restauração de `force_human` e isolamento por org.
- A reprodução do aviso antigo usa uma atribuição de um segundo antes do UPDATE.
  Os limites de 1 ms e 1500 ms, dos dois lados, também recusam. Instantes separados
  por 1 µs são distintos; UTC e offset equivalentes são o controle positivo. O SDK
  Realtime instalado conserva `timestamptz` como string, e os gatilhos usam o mesmo
  `now()` da transação. Não foi criada janela de aproximação.
- O pareamento acontece depois da leitura inicial, antes da escrita. A condição
  é avaliada no UPDATE tanto do arquivamento quanto do fallback do webhook. O
  controle conserva o arquivamento do QR que continuou sem número. Sem recibo de
  arquivamento, os avisos não são encerrados por uma remoção que não aconteceu.

Esses testes usam dublês na fronteira do banco e **não provam RLS, locks ou
comportamento do navegador**. Os logs completos desta sessão ficam no relatório
privado de triagem, fora do repositório.

## Prova preparada para o CI, ainda não executada nesta sessão

Specs existentes e já incluídas nas partes do workflow E2E:

- `central-avisos-destino.spec.ts`: botão recusa devolver conversa do colega;
  controle pelo dono devolve; consulta do estado persistido; CAS real da RPC
  retorna SETOF vazio ao receber responsável antigo. Organização própria, com
  visibilidade `all` explícita para distinguir leitura de permissão para liberar.
- `sons-dos-avisos.spec.ts`: atribuição, ganho e perda no primeiro UPDATE da aba;
  assinatura do canal observada, gatilhos e endpoint reais, aviso visível e captura.
  Também exercita a compatibilidade da precisão dos dois transportes do banco.
- `whatsapp-pareamento-por-codigo.spec.ts`: imagem de QR sintética em navegador,
  expiração pelo webhook real, arquivamento e vaga livre no banco, sessão retomada
  pela API do assistente e conexão novamente visível. Conserva a prova existente
  do código de pareamento e da auditoria.

O QR e o transporte do teste são sintéticos: não houve pareamento físico. A
retomada do assistente é chamada pela API; seu clique não foi exercitado pelo
novo caso. A concorrência determinística foi medida em unidade; o novo E2E
confere o contrato real do CAS, sem afirmar uma disputa HTTP simultânea.

Não foram executados build, typecheck completo, Docker, banco local ou VPS.
O candidato permanece em **DRAFT**, aguardando checks e revisão independente.

## Sistema vivo e limites

Entrada/saída: botão do Inbox → regra de retomada → autorização, evento
`ai.handoff_resolved`, continuidade e auditoria; mudança do negócio → gatilho →
eventos → aviso com destino ao funil; webhook de status → arquivamento → contador
do plano e fechamento dos avisos de saúde/pausa. Não foi criada peça isolada nem
configuração sem tela.

Laço de retorno: erro de leitura ou disputa recusa a devolução; o operador recebe
a recusa e pode recarregar. Falha de leitura dos eventos mantém silêncio em vez
de inventar mudança. Falha no descarte preserva a linha para o caminho normal;
fechamento de avisos é posterior ao recibo do arquivamento.

A precondição explícita de responsável foi acrescentada ao caminho HTTP do
botão. Esta integração não redefine a política dos outros chamadores. A leitura
de lease e o UPDATE da sessão não viraram uma transação entre tabelas.

## Complemento da revisão — confirmação pendente no hook

O hook real foi testado com uma Promise pendente na fronteira da consulta. A
primeira prova teve **7 falhas e 2 controles verdes**: mudança de organização,
pessoa, ausência de organização, desmonte e retirada do responsável. A visita
A→B→A precisa de uma geração nova e de memória do contexto atual.

A geração é um objeto com cancelamento no cleanup, como o canal vigente do
Realtime. Uma resposta só entrega se essa geração ainda estiver ativa. A memória
registra também a vigência do responsável: retirar e reatribuir não revalida a
consulta da atribuição anterior. Esse controle adicional teve **1 falha e 9
controles verdes** antes do ajuste de vigência.

O recorte final passou **4 arquivos e 56 casos**, incluindo os **10 casos novos**
e as regressões de atribuição, carimbo e endpoint. Atualização irrelevante com o
mesmo dono é controle positivo. O carimbo e o estado da transação confirmada
continuam sendo os da consulta; não foi criada nova regra para status ou ordem
dos avisos. ESLint dos dois arquivos alterados e diff check passaram. Não houve
browser, banco, build ou typecheck completo neste complemento.

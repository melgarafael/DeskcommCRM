# O pacote do titular no caminho manual

Resgate do PR #3543, de @webtecnica, fonte
`1e33f9bd1539a371cdcb51f775b7847ce6d9cac4`, sobre a main
`b8870b3dc0cceb04954966f3d141a22ae2a0992c`. Destino: núcleo. A entrega de
dados pessoais pertence à operação comum, sem extensões.

## Contrato preservado

O doc 103 A aprovou entregar o arquivo de dados junto do relatório também no
Brasil. A projeção atual já inclui as decisões posteriores do doc 110: o arquivo
tem as mensagens completas também no Brasil, com os recortes de dados da equipe
definidos naquele contrato. O PDF continua sendo o resumo. Esta adaptação não
altera coletor, projeção, worker, dourados, schema, prazo ou política de papéis.

O detalhe do pedido, restrito pelo guard canônico a quem administra, devolve
`signed_pdf_url` e `signed_json_url`. Os arquivos são assinados por 72 horas
quando o pedido está `completed` ou `pending_review`. Os caminhos aceitos são
os emitidos pelo worker para a organização da sessão e o pedido carregado:
`<org>/<pedido>/report.pdf` e `<org>/<pedido>/data.json`. A assinatura com service
role não aceita o caminho de outro pedido ou organização. Um registro legado
sem `json_path` conserva o PDF; não se inventa o arquivo que ele não registra.

Essas duas URLs só alimentam os links de baixar da tela; a prévia usa uma rota
separada. A assinatura pede a opção `download` com os nomes fixos `report.pdf` e
`data.json`, sem alterar as 72 horas. O SDK instalado aceita um nome nessa opção;
a [documentação do Supabase](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl)
documenta o modo de download. O [HTML Standard](https://html.spec.whatwg.org/multipage/links.html#downloading-resources)
prevê `Content-Disposition: attachment` junto do atributo `download` em
situações cross-origin. O header e o clique ainda precisam da prova real abaixo.

Falha retornada ou exceção na assinatura de um arquivo não impede a do outro.
Os logs dessa borda contêm código técnico, artefato e identificador da requisição;
não levam mensagem bruta, caminho, URL assinada ou segredo. Erro de leitura do
pedido recebe a resposta canônica genérica. O filtro de organização e o caráter
não fatal da leitura da trilha permanecem.

## Provas medidas localmente

O teste próprio `lgpd-download-manual-isola-os-arquivos.test.ts` observou nove
falhas antes do reparo, com cinco controles passando. Depois, o conjunto dirigido
de LGPD passou: 34 arquivos e 305 casos, com um worker. Os casos de rota usam
dublês; não comprovam o comportamento do Storage.

O controle adicional de attachment observou três REDs antes da opção: os dois
estados entregáveis e o legado só com PDF; os outros treze casos permaneceram
verdes. O GREEN dirigido da borda e dos testes autorais relacionados passou:
três arquivos e 28 casos, com um worker. Os 305 casos anteriores não são
reaproveitados como prova deste delta.

O teste autoral de paridade executa o worker, a renderização do PDF, a projeção
e o desenho do e-mail reais, mas dubla coleta/banco, Storage e transporte. Não é
prova de entrega real nem de isolamento no provedor. O import do grafo do worker
e do PDF também passou em um processo Node isolado com rede proibida; isso só
prova que o instrumento carrega.

## Prova real preparada para o CI

**Estado: preparada, ainda não executada.** O caso independente acrescentado em
`suspensao-administrativa.spec.ts`, já incluída no workflow existente, usa duas
organizações e três usuários sintéticos próprios. O cenário anterior da spec
permanece intacto.

O filho Node com `tsx` instalado chama `processLgpdExport` real para cada pedido.
A marca de aprovação é fixture explícita, e o titular não tem e-mail. Coletor,
PDF, projeção, PostgREST e Storage devem produzir `pending_review` e os dois
objetos reais. O helper recusa destino de rede externo; não há transporte de
e-mail, modelo ou serviço pago nessa preparação.

Cada filho tem teto de 30 segundos e a preparação tem deadline de 90 segundos,
dentro dos 180 segundos do caso. O runner encerra somente seu próprio processo
com `SIGKILL` e aguarda `close` antes de remover objetos ou fixtures. Os dois
caminhos previsíveis entram na lista de limpeza antes da chamada do worker,
inclusive quando ele falha ou trava. Um controle Node sintético sem rede nem
banco confirmou o término de um filho parado com `SIGSTOP` pelo deadline e a
parada antecipada de outro filho ativo; ambos terminaram sem PID vivo.
Esse controle prova o fim do processo; não mede a conclusão de uma requisição
que o servidor já tivesse recebido antes da parada. No caminho de sucesso, o
worker aguarda os uploads antes de devolver seu resultado.

O caso preparado verifica:

- GET do detalhe e dos dois objetos, MIME, Content-Disposition de attachment,
  JSON parseável e hash do PDF igual ao registrado pelo worker;
- JWT com validade de 72 horas, caminho correspondente ao artefato, token
  adulterado recusado e acesso público sem assinatura negado;
- controle positivo das duas organizações, pedido da outra organização com
  404, viewer com 403 somente no detalhe HTTP e anônimo com 401;
- dois cliques reais, sem `force`, com evento de download do navegador, nomes
  `report.pdf`/`data.json` e bytes iguais aos dos objetos assinados;
- contenção de registro inválido de caminho, legado sem JSON e JSON removido
  do Storage sem perder o PDF disponível.

A contenção usa uma alteração direta da própria fixture: não afirma que exista
uma entrada HTTP que permita escrever `result`. A projeção atual e os dourados
não recebem edição. Aprovação pela tela, SMTP, assinatura PAdES com chave real e
esperar 72 horas até expirar não são medidos por esse caso. Decodificar o JWT
sozinho não conta: a prova exige leitura real e recusa do token adulterado.

A limpeza remove os objetos, organizações e usuários próprios. Não promete
banco sem rastro: a auditoria é retida pela política atual e pode conservar
linhas com `organization_id` nulo por `ON DELETE SET NULL`; o teste não altera
essa retenção nem apaga auditoria.

Captura e recibo técnico serão gravados em `evidence/lgpd-pacote-manual/` somente
após asserções e limpeza concluídas. O recibo não guarda links ou tokens. Ainda
não há imagem nem recibo de execução para citar. O comportamento de download
cross-origin será medido pelos cliques; o atributo HTML `download` não é tomado
como prova de funcionamento do provedor.

## Limite separado: autorização direta no Storage

A policy `tenant_read_lgpd_exports` observada no baseline permite SELECT a uma
membership não revogada da organização da pasta; ela não exige papel admin nem
`accepted_at`. A matriz da spec 01, seção 5, reserva executar `lgpd.data_request`
a admin e platform_admin. Essa diferença requer auditoria de segurança própria.

O 403 da rota não prova uma ACL admin-only no Storage. Esta adaptação não muda a
policy nem transforma sua permissividade em expectativa obrigatória do teste.
Leitura direta real por viewer ainda não foi medida. O link assinado é uma
capacidade temporária para entregar o pacote ao titular, e não uma sessão de
administrador vinculada ao destinatário.

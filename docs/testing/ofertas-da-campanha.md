# Ofertas da campanha — prova preparada

O resgate de #3503 preserva os commits de @paulolimajr77 e a proposta da
[Spec 29](../specs/29-spec-agente-sabe-o-que-a-campanha-vende.md). Este registro
não promove a spec a decisão aceita. A primeira abordagem e o ângulo principal legado permanecem fora do recorte.

## Tela e encadeamento controlado

`tests/e2e/prospeccao-auditoria-do-site.spec.ts` conserva os controles anteriores
e o teto de 120s. Sua seção final prepara recursos exclusivos: agente publicado,
canal, funil/etapas, contato/conversa, campanha pausada e candidato agregador. A
configuração validada contém três ofertas; elas não são copiadas ao prompt livre.
Depois de recarregar, o modal precisa mostrar o complemento literal e a prévia
habilitada. A prévia não é clicada. Novas leituras de configuração exigem ausência
do complemento em site-only e a frase sem “Além do site” nas duas automações sem
site. A ausência vale para a frase nova, não para toda a auditoria legada.

As capturas físicas e os recibos serão escritos em `evidence/prospeccao-ofertas`
depois das assertivas. O recibo separa controles e limpeza; a limpeza encerra e
junta o filho antes de retirar somente os recursos próprios. A organização e o
agente do seed não são substituídos. O acréscimo de até 45s é planejamento, não
duração observada: não demonstra margem na parte 1 nem autoriza outro caso.
Listas, tetos, workers e retries do CI ficam intactos.

O helper `tests/e2e/helpers/ofertas-no-turno.ts` persiste o texto sintético cru,
executa o inbound normal (não o preview), adquire somente seu job e chama a tool
real diretamente sobre a mesma conversa. A tool tem argumentos `{}`; seu contato
vem do contexto confiável. O fornecedor controlado verifica o contexto recebido e
a igualdade do resultado da tool antes de produzir a resposta. Handler, SQL e tools
são reais; modelo e entrega do canal são controlados. Isso mede encadeamento até
o adapter e não resposta de um modelo real, persistência outbound, leitura da
resposta na Inbox ou entrega em aparelho. O recibo mantém `semantica_aprovada=false`.

O novo invariante `prospeccao-ofertas-da-conversa-isoladas.test.ts` prepara A com
três ofertas e B com N8N, positivos próprios, contatos/conversas cruzados e os
controles site-only/sem-site. `pgComoSupabase` executa SQL real, mas usa o papel
postgres: essa prova mede filtros explícitos, não RLS nem transporte PostgREST.
O invariante antigo de isolamento fica intacto.

## Modelo real — NAO_ALCANCAVEL nesta entrega

O par completo da [doutrina](../doctrine/prova-em-par.md) pede também a resposta de
um modelo de verdade. Nenhuma sessão desta casa lê chave de provedor, e a conta da
produção não entra em teste, então esse lado **não foi medido**. O que se prova é o
que o aplicativo manda ao modelo e o que a ferramenta devolve na mesma conversa, não
como um modelo usa essas ofertas ao responder. Quem tiver uma instalação de QA com
modelo próprio repete o caso com o texto acima e compara a resposta com a ferramenta;
se discordarem, o defeito fica registrado aqui.

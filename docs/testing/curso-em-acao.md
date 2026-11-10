# Jornadas do curso — reprodução local

O catálogo contém dez nichos, trinta histórias e quatro cenas por história. As empresas, pessoas e diálogos são fictícios. `curso/receitas-jornadas.json` declara as superfícies e falas de cada cena; `curso/demonstracoes/*.json` contém a narrativa pública. Os IDs das fotos são `demo-<jornada>--historia--<cena>`.

## O que a foto demonstra

**CONFIRMADO pelo pipeline:** cada fotografia abre uma tela real do aplicativo sobre um estado semeado no banco local. A posição do destaque é medida pelo mesmo helper das lições (`curso/capturar.ts` / `curso/geometria.ts`); o curso reutiliza seu renderizador SVG. As fotos não são imagens geradas nem screenshots de HTML que imita o aplicativo.

**Limite:** semear uma consulta, tarefa, negócio ou caso não prova que o motor os criou. Todas as histórias continuam identificadas como roteiro demonstrativo. Notas públicas distinguem reconstituição e prova separada. Respostas encenadas são humanas; somente trechos copiados dos pilotos observados recebem autoria de IA na reconstituição. Nenhuma captura chama um modelo ou transporta mensagem para fora da bancada.

## Preparação e captura

Use a instalação local de teste com baseline aplicado, dono criado e a base de `curso/semear-demonstracao.ts` preparada. Pare os workers antes de semear: mensagens inseridas emitem eventos reais. Mantenha as credenciais no ambiente privado da bancada e `curso/saida/contas.json` fora do Git. Não copie segredos para comandos publicados, receitas ou assets.

O app fotografado pode usar uma versão publicada diferente do checkout do curso. Informe obrigatoriamente a versão realmente executada. A captura recusa a execução antes de semear se `CURSO_VERSAO_FOTOS` estiver ausente, em vez de presumir uma release:

```bash
CURSO_URL=http://127.0.0.1:3460 CURSO_VERSAO_FOTOS=1.89.0 \
  pnpm exec tsx curso/capturar-jornadas.ts clinicas-remarcar-sessao
```

A fonte de pedidos tem um helper próprio, sem credenciais fixas ou alteração de schema do aplicativo:

```bash
CURSO_FONTE_HOST=10.0.2.2 CURSO_FONTE_PORT=5432 \
  pnpm exec tsx curso/preparar-fonte-loja.ts
```

O endereço acima é um exemplo da bancada medida: informe o IPv4 LAN pelo qual o contêiner do app alcança o Postgres local. O helper administra **somente** o Postgres da URL localhost; o host LAN vai para o registro de leitura e passa pela política real do produto. Cria `curso_loja_demo` e um papel somente de leitura com senha aleatória cifrada. Em repetição, exige dono e marcador `curso-jornadas:loja:v1` nos objetos existentes; não adota bancos ou papéis desconhecidos. Faz upsert apenas de CT-4729 e CT-4730, sem apagar a tabela. A bancada previamente preparada por outro script precisa de verificação explícita do responsável antes de receber esse marcador.

O argumento aceita uma jornada exata ou um nicho; sem argumento captura todas. `CURSO_BROWSER_CHANNEL=chrome` seleciona o Chrome instalado se o Chromium do Playwright não estiver disponível. Para inspecionar só um estado sem fotografar:

```bash
pnpm exec tsx curso/semear-jornadas.ts clinicas-remarcar-sessao acao
```

`NEXT_PUBLIC_SUPABASE_URL` e `CURSO_URL` precisam ser origens HTTP de localhost. A guarda recusa hosts remotos, usuário/senha na URL, query, fragmento e caminhos. A semente não usa SSH ou acesso direto a Postgres. O helper antigo mantém a guarda própria de `SUPABASE_DB_URL` ao restaurar a base.

O helper das jornadas reaproveita contas, organização, canal e agente da base. Só limpa entidades do prefixo `deca0000` declarado no catálogo; não apaga pilotos ou volumes. Muda os nomes de organização/canal/agente e etapas do funil para a história fotografada. Retira somente as três respostas rápidas clínicas conhecidas da base; a busca da Inbox filtra o personagem pela interface. Os pilotos usam estado de atendimento automático nas etapas correspondentes, sem ligar worker. A primeira cena remove histórias anteriores; as seguintes evoluem o estado. Casos semeados usam o sufixo “· demonstração”, distinguindo-os de casos originais do piloto ou de controles diretos sem escolher uma linha por posição. Remarcação mantém o mesmo ID de compromisso e usa UPDATE explícito após o primeiro INSERT. A sessão de Rui pertence à Ana, preservando o compromisso de equipe já existente na agenda de Helena. Quando o compromisso do piloto clínico existe, a captura o lê sem modificar ou criar uma segunda reserva. Negócios permanecem abertos; tarefas não equivalem a venda, matrícula ou autorização concluída.

As receitas declaram a ação humana por cena (`acao_humana`) e a situação da tarefa (`tarefa_status`). A cena de decisão mostra a opção escolhida antes do envio; a continuidade reconstitui os eventos correspondentes. Na troca de tamanho, a equipe pede informação, a cliente responde e a demanda passa ao humano sem aprovação automática. Apenas as três conferências narradas como encerradas (documentos jurídicos, cadastro de consórcio e documentos mensais da contabilidade) recebem `done`; as outras tarefas permanecem abertas. Para fotografar a conclusão, o capturador escolhe “Concluída” no filtro da lista e exige a ação “Reabrir a tarefa” na linha.

A agenda usa o `starts_at`, fuso e situação efetivos do compromisso. Lê os dias desenhados na grade, navega pelos botões de período anterior/seguinte e abre a aba correta, inclusive “Passados”. Não usa `?data=`, que a tela não consome. Isso permite voltar à semana histórica de 27/10 após ela ter passado, sem alterar o produto ou a data da prova.

Antes de abrir o contexto da bancada, autenticar ou iniciar o navegador, o capturador salva em `falhas[]` as chaves canônicas de **todas** as cenas selecionadas. Cada chave só sai dessa lista depois de medição, JPEG e registro de metadados concluídos. Falha de contexto, login, seletor ou medição interrompe a execução e mantém pendentes as cenas ainda não concluídas, mesmo com entrada e JPEG de uma rodada anterior. As fotos anteriores permanecem em disco; não comprovam a recaptura. Falhas de captura/revogação das lições e pendências fora do recorte são preservadas. A conta, a sessão autenticada e o texto cru de erros não entram no registro das jornadas nem na saída do CLI. Importar os helpers não lê contas, exige credenciais ou abre conexão.

Ao salvar uma rodada posterior de lições, `curso/capturar.ts` conserva as chaves canônicas pendentes das jornadas. Fotografar uma lição não libera uma jornada: só a recaptura da própria cena faz isso. A contagem de falhas e o código de saída do capturador de lições continuam referentes à sua rodada; o montador verifica também as pendências herdadas antes de publicar.

## Pilotos e alcance da evidência

Em 26/10/2026, a bancada do aplicativo v1.89.0 foi usada para provas separadas do motor nativo com provedor real. O transporte final foi simulado; não se afirma entrega em WhatsApp real.

- **Clínica:** Marina Exemplo / Clínica Bem Viver pediu avaliação postural para 27/10/2026 às 9h30. O motor consultou e marcou; o compromisso persistiu e a chamada direta conferiu os mesmos argumentos auditados. A reconstituição usa essa data histórica, não um horário relativo ao dia da leitura do curso.
- **Loja:** Bia Exemplo / Casa das Trilhas consultou CT-4729. A fonte fictícia real retornou Mochila Horizonte, situação Despachado e RASTREIO-EXEMPLO-4729. A ferramenta direta, com os mesmos argumentos e contexto, devolveu a mesma linha; a consulta de controle ao pedido de outro cliente retornou zero linhas. A conexão da fonte é preparada separadamente pelo helper da fixture, antes do pipeline de fotografia.

- **Infoproduto:** Pati Exemplo relatou erro 403 na aula 3 de Fotografia na Prática, após tentar novo login e outro navegador. O motor abriu o caso; na UI a equipe escolheu `Preciso de info do cliente` e pediu o título completo da aula. O turno nativo de retomada fez a pergunta e o caso persistiu em `awaiting_lead`. A ferramenta direta em uma conversa de controle nova gravou os mesmos campos estruturados e `awaiting_human`. Repetir a abertura na conversa que já tinha caso retornou `case_already_open`: recusa esperada, sem reutilização ou novo aviso à equipe. Não se demonstrou correção de acesso à plataforma externa.

A reconstituição da loja usa o mesmo telefone fictício que a fonte espera. Se o contato do piloto já existir, ele é apenas lido; em bancada fresca, o contato próprio recebe esse telefone. Como o produto permite uma conversa por contato e canal, a reconstituição usa um canal próprio identificado como demonstração, parado e sem envio. Não muda o contato, a conversa ou o canal originais, nem publica outro agente.

Os artefatos brutos ficam fora do repositório e dos assets. A configuração da fonte de pedidos usa o endereço de rede permitido pela política do produto dentro da bancada; não se altera a proteção contra localhost do leitor de dados externos. O limite localhost dos scripts diz respeito ao app e Supabase que recebem seeds, não revoga a política do leitor externo.

Nos exemplos de seguros, contabilidade e assistência técnica, a tela de Dados externos mostra **preparação da conexão**, sem executar um teste contra origem inoperante ou rotular leitura como concluída. A conferência do sistema de origem é atribuída à equipe. A montagem indica as dependências que uma implantação real precisa resolver.

## Verificação e montagem

```bash
pnpm exec vitest run curso/manifesto-jornadas.test.ts curso/receitas-jornadas.test.ts curso/navegar-agenda.test.ts curso/jornada.test.ts curso/licoes.test.ts
CURSO_BASE=/curso/ pnpm exec tsx curso/montar.ts
```

O teste de unidade deriva as fotos esperadas do catálogo versionado: roda em clone fresco sem `curso/saida`. O montador exige o manifesto e a existência física de cada foto referenciada. Os arquivos em `curso/saida/` são saída privada ignorada e não devem ser commitados. A prova visual final precisa percorrer catálogo, cenas e montagem em desktop/celular, conferir imagens decodificadas e erros do navegador; sucesso de unidade não substitui essa prova.

O montador recusa, antes de sobrescrever o HTML, qualquer chave pendente de uma jornada que seria publicada. Um recorte de módulos que omita essa jornada continua utilizável, inclusive quando ela ainda não tem entrada de captura; montar tudo exige recapturá-la. A montagem completa valida todo o catálogo; no recorte, só as jornadas publicadas exigem fotos. Manifestos legados sem `falhas` continuam aceitos. `curso/manifesto-jornadas.test.ts` reproduz o CLI real em árvore temporária, sem contas e com ambiente isolado sem segredos: parte de entradas/arquivos anteriores, provoca falha antes da primeira foto e verifica a pendência persistida, a recusa da montagem seguinte e a preservação do índice anterior. Também exercita o registro individual com operação de fotografia controlada, falha após uma cena concluída, recuperação e preservação das falhas das lições. Os arquivos inertes dessa fixture verificam o contrato do manifesto e de existência; não são prova visual do aplicativo, não usam HTML que o imita e não alteram a saída real.

A rodada de 26/10/2026 produziu 120 fotos dedicadas com 120 hashes distintos e destaques medidos dentro do quadro. A montagem completa preservou as 1097 fotos das lições e incluiu as novas: 61 módulos, 1217 fotos. Após a integração, os quatro arquivos de testes focados passaram (98 casos); a conferência de arquivos físicos e a montagem foram repetidas após a sincronização final.

Na rodada de 26/10/2026, o helper de fonte foi recusado com banco/papel existentes sem marcador. Após conferência explícita de ownership dos recursos criados na própria bancada, foi executado com sucesso. A consulta de ACL confirmou SELECT permitido e INSERT/UPDATE/DELETE/TRUNCATE negados ao papel da fonte.

O circuito de correção é explícito: captura falha → não publica entrada dessa cena → corrige receita/seletor → recaptura a jornada → montador valida os arquivos. Não foram adicionadas rotas, tabelas, integrações ou capacidades ao produto.


## Integração e conferência final de 26/10/2026

O trabalho foi empilhado sobre a branch de infraestrutura do PR #3481, primeiro
em `366b9ef88` e depois em `0d33c2a4a`, que já contém o curso anterior e a proteção
de captura/revogação. A atualização do parent acrescentou somente documentação e
um ajuste da fixture de um teste, sem mudar runtime.
O único conflito foi em `curso/montar.ts`. A resolução preserva a recusa quando
`falhas` aponta para um módulo selecionado, mesmo que o manifesto ainda tenha
fotos antigas, junto da validação das jornadas, existência física das fotos e
filtragem das capturas públicas. Manifestos antigos sem `falhas` continuam aceitos.
A integração não altera runtime, SQL, testes de segurança ou CI da base.

**CONFIRMADO na integração:** a montagem em `/curso/` tem 61 módulos e 1217 fotos.
Os 120 JPEGs novos têm 120 hashes SHA256 distintos e correspondem byte a byte à
saída local. Os 1097 JPEGs anteriores permanecem intactos. O site recebe somente
`index.html` e os 120 JPEGs `demo-*.jpg`; manifesto, contas, sessões e provas brutas
não fazem parte dos assets. Uma execução isolada do montador confirmou a recusa
de falha de captura, falha de revogação, foto física ausente e referência de foto
ausente; confirmou também a filtragem de uma captura não referenciada e o recorte
de desenvolvimento sem histórias com links para módulos omitidos.

**CONFIRMADO na rodada definitiva do navegador Linux:** após recapturar todas as
120 cenas com as esperas de conteúdo, a rodada final percorreu os dez nichos,
30 jornadas e 30 montagens, com as 120 imagens decodificadas e sem erro de
navegador, requisição falha ou imagem inválida. Busca, zoom, tela cheia, teclado,
restauração de scroll, recuperação de hash inválido e celular passaram. Catálogo
e cena no celular não tiveram overflow; o menu fechou corretamente. A prova de
celular usou um contexto de navegador independente para evitar uma falha do
protocolo ao redimensionar imediatamente a janela que estava saindo de tela cheia.
A cópia de link teve sucesso real no Chrome do Mac; no navegador Linux sem permissão de clipboard,
a interface mostrou corretamente a mensagem de falha. A rodada do curso anterior
percorreu os 61 módulos, 259 lições e 1097 imagens, incluindo busca, zoom,
progresso das 259 lições e celular.

A prova temporal da agenda usou relógio de navegador em 10/11/2026, partindo da
semana de 08–14/11. A navegação voltou à semana de 25–31/10 e abriu “Passados”;
a linha de Marina Exemplo mostrou 27/10 às 09h30, sem alterar o compromisso.
A tentativa inicial do helper da prova precisou ser corrigida porque a âncora da
semana vem do servidor e a UI mostra o nome do contato; somente a execução final
bem-sucedida compõe esta evidência.

O site definitivo, sobre a base `7f6667d` com os assets recapturados, passou seus
33 testes, typecheck e build em Linux. O produto com o capturador corrigido passou
typecheck, lint sem erros e build em Linux. A suíte global do produto,
executada separadamente, passou 2698 arquivos e 28903 testes, com duas falhas de
ffmpeg no mesmo arquivo também reproduzidas no controle da main `028b40c11`, além
de um teste de falha esperada e um ignorado. Isso registra um limite do gate,
sem converter a suíte global em verde. Os checks completos e a revisão final
continuam sendo exigidos antes da publicação.


### Correção das esperas de fotografia

A revisão dos JPEGs encontrou cenas de ação da agenda com o drawer ainda em
“Carregando…”. A rodada inicial de navegação e decodificação não havia detectado
essa incompletude visual. O capturador agora exige o título do compromisso, data e
horário no fuso real e sua situação antes de medir. Casos exigem contato, vínculo
da conversa, resumo e painel de decisão; dossiês de negócio exigem o contato
carregado; edição de tarefas exige os valores da tarefa. Na Inbox, a espera fixa
foi substituída pela conversa e mensagem da cena. Skeletons e textos de carregamento
visíveis interrompem a fotografia, mesmo que o helper legado apenas avise.
A auditoria integral das fotos anteriores identificou oito drawers ainda em
carregamento, todos na superfície agenda. As 120 cenas foram recapturadas com as
esperas corrigidas, gerando 120 JPEGs com hashes distintos. A conferência local
confirmou os metadados do manifesto, o HTML idêntico à montagem e os 1097 JPEGs
anteriores preservados. O OCR das 120 fotos terminou com texto não vazio em
todas, nenhuma ocorrência de “Carregando” e nenhum erro de leitura. A navegação
final descrita acima foi repetida contra este lote definitivo.

O pulso “Uma conexão caiu” da barra lateral permanece visível quando o canal
fictício está parado. Ele representa a saúde da conexão e não um carregamento;
a guarda exclui somente esse indicador identificado no link de Conexões, mantendo
as âncoras de skeleton, busy, texto de carregamento e as esperas de conteúdo.
Uma rodada parou ao tentar rolar até uma tarefa de seguros; a inspeção da UI
confirmou a linha correta e a repetição isolada das histórias restantes passou,
sem nova alteração de código.

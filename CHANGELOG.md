# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

Se você roda o DeskcommCRM numa VPS, **leia a seção da versão para a qual está atualizando antes de rodar `bash update.sh`**. Mudanças que exigem ação manual aparecem sob **⚠️ Requer atenção**.

## [Não lançado]

## [1.75.0] — 2026-10-06

### Adicionado

- **Admin › Sistema mostra se as entregas do WhatsApp já chegam assinadas** Ao lado do interruptor **"Exigir assinatura nas entregas do canal"**, em **Admin › Sistema**, a tela passa a dizer se as últimas entregas do WhatsApp chegaram assinadas (sim ou não), com a data da última assinada e da última sem assinatura, olhando os últimos 7 dias. Quando a resposta é sim e o interruptor está desligado, ela sugere: _"Pode ligar: o WhatsApp já assina."_

  O "sim" só aparece quando **nenhuma** entrega chegou sem assinatura desde a primeira assinada: se algum número chegou sem assinatura depois disso, a resposta é não e a tela não sugere ligar. Um número que não entregou nada nesse intervalo não entra na conta — com o WAHA do compose do Deskcomm todas as sessões assinam juntas, mas se você usa mais de um servidor de WhatsApp, confira cada número antes de ligar.

  **O padrão não muda:** o interruptor continua desligado, e nada é ligado sozinho. O conserto do nome da variável do segredo no compose saiu na v1.73.0, e com ele o WAHA do compose deve passar a assinar as entregas (ainda não medido numa VPS atualizada); a tela é justamente o jeito de conferir isso na sua instalação antes de ligar a exigência. Só quem administra a plataforma vê esta informação. Construído sobre o conserto de @paulolimajr77 (#2268).

- **Contato pessoal sai da operação com um toque** Quem usa o mesmo número para vender e para a vida agora pode marcar o contato como pessoal: gerente e dono ligam e desligam a marca no cabeçalho da conversa ou na ficha do contato. Marcar grava quem marcou e quando em auditoria e na linha do tempo, cancela follow-ups e retornos pendentes, tira o contato da campanha com saída própria (sem contar como "pediu para parar"), pula a prospecção e fecha as conversas tirando do atendente. Depois de marcado, o contato some do inbox, da busca, das contagens, do funil, da base da IA e das ferramentas externas (leitura exclui, escrita recusa); nenhum envio sai pelo CRM em nenhum papel, e ligação de pessoal desliga gravada sem a IA atender. A lista de Contatos exclui por padrão e o filtro "Pessoais" mostra com selo. Desmarcar relista tudo com o histórico intacto, sem reativar nada. Atendente não marca nem desmarca.

  Contribuição de @paulolimajr77 (#2391).

- **Pausar todas e Retomar todas — a pausa em lote chega à Central de Conexões** A Central de Conexões ganha os botões **Pausar todas** e **Retomar todas**, com a contagem ao lado: uma só ação leva todos os números da empresa ao estado escolhido, no lugar de um clique por canal durante a janela de manutenção do rodízio. A ação usa exatamente o mesmo caminho da pausa individual — um registro de auditoria por canal, com quem fez —, então nada muda no efeito: pausado continua pausado e o que era recusado continua recusado. Repetir é seguro: canais que já estavam no estado escolhido não são gravados de novo nem enchem o histórico de eventos. Os excluídos ficam de fora da operação, sem virar erro, e se algum número não sair o aviso lista quais canais não saíram — nunca um sucesso pintado no que falhou.

  Contribuição de @webtecnica (#2405).

- **Redes sociais ganham desvinculação de perfil e avisam quando o canal fica órfão** Quem trocou a conta no provedor e viu a faixa de erro eterna agora tem saída pela tela: a aba Redes sociais mostra a seção "Canais sem conta no perfil" com o botão Excluir para as linhas órfãs, em vez de uma faixa que nunca fecha. Também dá para desvincular o perfil do provedor depois de arquivar ou excluir os canais sociais, liberando a troca de perfil sem prender o operador no perfil morto. Reconfigurar a credencial ressincroniza a chave de todos os canais do perfil, inclusive os arquivados. Na aba do provedor parceiro, a validação agora distingue chave que não lista nenhuma conta de conta fora do alcance da chave, e avisa quando o id colado é de perfil em vez de conta.

  Contribuição de @paulolimajr77 (#2417).

### Corrigido

- **A agenda do Google volta a pedir reconexão quando o Google revoga o acesso** Quando o Google recusava a renovação do acesso e mandava uma explicação junto (por exemplo "Token has been expired or revoked."), a conexão seguia aparecendo como conectada e a renovação falhava em silêncio a cada 10 minutos, sem ninguém ser avisado. Agora essa recusa é reconhecida: a agenda passa a mostrar que é preciso reconectar, e depois de reconectar a agenda volta a funcionar como antes. Um app do Google mal configurado na instalação também deixa de ser tentado de novo sem fim: a agenda passa a mostrar que o Google recusou o acesso, com o motivo que ele mandou. Não há nada a configurar. Contribuição de @webtecnica (#2392), a partir da issue #2384 de @marcelovolei15.

- **A audiência da campanha lê até o fim, e a prévia avisa quando bate o teto de 20.000** As três leituras que montam a audiência de uma campanha (contatos do recorte, contatos sem filtro de negócio e o negócio mais novo de cada contato) paginavam por `range` e encerravam na primeira página "curta". Numa instalação com o `max_rows` do PostgREST abaixo de 1.000 isso parava a leitura cedo, e a campanha saía com menos gente do que o filtro pedia — em silêncio; um negócio criado ou movido no meio da leitura também deslocava o `offset`. Agora a paginação é por keyset em (`created_at`, `id`) e só a página vazia encerra. E quando o recorte de negócio bate o teto de 20.000 linhas, a prévia avisa que a lista pode estar incompleta, em vez de cortar calada. Contribuição de @Tong-bit-art (#2406).

- **Campanha com funil de mais de 1.000 negócios prepara a audiência inteira** A consulta que escolhe os contatos pelo negócio (funil, etapa, responsável ou situação) lia no máximo 1.000 linhas: o PostgREST corta toda resposta nesse teto e a consulta não paginava. Uma campanha filtrada por um funil maior preparava uma audiência parcial, em silêncio — sem erro e sem aviso na prévia. A consulta agora pagina em blocos até o teto de 20.000 linhas (o teto que já existia, e que antes nunca era alcançado por causa do corte). Nenhuma ação é necessária. Contribuição de @Tong-bit-art (#2403).

- **Campanha com filtro de funil grande volta a preparar (a URL não estoura mais)** Na preparação de uma campanha, o filtro de funil (ou de etapa, responsável ou situação) punha todos os contatos do recorte numa única URL; acima de ~200 contatos o gateway devolvia `414 URI too long` e a preparação inteira caía. A consulta agora é fatiada em lotes que cabem na URL, com a ordem e o corte feitos uma única vez no fim (a ordem e o corte são os mesmos; com limite acima de 1.000 a campanha agora respeita o limite escolhido, antes cortado em 1.000 pelo servidor), a lista de excluídos saiu da URL (é aplicada antes do corte) e os incluídos à mão também vão em lotes. Nenhuma ação é necessária. Contribuição de @Tong-bit-art (#2401).

- **A conferência de promessa do agente sai de dentro do envio e deixa de prender o atendimento numa atualização de estrutura do banco** Antes de cada mensagem do agente sair, uma consulta à IA confere se o texto promete algo que a empresa não oferece ("faço de graça", "entrego amanhã"). Essa consulta rodava com a vez do número já reservada e com uma transação do banco aberta. Isso tinha dois custos. O primeiro era o travamento: enquanto a IA respondia, o registro dessa chamada era gravado por outra conexão, e uma atualização de estrutura do banco que chegasse nesse instante fechava um ciclo de esperas que o banco não consegue desfazer sozinho. O envio esperava a IA, o registro esperava a atualização e a atualização esperava o envio. Medido em produção numa VPS: o atendente automático inteiro ficou parado por 8 minutos e 47 segundos, e o CRM respondeu com erro por cerca de 10 minutos, até alguém interromper a atualização à mão. O segundo custo era a fila: qualquer outra mensagem do mesmo WhatsApp esperava a IA responder. Agora a conferência acontece antes de o envio reservar a vez do número, ao mesmo tempo que a pausa de "digitando…", e o cliente espera a mais longa das duas, e não a soma. As regras de envio não mudam: o intervalo entre mensagens, a janela de horário e a ordem por número seguem como antes. Quando o agente reescreve uma mensagem e tenta de novo com o mesmo texto, a conferência é reaproveitada e não é paga outra vez. O registro do próprio envio (a mensagem, o rastro da conferência e o controle de envios) ainda é gravado com a vez do número reservada, e esse resto do mesmo risco segue em análise em #2426. Até lá, o `update.sh` continua pausando o atendente automático antes de atualizar o banco, o que evita o ciclo numa atualização normal. Não é preciso fazer nada na instalação. Construído sobre o #2363 de @AlecsanderAbreu, que mediu em produção o travamento em ciclo, encontrou a causa e é coautor do conserto (#2121).

- **A consulta de CNPJ volta a funcionar — a BrasilAPI recusava o cabeçalho padrão do Node** Em **Empresas**, o botão "Consultar CNPJ" respondia sempre _"Não foi possível consultar o CNPJ"_, com a dica de que seria um bloqueio temporário e que valia tentar mais tarde. Não era: quando o código não define o cabeçalho `User-Agent`, o Node manda `User-Agent: node` sozinho, e a borda que serve a BrasilAPI recusa esse valor. A consulta nunca funcionou em instalação nenhuma — não era o seu IP, nem limite de uso, nem indisponibilidade do serviço.

  Medido contra o mesmo CNPJ, na mesma rodada: **recusa** (403 ou 429, conforme a medição) com `User-Agent: node`, sem o cabeçalho ou com ele vazio; **200** com o valor neutro que a consulta passa a mandar.

  O conserto alcança os três caminhos que falam com a BrasilAPI: a consulta do cadastro de empresa, o enriquecimento automático de uma empresa já criada e a importação em lote. Quem recebia o erro pode repetir a consulta — o formulário volta a ser preenchido com razão social, nome fantasia, telefone e endereço completo. Se a BrasilAPI recusar uma consulta mesmo assim, a dica na tela deixa de prometer que é temporário e só diz o código e o que fazer.

  O valor enviado é neutro e não leva o nome da marca: o cabeçalho sai para um terceiro, e uma instalação de marca própria não deve entregar o nome de quem a revende à BrasilAPI.

  Contribuição de @LeonardoMarcelo (#2407).

- **Excluir um canal social pela Central de Conexões agora apaga a assinatura de webhook no provedor** Quem excluía um canal de Instagram ou Facebook pela Central de Conexões (em vez da aba Redes sociais) deixava a assinatura de webhook viva no Zernio: como a assinatura é por chave e não por conta, o provedor continuava entregando eventos numa URL que virou 404, sem erro do nosso lado — e se o perfil fosse desvinculado depois, essa assinatura ficava inalcançável. Agora a exclusão apaga a assinatura antes de arquivar ou excluir a linha (pelo id gravado, ou reconciliada pela URL quando o id faltar) e registra o desfecho na auditoria; se o provedor estiver fora do ar, a exclusão segue em best-effort e a falha fica registrada. Nenhuma ação é necessária. Contribuição de @paulolimajr77 (#2424, fecha #2419).

- **Os feriados brasileiros do prazo de LGPD passam a ser calculados, sem fim em 2030** O calendário de feriados brasileiros usado para contar o prazo de um pedido de titular era uma lista à mão só de 2026 a 2030 — fixos e móveis. A partir de 2031 o prazo seria contado sem feriado nenhum, sem erro e sem aviso. A Páscoa e os móveis que dependem dela (Carnaval, Sexta-feira Santa e Corpo de Deus) agora são calculados para qualquer ano, com o MESMO cálculo que Portugal usa; a cobertura vai até 2100 e um teste reprova se ela não alcançar o ano atual + 2. As datas que já existiam de 2026 a 2030 continuam exatamente as mesmas (o 20 de novembro, que faltava, entra em item próprio desta versão). Contribuição de @Tong-bit-art (#2420).

- **Os feriados portugueses do prazo do RGPD passam a ser calculados, sem fim em 2030** O calendário de feriados de Portugal usado para contar o prazo de um pedido de titular era uma lista à mão de 2026 a 2030: depois disso o prazo passaria a ser contado sem os feriados, em silêncio. A Páscoa e os feriados que dependem dela (Sexta-feira Santa e Corpo de Deus) agora são calculados para qualquer ano, a cobertura vai até 2100 e um teste reprova se o calendário não alcançar o ano atual + 2. O conjunto é o mesmo de antes — Carnaval continua fora, por ser facultativo. Contribuição de @Tong-bit-art (#2410, refs #2346).

- **A recusa do Google na renovação diz o status HTTP, e a recusa sem motivo vira conexão quebrada** Quando a renovação do token de uma agenda do Google falhava, a frase gravada dizia "sem resposta" mesmo quando o Google tinha respondido — quem lê procurava problema de rede para um acesso revogado. Agora a frase nomeia o status (`HTTP 400 (invalid_grant: ...)`), e a recusa que o Google respondeu com erro (não-2xx) sem motivo reconhecido marca a conexão como quebrada (`error`), em vez de ficar saudável repetindo para sempre. Queda de rede continua transitória, sem mexer na conexão — tanto a que acontece antes da resposta quanto a que corta o corpo no meio da leitura de uma resposta 200. Uma resposta 200 sem `access_token` também não conta como recusa e não mexe na conexão. Contribuição de @Tong-bit-art (#2400).

- **A conversa aberta no inbox que está fora da aba atual passa a se atualizar sozinha** Uma conversa aberta que não aparece na aba atual do inbox (fechada, ou de outro filtro) não recebia as mudanças que chegavam de fora, como uma mensagem nova, e podia ficar mostrando o estado antigo até um F5. Agora ela se atualiza sozinha. De quebra, os vários avisos de mudança que uma única mensagem gera viram uma só atualização da lista, em vez de várias que se cancelavam: menos carga no servidor. Não há nada a configurar.

- **A lista do inbox não volta ao esqueleto no meio da carga da Fila, nem some quando uma recarga falha** Quem abria a caixa de entrada via a lista de conversas aparecer, sumir e voltar como esqueletos: quando a leitura do atendimento automático respondia, a chave da busca da Fila mudava, a resposta que já tinha chegado era descartada e uma segunda requisição saía ~2 s depois — de 1 a 3 s de tela vazia a cada carga do inbox, medido no trace do #2360. Um refetch que falhava com a lista na tela também a apagava e trocava a tela cheia por "Erro ao carregar conversas". Agora, nessa troca (a mesma Fila, com a mesma busca e os mesmos filtros, só com a resposta do automático), a lista anterior fica visível até a nova chegar; uma recarga que falha deixa a lista onde está e o aviso de erro aparece sem destruir a tela; e a conversa aberta deixa de piscar junto. Trocar de aba ou de busca continua mostrando o esqueleto enquanto a lista nova carrega, para que nenhuma linha da aba anterior apareça como se fosse da nova. Nenhuma ação é necessária. Contribuição de @webtecnica (#2414).

- **O 20 de novembro passa a contar como feriado no prazo de LGPD do Brasil** O prazo para atender um pedido de titular no Brasil (7 dias úteis para entregar os dados, 15 para anonimizar) não descontava o 20 de novembro, Dia Nacional de Zumbi e da Consciência Negra, feriado nacional desde 2024 pela Lei 14.759/2023. Quando a data caía num dia de semana no meio do prazo, o vencimento saía um dia antes do que a lei permite. Agora o 20/11 entra no calendário a partir de 2024 (não antes): o prazo de um pedido que atravessa a data passa a vencer um dia depois — em 2026 o 20/11 é sexta. Pedidos que não atravessam a data não mudam, e o operador não precisa fazer nada. Construído sobre o cálculo de feriados de @Tong-bit-art (#2420).

- **A máscara de PII de Portugal cobre as formas reais, e o scrub não desfigura número internacional** A máscara do perfil de Portugal só via o NIF em nove dígitos colados e o código postal com hífen: NIF com prefixo `PT` ou separado (`123 456 789`), IBAN (`PT50 …`) e o telefone `+351` passavam na ingestão para o RAG. Agora a máscara cobre essas formas — com o telefone ANTES do NIF, para não comer o miolo do número, e com o NIF deixando o CPF separado para o padrão brasileiro. E no scrub da telemetria (que o Jev usa) o número internacional deixa de sair como `+[CPF]8` e o NIF/telemóvel em três blocos deixa de passar; o CPF separado continua saindo inteiro, como antes.

  O telefone brasileiro (+55) sai exatamente como antes.

  Contribuição de @Tong-bit-art (#2416).

- **A IA confere o par provedor e modelo antes de chamar, e um Claude não vai mais para a OpenAI** Antes de cada chamada de IA (atendimento, agente, mídia, base de conhecimento e classificação), o sistema confere se o modelo é do provedor que vai receber o pedido. Um par trocado, como um modelo Claude enviado para a OpenAI, é recusado antes de sair, com o motivo no log, em vez de virar um erro do provedor no meio da fila. A classificação de clima de uma empresa que usa OpenAI, Google ou DeepSeek passa a usar o modelo da própria empresa; sem par próprio que funcione, segue com o modelo padrão de antes. Agentes e respostas automáticas continuam respondendo como antes, sem nada a configurar. Contribuição de @webtecnica (#2385), a partir da issue #2377 de @Fabricio-Point-Machine.

- **Marcar um contato como pessoal tira do RAG os trechos já ingeridos** Marcar um contato como pessoal já impedia que as conversas dele entrassem em ingestões futuras, mas os trechos que já estavam no acervo continuavam alcançáveis pelo agente como conhecimento. Agora a marcação também remove esses trechos, e a auditoria registra quantos saíram. Desmarcar não reingere: a conversa volta à vista e só volta ao acervo quando alguém a marcar de novo como útil para o RAG. Contribuição de @Tong-bit-art (#2396).

- **O token com "gerente" e "administrador" marcados passa a valer como administrador** Em **Configurações › API Tokens**, quem marcava as duas caixas, "Tratar o token como gerente" e "Tratar o token como administrador", podia receber um token que valia só como gerente. O papel saía do primeiro `role:` da lista de escopos, e a tela grava os escopos na ordem em que as caixas são clicadas. Quem clicava em gerente antes de administrador, a ordem natural de cima para baixo, ficava com um token de gerente: nas portas que exigem administrador, como editar, testar e publicar o agente de IA por token (`config:write`), a chamada voltava `403 forbidden_role` com _"Role 'manager' insufficient (required: 'admin')"_, mesmo com a caixa de administrador marcada. Quem clicava na ordem inversa já recebia um token de administrador.

  Agora vale o maior papel marcado, em qualquer ordem. Token sem papel continua valendo como atendente (`agent`), como antes, e um token marcado só como leitor (`role:viewer`) continua leitor: o conserto não sobe o papel de ninguém além do que a própria tela concedeu.

  Um token que já existe com as duas caixas marcadas **pode** passar a agir como administrador depois da atualização: só muda o que teve a caixa de gerente marcada antes da de administrador, e a ordem aparece na lista de permissões do token na tela. Era isso que a caixa de administrador prometia. Se não era essa a intenção, revogue o token e crie outro só com "gerente". Tokens sem a caixa de administrador não mudam.

  Contribuição de @valterhjr (#2423, refs #2422).

- **Desconectar uma rede social apaga a assinatura de webhook que ficou órfã no provedor** Conectar uma rede social cria a assinatura no provedor e grava o id dela no canal só no fim; quando essa gravação falhava, o canal ficava `FAILED` com a assinatura viva lá fora e sem nenhuma referência a ela aqui. Desconectar então arquivava o canal e rotacionava o token do webhook, e a assinatura seguia mandando evento para uma URL que acabou de virar 404 — para sempre, sem erro na tela: o operador via a conta desconectada e o provedor reenviando. Agora, sem o id gravado, a assinatura é encontrada pela URL do próprio canal (o mesmo casamento que a conexão já faz, para não duplicar) e apagada antes do arquivamento. Quem tem o id gravado continua exatamente pelo caminho de antes, e uma falha do provedor segura a desconexão com a linha intacta para poder ser tentada de novo. Contribuição de @webtecnica (#2412, fecha #2364).

## [1.74.0] — 2026-10-06

### Adicionado

- **Automações ganham o passo opcional "a IA decide", que escolhe uma entre as opções montadas na regra (por enquanto só pela API)** O passo `ai_decide` recebe uma instrução e de 2 a 6 opções, cada uma com uma ação comum (etiqueta, tarefa, mover o negócio, responsável, mensagem, chamar endereço externo). A IA devolve só o nome de uma opção e o sistema executa a ação pelo caminho de sempre; resposta fora da lista, vazia ou ilegível não executa nada, e o motivo aparece na aba Atividade.

  É opcional por regra: quem não monta o passo não muda nada nem gasta nada. **Gasta IA**: cada execução faz ao menos uma chamada ao modelo (duas, se a opção for responder pela IA), entra no custo das automações e respeita o teto mensal da empresa; a regra só salva se declarar o gasto (`custo_de_token: true`). Ainda **não tem tela**. Ao provedor de IA vão a mensagem, os dados do negócio e as etiquetas; e-mail, telefone, nome do contato, título do negócio, identificadores internos e o CPF do cadastro não saem, mas o texto da mensagem e os campos personalizados do negócio vão como estão. Nada muda na configuração.

  Contribuição de @webtecnica (#2228, refs #1970).

- **A mensagem da campanha pode usar campos personalizados do negócio e do contato** O texto da campanha passa a aceitar `{{lead.campo}}`, que vem do negócio mais recente do contato, e `{{contato.campo}}`, que vem do cadastro do contato (o caminho da automação, `{{lead.custom_fields.campo}}`, também funciona). Campo vazio, ausente ou contato sem negócio não manda texto pela metade: a pessoa sai da lista como "Falta um dado que a mensagem usa", e isso aparece na contagem antes de enviar. Não é preciso fazer nada na instalação. Contribuição de @webtecnica (#2357), a partir da issue #2311 de @aleflores35.

- **Canais ganham o botão pausar: desativado nunca entra na inbox** Cada número conectado passa a ter Pausar/Retomar na Central de Conexões (WhatsApp por QR, API oficial e redes sociais). Canal pausado continua listado, mas as mensagens dele não aparecem na inbox e não acordam a IA. E nada sai por ele: nem resposta da IA, follow-up, automação ou envio manual (o envio é recusado), nem o aviso de caso à equipe, se for ele a conexão escolhida para os avisos. A entrega continua gravada e reaparece ao retomar, sem reimportar nada. Quem ativou a notificação no celular ainda recebe a de nova mensagem de canal pausado. Nada muda para quem nunca pausar nada. Contribuição de @paulolimajr77 (#2318).

- **Conexão de banco externo: escolha a coluna que identifica o cliente nas conversas** A conexão com um banco de dados externo (em **Dados externos**) ganhou o campo
  **Cliente nas conversas**: você escolhe se o cliente é identificado pelo telefone ou pelo
  e-mail e qual coluna das suas tabelas guarda esse dado. Com a coluna escolhida, durante uma
  conversa de atendimento o agente lê só as linhas em que essa coluna é igual ao telefone ou ao
  e-mail de quem está falando. A lista de conexões mostra um aviso enquanto a coluna não estiver
  escolhida. Fora das conversas (equipe, integrações, API), a consulta segue como antes.

- **Um token novo com a permissão de configurar o agente edita, testa, publica e pausa o agente de IA sem a tela** Integrações (n8n, scripts, Claude Code) passam a poder ler e editar o cadastro e o rascunho do agente de IA, rodar o teste, publicar uma versão e pausar, desligar ou arquivar o agente por token de API, sem abrir o navegador. Isso exige criar um token NOVO em Configurações › API Tokens marcando a permissão nova de configurar o agente (`config:write`, e `config:read` para leitura) junto com "Tratar o token como administrador". Para listar as versões do agente e criar um rascunho novo, o token também precisa de "Agentes de IA podem LER/AGIR no CRM (MCP)"; sem elas, `config:write` só edita, testa e publica um rascunho cujo id a integração já conhece. Os tokens que já existem não mudam: mesmo os de administrador com permissão de agir no CRM continuam recebendo recusa nessas ações. Para quem não criar o token novo, nada muda: publicar, pausar e testar seguem pela tela. O que for feito por token fica na auditoria com o token identificado. Não é preciso fazer nada na instalação. Contribuição de @webtecnica (#2194), a partir da issue #2052 de @spoliagency.

- **O Jev pode escolher o agente sozinho, com a sua IA de sempre de reserva** Quem administra agora pode deixar o Jev escolher o agente sem consultar a IA de sempre em cada mensagem: ela só é chamada quando o Jev falha, não acha a intenção ou fica em dúvida. O modo só liga onde a empresa tem a IA de sempre configurada; sem ela, vale a comparação de hoje, e o cartão diz por quê. O editor do roteador ajusta de zero a 16 mensagens anteriores para a IA de sempre (o Jev continua recebendo só a mensagem atual), com oito por padrão em roteadores novos. IA › Execuções › Roteamento mostra custos, tempos, casos e revisão humana. A atualização não exige ação na VPS. Contribuição de @vitorlacerdadigital (#2061).

- **Conectar a assinatura do ChatGPT (login do Codex) pela própria tela, com a chave da organização como reserva** Em **Administração › Recursos opcionais** (`/admin/sistema`) há um interruptor novo, **Login do Codex por assinatura**, desligado por padrão, que só quem administra a instalação liga. Ligado, cada empresa conecta a própria conta no painel de **Credenciais** (quem revende escolhe se conecta a conta dele ou deixa o cliente conectar a sua): abre o link do Codex, entra com a conta da assinatura e cola o endereço em que o navegador parou (`localhost:1455`; a página não abrir é esperado). O par de tokens é guardado cifrado, como as chaves de IA, e renovado sozinho antes de vencer; se a assinatura falhar, a chamada cai na chave de API da própria empresa. A tela avisa que o `client_id` e o `redirect_uri` são do Codex e não são contrato público da OpenAI. Com o interruptor desligado, nada aparece para as empresas; nada a fazer para quem não quiser usar.

  Contribuição de @webtecnica (#1672, refs #1639).

- **Bloqueio opcional de afirmação clínica para negócios de saúde** Em Segurança, na configuração do agente, há uma nova proteção: "Não fazer afirmação clínica". Ligada, ela impede que o assistente envie mensagens que digam o que a pessoa tem (diagnóstico), indiquem remédio, pomada ou dose, garantam resultado ou digam que uma lesão é câncer. O assistente recebe a orientação de reescrever oferecendo consulta; se insistir, a mensagem continua barrada e um caso é aberto para a equipe (se o agente tiver casos ligados). Não consulta modelo nem tem custo, reconhece frases em português e espanhol, e vem desligada: só faz sentido em clínica e consultório, porque em outros negócios poderia barrar frases normais. Contribuição de @hampikamayuq (#2321, a proteção) e de @Tong-bit-art (#2323, o espanhol e a instrução negada "não pode passar creme").

- **Portugal passa a aparecer no seletor de país, com a citação do RGPD revisada por IA** Em Configurações › Empresa, o seletor de país passa a oferecer Portugal ao lado do Brasil. Escolhido Portugal, o contato usa o NIF (com o dígito de controlo da Autoridade Tributária), o exemplo de telefone é `+351`, o prazo do pedido de titular conta os feriados portugueses, e o documento de acesso cita `RGPD art. 15.º (Regulamento (UE) 2016/679)` com o rótulo "Direito exercido". O e-mail ao titular sai em português de Portugal, e nem ele nem o alarme ao encarregado citam a LGPD.

  **A revisão da citação foi feita por IA, por delegação do dono do produto (doc 88), em 2026-10-05. Não é parecer jurídico e não houve advogado em Portugal.** As fontes conferidas estão no cabeçalho de `lib/legal/perfil-do-pais.ts`, e a tela avisa quem escolhe Portugal: os prazos do sistema (7 e 15 dias úteis) são mais curtos que o mês legal; **trocar o país muda a regra do documento do contato — a partir daí, CPF enviado por API, importação ou integração é recusado como NIF inválido**; e o sistema não substitui o encarregado da proteção de dados, que deve confirmar os textos enviados aos titulares, sobretudo nas campanhas de marketing, que em Portugal, em regra, exigem consentimento prévio (Lei 41/2004, art. 13.º-A). Hoje só os webhooks da Nuvemshop criam pedido de titular; numa organização portuguesa com loja Nuvemshop brasileira o titular é brasileiro, e citar só o RGPD fica incompleto.

  O que NÃO muda: quem está no Brasil (ou nunca escolheu país) recebe o e-mail, o alarme, o PDF e o `data.json` exatamente como antes. Portugal só vale para a organização em que alguém o escolher.

  PR #2339, construído sobre o perfil de Portugal de @webtecnica (#2084), a partir da issue #1946 de @maclevison, que pediu o perfil e a revisão da citação.

- **A rede social conectada agora pode sair do atendimento ou ser desconectada pela tela** Antes, a tela de redes sociais só conectava. Quem ligava um Instagram ou um Facebook ao atendimento não tinha como desfazer: a assinatura de webhook continuava viva no provedor e as mensagens continuavam entrando. Agora cada conta tem dois botões, e os dois pedem confirmação. **Remover do atendimento** apaga a assinatura de webhook no provedor e arquiva o canal, e a conta continua vinculada para voltar a receber depois. **Desconectar conta** faz o mesmo e também remove a conta do provedor. Nos dois casos as conversas já recebidas continuam no CRM. Se o provedor recusar a chamada, o canal fica como estava e dá para tentar de novo. Contribuição de @rafaelbatistazz (#2362, refs #1314).

- **Em Portugal, o relatório de acesso do titular passa a trazer as alíneas do art. 15.º e a ligação para o data.json** Numa organização com país Portugal, o PDF de acesso ganha a secção "Informações exigidas pelo art. 15.º, n.º 1". A alínea e) traz os direitos de retificação, apagamento, limitação e oposição. A f) traz a autoridade de controlo (CNPD, com o site). A h) descreve os assistentes de IA que estão no ar: quem responde automaticamente e quem só sugere respostas para uma pessoa decidir. Se nenhum estiver no ar, diz que não há assistente a responder. As alíneas a), c) e d) (finalidades, destinatários e prazo de conservação) saem como "não informado pelo controlador", porque ainda não há tela para preenchê-las (#2356).

  O e-mail ao titular passa a levar também a ligação para o `data.json`, com a mesma validade do PDF. Esse ficheiro leva todas as mensagens do titular, e não só as 100 mais recentes. As outras secções têm um número máximo de registos, e as que atingiram esse número vêm listadas em `secoes_no_limite`. Por isso o relatório não chama a cópia de "completa".

  O que NÃO muda: no Brasil, o e-mail, o PDF e o `data.json` saem exatamente como antes, e o worker nem pede a ligação do `data.json`.

  Contribuição de @webtecnica (#2354, Refs #2340).

- **A limpeza automática de mídia antiga ganha um interruptor, e a conversa avisa quando a mídia foi apagada** A limpeza que apaga a mídia das conversas (fotos, áudios, documentos) com mais de N dias, ligada desde a 1.53.0, **continua ligada** em todas as empresas: nada muda para quem atualiza. O que entra é o controle e o aviso. Em **Configurações › Empresa**, o interruptor **Limpeza automática de mídia antiga** mostra "Ligado: apaga a mídia com mais de N dias" e permite desligar; para ligar de novo, a tela pede confirmação. A partir desta versão, quando a mídia de uma mensagem é apagada, a conversa mostra "Mídia apagada pela política de retenção (N dias)" em vez de um erro, a transcrição do áudio sai junto, e o sistema não tenta buscar o arquivo de novo no WhatsApp. A mídia apagada antes desta versão (desde a 1.53.0) não tem esse marcador e segue o caminho antigo: o sistema tenta buscá-la no WhatsApp e, se não achar, mostra "Mídia indisponível". Enquanto a empresa tem um pedido de LGPD em andamento, a limpeza dela fica pausada. O piso de 30 dias vale mesmo com valor menor gravado no banco.

  Contribuição de @webtecnica (#2180), a partir da issue #1534 de @franceschini-lucas.

### Corrigido

- **Gravar a partir de uma aba que ficou na organização antiga passa a ser recusado (nas telas que usam o cliente da API), e a aba avisa quando a sessão mudou** A organização ativa é uma só por sessão do navegador, mas cada aba mostrava a que tinha quando abriu: depois de trocar de empresa numa aba, as outras seguiam exibindo a antiga enquanto já liam e gravavam na nova.

  Agora a aba avisa ("Esta aba está numa organização diferente da sessão. Recarregar?") e não recarrega sozinha, para não perder formulário em edição. Nas telas que gravam pelo cliente da API (`apiClient`), o servidor recusa a escrita com `org_divergente` (409) quando a organização da aba não bate com a da sessão. As telas que gravam com `fetch` direto e as server actions ainda não estão cobertas; o restante fica na #2335. Nada muda na configuração.

  Relatado por @aleflores35 (#2313). Contribuição de @webtecnica (#2360, refs #2335).

- **A conexão do WhatsApp ganha uma opção de guardar o histórico do número, desligada por padrão** A sessão do canal nascia sem guardar o passado do aparelho (3 conversas e 1 MB no número medido, contra 825 conversas e 57 MB com o acervo). Agora a tela de conexões oferece, por conexão, "Guardar o histórico anterior à vinculação" (`noweb.store` com `enabled` e `fullSync`), **desligada por padrão**. O histórico fica no servidor do canal, fora do alcance da anonimização do CRM (acompanhado em #2320), e ligar a opção não faz conversa antiga aparecer no inbox.

  Ligar tem custo: a vinculação de um número movimentado gasta tempo, CPU e disco do canal (o contêiner tem teto de 1.280 MB na instalação padrão). O histórico anterior (cerca de 1 ano) só vem se a opção estiver ligada NA vinculação; num número já pareado, ligar guarda daqui em diante, sem QR novo, e a conexão reinicia por alguns segundos. **Desligar num número já pareado pode apagar o que o canal já guardou**, e a tela avisa. Instalações atualizadas não mudam nada sozinhas.

  Contribuição de @webtecnica (#2319), a partir da issue #999 de @rogercampel.

- **O atendente vê os modelos aprovados do WhatsApp oficial quando a janela de 24 horas fecha** No inbox, quando a janela de 24 horas de uma conversa do WhatsApp oficial fecha, a única forma de falar com o cliente é um modelo aprovado. Para o atendente (papel `agent`), esse seletor aparecia vazio: a lista de modelos pedia papel de administrador e devolvia "sem permissão". Agora quem atende lê a lista. Sincronizar modelos e gravar o link de mídia continuam só com administrador, como no canal intermediado.

  Contribuição de @webtecnica (#2359).

- **A busca de contatos acha o nome com ou sem acento** A busca da lista de contatos comparava o nome com `ilike`, que ignora maiúsculas mas não ignora acento: quem digitava "Joao" não achava "João", e "MARCIA" não achava "Márcia". Agora as quatro colunas de texto (nome, nome exibido, e-mail e telefone) usam `imatch`, e cada letra com acento do português vira uma classe (`jo[aáàâãä…]o`), então o termo acha o cadastro nos dois sentidos, sem migração e sem `unaccent` no banco.

  Letra acentuada fora do português (`ñ`, `ë`, `å`, `ò`) continua achando pela grafia exata, como antes. Asteriscos seguidos no termo viram um curinga só, para que um termo longo de `*` não trave a consulta. Telefone e CPF seguem com a mesma comparação de antes. A busca de conversas continua em `ilike` e ainda não acha o nome sem o acento.

  Contribuição de @webtecnica (#2310, Refs #1835).

- **A tela de Produtos encontra qualquer produto do catálogo, não só os 500 primeiros** A tela de Produtos carregava só os 500 primeiros produtos e a busca procurava apenas entre eles. Em catálogos maiores, o restante não aparecia nem buscando pelo nome, embora o atendente de IA continuasse encontrando todos. Agora a busca procura no catálogo inteiro, por nome, código, marca ou categoria, e a lista mostra 50 produtos por página, com o total e botões para avançar e voltar. A busca também deixou de falhar quando o texto tem vírgula ou parênteses, e um `%` digitado passou a ser procurado como caractere, não como curinga. Uma falha ao ler o catálogo aparece como erro, não como catálogo vazio. Não é preciso fazer nada na instalação. Contribuição de @valterhjr (#2138, refs #2135).

- **A tela de Produtos de um catálogo grande abre sem "Algo deu errado"** Ler o catálogo custava cerca de 2 ms por produto, porque o banco conferia a regra de quem pode ALTERAR preço em cada linha, mesmo numa leitura. A tela de Produtos lê o catálogo inteiro para contar o total, e num catálogo de alguns milhares de produtos a leitura passava do limite de 8 segundos do banco: a tela mostrava "Algo deu errado" em vez da lista. Agora a regra de alteração só vale para alterar, e a leitura de 579 produtos caiu de cerca de 1,2 s para 10 ms. Quem pode ver e quem pode alterar o catálogo continua igual: só gerente e administrador cadastram, alteram e apagam. A atualização aplica o ajuste sozinha, e não é preciso fazer nada na instalação.

- **Etiquetas verde-água e vermelha passam a sair com texto branco, inclusive as que já tinham cor** Os dois tons da paleta de etiquetas que saíam com texto preto sobre fundo forte foram escurecidos: o verde-água passa de `#12a594` para `#00655a` e o vermelho de `#e54d2e` para `#cf3716`. Nos dois, o texto do chip agora é branco, com contraste de 6,98 e 4,99. Os nomes e a fileira de cores na tela de Tags continuam os mesmos.

  As etiquetas que já tinham sido pintadas com os tons antigos não precisam de nada: elas passam a ser lidas no tom novo, sem migration, e a tela de Tags abre com o tom certo marcado. Quem gravar um dos tons antigos pela API recebe o tom novo gravado. Nada muda na configuração.

  Relatado por @Fabio-Ribeir0 (#2373). Contribuição de @webtecnica (#2380).

- **Regras de WhatsApp por aniversário e por compromisso passam a enviar** As regras de automação com gatilho "No aniversário de um contato" ou "Agendamento criado/confirmado/remarcado/cancelado/compareceu/não compareceu" e ação de mandar WhatsApp (ou de acionar a IA, ou de iniciar um fluxo) nunca chegaram a enviar: o evento nascia sem a origem do atendimento e a ação terminava `failed` com `service_boundary_stale`, sem erro em lugar nenhum. O carimbo no instante da emissão e a resolução na leitura passam a ler a mesma tabela de `(tipo, entidade) → contato`.

  Atenção a quem já tem uma regra dessas configurada: depois desta atualização ela envia WhatsApp de verdade para o contato, no próximo aniversário ou no próximo evento de agenda. O envio respeita a janela de horário do canal, o limite diário e o espaçamento entre mensagens, como qualquer automação. Eventos anteriores à atualização não são reenviados. Se a regra foi criada e esquecida, revise-a ou desative-a antes de atualizar.

  Contribuição de @Tong-bit-art (#2330), a partir da issue #2326 de @Sandersono.

- **O instalador diz onde configurar o envio de e-mail ao pular a Resend** Quem deixava a chave da Resend em branco na entrevista terminava sem saber que o envio tinha caminho de volta: o `.env` saía sem remetente, e o CRM subia sem mandar convite de equipe, PDF de LGPD nem — em Supabase próprio — os e-mails de acesso (senha, cadastro). Agora o campo da Resend mostra o atalho junto do "Enter pula", e a tela final — a única que a pessoa lê inteira — repete a pendência dizendo o que não sai e onde ligar: Admin → E-mail, a mesma tela que configura o servidor SMTP próprio ou o serviço externo (Resend). Num Supabase próprio o aviso acrescenta o passo `bash hostgator-setup-kit/update.sh`, para o GoTrue passar a usar o mesmo servidor.

  Nenhuma ação para quem já manda e-mail: o aviso só aparece quando não há `RESEND_API_KEY` nem `SMTP_HOST` no `.env`.

  Contribuição de @Tong-bit-art (#2325, fecha #1110).

- **A tela de agendas não diz mais "Ainda não sincronizada" para agenda que só bloqueia horário** Quem conectou o Google e marcou várias agendas para bloquear horário via só UMA delas com "Última sincronização" na tela de agendas conectadas. As outras apareciam como "Ainda não sincronizada", e a única forma de conferir se estavam paradas era olhar o banco — enquanto isso a agenda seguia trazendo eventos normalmente (uma delas trouxe 39).

  A rodada de sincronização agora grava a marca em cada agenda que ela leu, e não só na que recebe os compromissos novos: quem só bloqueia horário é lida na mesma passada que a de destino e sai com a própria hora gravada. A marca continua sendo verdadeira — agenda que a rodada não leu não ganha carimbo, e a que não terminou de ler continua mostrando o erro na própria linha, como já mostrava.

  Nada a fazer na atualização: a próxima rodada de sincronização grava as marcas que faltarem.

  Contribuição de @webtecnica (#2332).

- **Quem marca para amanhã não recebe o lembrete de véspera no mesmo dia** Com o lembrete de 1 dia ligado, quem marcava hoje às 9h para amanhã às 14h recebia, hoje às 14h,
  a mensagem "passando pra lembrar do seu compromisso" — poucas horas depois de ter confirmado. O
  lembrete que já estava vencido na hora da marcação já não saía; faltava o que vence mais tarde no
  mesmo dia. Agora o lembrete de 1 dia ou mais não sai no mesmo dia em que a reunião foi marcada, no
  fuso da organização. O aviso curto, como o de 1 hora antes, continua saindo normalmente.

  Contribuição de @erikyudi (#2349).

- **O link de redefinir senha, de convite e de confirmar cadastro funciona para quem usa Hotmail, Outlook e e-mail corporativo** Quem recebia o e-mail num Hotmail, Outlook ou numa caixa corporativa clicava no link e caía em "Link inválido ou expirado", mesmo pedindo um link novo. O motivo: esses provedores abrem cada link sozinhos, segundos depois da entrega, para conferir se é seguro, e o CRM gastava o token de uso único nessa primeira visita. Agora o link leva a uma tela "Confirmar acesso" com o botão Continuar, e o token só é usado quando a pessoa aperta o botão. Verificador automático abre o link, mas não aperta o botão. Nada muda na configuração da instalação.

  Contribuição de @fabianmartinelli-fm (#2183).

- **O agente passou a incluir alguém da equipe no convite da reunião que marca (guest_email)** Quando o agente marcava uma reunião (`crm_book_appointment` ou `crm_find_and_book_appointment`), o convite do Google saía sem o consultor que ia conduzi-la: as ferramentas do agente não ofereciam o `guest_email` que a tela e a API já aceitavam. Agora as duas aceitam `guest_email` opcional, desde que seja de um usuário ativo da própria empresa; e-mail de cliente, de terceiro ou de outra empresa é recusado e nada é marcado. Sem `guest_email`, a marcação funciona como antes, e a tela da Agenda e a API não mudam. Nenhuma ação é necessária.

  Contribuição de @webtecnica (#2077), a partir da issue #2062 de @InvestidorDiversificado; a regra de "só da equipe" foi decisão do mantenedor, aplicada sobre o trabalho dele.

- **O relatório de acesso (LGPD) mostra o CPF informado na conversa mascarado, em vez de apontar para um arquivo que o titular não recebe** Quando o titular tinha informado o CPF numa conversa, o PDF de acesso dizia "Informado na conversa (valor no arquivo de dados)" e o mandava a um `data.json` que ele nunca recebe: o arquivo fica no servidor e o e-mail entrega só o PDF. Agora a linha mostra o próprio CPF com só os 4 últimos dígitos visíveis (`***.***.*47-25`). Quando o relatório não consegue saber com segurança qual valor é do titular (nenhum CPF guardado, ou dois campos de CPF com valores diferentes, como o do responsável e o do paciente), a linha diz "valor não disponível neste relatório", sem apontar para arquivo nenhum. O valor completo continua guardado só no arquivo de dados. Não há nada para quem opera a instalação fazer.

  Contribuição de @webtecnica (#2355, refs #2341).

- **A limpeza automática do arquivo de webhooks não trava mais quando há atraso acumulado** A poda pedia 500 itens de uma vez num endereço longo demais: com algumas centenas de linhas vencidas acumuladas, o endereço passava do limite do gateway e a limpeza parava na mesma leva para sempre, deixando o banco crescer sem teto (numa instalação medida, ~23 MB/dia). Agora o lote é cortado por data, e a poda esvazia o corpo das linhas vencidas como prometido. Nada muda na configuração.

  Contribuição de @Sandersono (#2324).

- **O roteador volta a escolher qual agente atende cada mensagem** Em empresas que usam a OpenRouter, o roteador de agentes falhava a cada mensagem com o erro "claude-haiku-4-5 is not a valid model ID" e nenhuma escolha de agente acontecia — toda conversa caía no mesmo agente, ou em nenhum, como se os roteadores configurados não existissem. A mensagem nunca aparecia no painel de erro: era o aviso que a própria tela do classificador mostrava.

  O modelo do classificador vinha gravado pelo próprio Deskcomm ao criar o roteador, com um nome que a OpenRouter não reconhece. Ninguém escolheu esse modelo, e a empresa podia ter configurado Claude como modelo de atendimento — o roteador é que insistia no dele. Agora o roteador nasce em "Automático": quem decide o modelo do classificador é o painel de provedores ou, na falta dele, o modelo de atendimento da empresa, e nenhuma escolha é sobrescrita por baixo dos panos.

  Quem já tinha um roteador com esse modelo gravado de fábrica, numa empresa que não usa a Anthropic diretamente, passa para "Automático" ao atualizar. Se quiser um classificador mais barato e rápido do que o modelo de atendimento, basta escolhê-lo na tela do roteador. Empresas que usam a Anthropic diretamente não mudam nada: lá esse modelo funciona, e o roteador continua com ele. Também não muda nada para quem escolheu o modelo do classificador na tela, inclusive o Claude Haiku 4.5 pela Requesty, nem para quem não usa roteador de agentes. Não é preciso fazer nada na instalação.

  Contribuição de @dilneiss (#2134).

- **A IA não pede mais o máximo de tokens do modelo em cada resposta** Quando a organização não definia um limite de tamanho de resposta, a chamada ao modelo saía sem
  limite nenhum. No OpenRouter isso reserva o máximo do modelo (64 mil tokens no Claude Haiku 4.5)
  contra o saldo da chave, e uma chave com crédito para milhares de respostas curtas recusava todas
  com "can only afford". O agente parava de responder e as sugestões do modo assistido falhavam.
  Agora, sem limite configurado, cada resposta pede no máximo 4.096 tokens; quem definiu um limite
  próprio continua com o dele.

  Contribuição de @erikyudi (#2350).

- **A transferência de funil pergunta a régua da etapa de perda da origem antes de criar o clone** A troca de funil (`transfereParaOFunil`, usada pela automação `create_or_move_lead` e pelo roteador de intenção) criava o clone no funil de destino e só depois encerrava a origem — e a exigência de campos da etapa de perda mora dentro do encerramento. Quando a etapa de perda da ORIGEM tinha `obrigatorio_em` (`ao_perder` ou `etapas`) apontando um campo que o negócio não tinha, a recusa `required_fields_missing` nascia depois do clone gravado: o cliente ficava com dois negócios abertos, um em cada funil, com a recusa dizendo que nada mudou.

  A régua agora é conferida antes da primeira escrita, com a mesma função de sempre (`validaCamposExigidos`) e o mesmo 422 com `details.faltando` — os dois chamadores continuam tratando exatamente o mesmo código, e quando a régua recusa nenhum negócio novo é gravado.

  Nada muda para quem não configurou `obrigatorio_em` no funil da origem: a regra continua opt-in, e uma leitura indisponível das configurações deixa a transferência acontecer como antes.

  Contribuição de @webtecnica (#2308, fecha #2303).

## [1.73.0] — 2026-10-05

### Adicionado

- **A auditoria da edição do negócio passa a guardar o valor anterior e o novo de valor, moeda, responsável e data prevista** Antes, a linha `lead.updated` do log de auditoria dizia só QUAIS campos mudaram. Agora ela também traz, em `metadata.valores`, o antes e o depois de cinco campos: valor, moeda, responsável (pessoa ou agente) e data prevista de fechamento — e só quando o campo mudou de fato. Isso permite responder "quem mudou o valor desta proposta, e de quanto para quanto?".

  Título, descrição, etiquetas e campos personalizados continuam registrados só pelo nome: o log de auditoria não é reescrito pela anonimização da LGPD, então o texto livre do cliente não entra nele. Os cinco campos que entram são os mesmos que a anonimização preserva de propósito no próprio negócio. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2292, fecha #1755).

- **O produto se edita pela tela do catálogo** Quem administra corrigia um preço ou uma descrição do catálogo só reimportando a planilha — e a importação, de propósito, não grava `descricao` nem `ativo`. Agora a tela Produtos tem o botão **Editar**: ele abre o formulário já preenchido com o que está cadastrado e grava pelo `PATCH /api/v1/products/:id` que a API já aceitava, mandando para o servidor somente os campos que realmente mudaram (sem mudança, a tela avisa e não faz chamada nenhuma).

  Produtos sincronizados de uma integração (`origem` que não seja `manual` nem `planilha`) abrem o formulário **somente leitura**, com o aviso de que a edição vale na origem: a próxima sincronização sobrescreveria o que fosse mudado aqui. As fotos continuam editáveis pelo botão de sempre, porque a integração não mexe nelas.

  Contribuição de @webtecnica (#2288, refs #2135).

- **Cada intenção do roteador pode levar o negócio para o funil certo** Na tela do roteador, cada intenção ganha um campo opcional de funil de destino (e, se quiser, a etapa; sem etapa, vale a primeira etapa aberta do funil). Quando o roteador escolhe a intenção, o negócio do cliente vai para esse funil antes de o agente responder, e o agente passa a trabalhar no card do time certo. Até aqui o roteador só escolhia o agente, e o card ficava no funil de entrada.

  Sem destino configurado, nada muda: quem atualiza continua com o roteamento de antes. Se o cliente troca de assunto para outra intenção que tem destino, o card vai para o novo funil e o negócio anterior é encerrado como transferência, com o motivo "Levado para outro funil", que não conta como perda nas métricas. A linha do tempo registra que foi o roteador de intenção quem levou o card. Se o contato já tem um negócio aberto no funil de destino, nenhum card novo é criado.

  Contribuição de @webtecnica (#2290, fecha #2155).

- **Tempo na etapa (quem está nela agora) na tela de etapas, medido por stage_changed_at (#2032)** A tela de etapas passa a mostrar, ao lado da taxa histórica de ganho (#1753), quanto tempo os negócios estão NA etapa AGORA — medido pela ENTRADA do negócio na etapa (`crm_leads.stage_changed_at`, carimbada pelo trigger `trg_stamp_stage_changed_at` desde a migration 0071), com `created_at` de reserva para o lead sem carimbo. `last_activity_at` não entra na conta: é tempo sem resposta, e uma nota na conversa zerava o relógio de um negócio parado há semanas. É a mesma escolha do card do Kanban desde o #1908.

  Quem entrega o número é `lib/metrics/tempo-da-etapa.ts` (puro, relógio injetado), publicado pela rota `GET /api/v1/pipelines/{id}/stages/win-rates` no bloco `tempo_na_etapa`, com `medida` e `base` escritos na resposta: a taxa ao lado é de OUTRA população (quem passou pela janela de dias, reconstruída das atividades `stage_changed`) e as duas não se somam. Por etapa saem quantidade, média e mediana de horas, além da amostra `com_carimbo`/`sem_carimbo` — número medido sobre reserva não é número medido sobre carimbo. Ganho e perda não recebem a frase: lá a coluna não segura trabalho em curso.

  Sete testes do módulo cobrem os três casos da issue, inclusive o de `last_activity_at` mais recente ser ignorado; a rota e a tela têm teste próprio, e etapa vazia não ganha «0 h».

  Contribuição de @webtecnica (#2225, fecha #2032).

### Corrigido

- **Instalação single-server atrás de um Traefik próprio ganha rota para as seis APIs do Supabase** Quem já tem um Traefik ocupando as portas 80/443 (em modo host, como na Hostinger; Traefik em bridge, como Coolify/Dokploy, ainda não é coberto) e instala o modo single-server com `REVERSE_PROXY=traefik` consegue concluir a instalação, desde que o entrypoint HTTPS desse Traefik se chame `websecure` ou que `TRAEFIK_ENTRYPOINT` seja exportado com o nome dele (a rota do Supabase lê o entrypoint só do ambiente; com outro nome, como `https`, ela é ignorada pelo Traefik): o Caddyfile do modo Caddy roteava `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1` e `/graphql/v1` para o Envoy do Supabase, e o overlay do Traefik não tinha essa regra — o Traefik entregava esses caminhos ao app, que devolvia 404, e o instalador parava em "NEXT_PUBLIC_SUPABASE_ANON_KEY inválido". As seis prefixos agora viram etiquetas de rota no `api-gw`, ligadas só quando o instalador grava `TRAEFIK_ENABLE=true` no `.env` do Supabase, com prioridade acima da rota geral do app e abaixo do bloqueio do webhook do WAHA.

  Para quem instala em Caddy — a maioria — nada muda: a rota nasce desligada (`traefik.enable=false`) e nenhuma variável nova do produto é lida. Para quem já instalou em Caddy não há efeito visível (o contêiner do Envoy é recriado uma vez na atualização), e para quem já instalou atrás de Traefik basta rodar de novo o `install-single-server.sh` com `REVERSE_PROXY=traefik` no ambiente, que regrava o `.env` do Supabase e recria o contêiner do Envoy com a rota.

  Contribuição de @webtecnica (#2289, fecha #2099).

- **O assistente para de prometer retorno ao cliente sem que alguém fique responsável** Medido em produção em 16 de setembro. O assistente escreveu ao cliente: *"Vou encaminhar as informações do site imobiliário para análise e te retorno com a proposta."* O cliente saiu da conversa esperando um orçamento — e ninguém ficou devendo nada, porque o sistema não registrou nada: nenhum caso para alguém resolver, nenhum retorno marcado, nenhum aviso na Central.

  Existe uma trava exatamente para isso — o assistente não pode prometer que uma pessoa da empresa vai agir sem que alguém fique responsável. A trava disparou **uma vez**, o assistente reformulou a frase, e a segunda formulação **passou**. O sistema dependia de reconhecer promessa por palavra: exigia "equipe", "setor" ou "responsável" colado ao verbo, e um objeto no meio da frase ("as informações") já a despistava. De sete frases equivalentes medidas, **cinco passavam** — inclusive uma que escrevia "equipe".

  Agora a trava também pergunta ao classificador que já roda a cada envio se a mensagem promete que alguém da empresa volta a falar com o cliente. Os dois sinais valem juntos: o antigo, que é de graça e imediato, e o novo, que pega o que a palavra não pega. **Nenhuma consulta a mais é feita** — a pergunta entrou na mesma que já existia.

  Quando quem promete voltar é o próprio assistente (*"Combinado! Te retorno amanhã de manhã."*), marcar o retorno na agenda de follow-up também resolve: se o assistente agendou o retorno naquele mesmo atendimento, a mensagem sai sem precisar de caso. Isso vale só para a promessa do assistente. Se a frase diz que alguém da empresa vai agir (a equipe, uma análise, o responsável, um setor), o caso continua obrigatório, com ou sem retorno agendado. Na dúvida, por exemplo quando a resposta do classificador vem incompleta, vale a regra mais rígida: o caso é exigido.

  Um detalhe que vale saber na hora de decidir: a camada que faz a segunda pergunta segue a escolha que já existe na tela do assistente, no painel de segurança, e só o administrador da empresa a muda. Desligando, o reconhecimento volta a ser só por palavra — isto é, aquelas cinco frases voltam a passar.

  Contribuição de @paulolimajr77 (#1873).

- **A catraca do espanhol passa a enxergar a chave montada em runtime e o t() sobre variável** O gate que cobra a tradução em espanhol só reconhecia texto escrito no código (`t("literal")`) e tabela resolvível (`t(TABELA[k])`): quando a chave é montada em runtime (``t(`Meta de ${x} batida`)``) ou vem de uma variável que ninguém consegue ler (`t(rotulo)`), o gate ficava verde mesmo sem nada em espanhol — e, como `traduzir()` devolve a própria chave quando ela falta, a frase saía em português para quem escolheu espanhol. A catraca agora cobre as duas formas, apontando arquivo:linha de cada uma.

  34 sítios já existentes foram congelados em uma lista com a razão escrita de cada um (a lista só encolhe; nenhuma tradução foi mexida) — consertar um por um é decisão de produto, e está declarado assim. Métrica e gates na PR.

  Contribuição de @webtecnica (#2298, continuação da #603).

- **Criar negócio direto numa etapa exigente também passa pela régua de campos obrigatórios** A criação de negócio (`POST /api/v1/leads`, o diálogo do Kanban com etapa escolhida, a ferramenta MCP `crm_create_lead`, a importação de planilha, a automação `create_or_move_lead` — ao criar e ao transferir entre funis — e a prospecção) passou a perguntar a mesma régua de campos obrigatórios que o arrasto, o lote, o encerramento e o clone já perguntavam. Até aqui a criação era o único caminho que nascia na etapa exigente com o campo em branco, e a cobrança só aparecia na escrita seguinte, com o negócio já lá. Agora a recusa é visível onde alguém configurou o caminho: a importação mostra a frase, e a automação fica com status de falha e a mesma frase, como já acontecia ao mover.

  Os formulários de captação (webhook de entrada) seguem entrando como antes: o lead que chega de fora entra na etapa padrão da fonte mesmo que ela exija um campo que o formulário não mandou.

  Nada muda para quem não configurou `obrigatorio_em` num campo do funil: a regra continua opt-in, e uma leitura indisponível das configurações deixa a criação acontecer como antes. Na transferência entre funis a recusa acontece antes de clonar e de fechar a origem, então o negócio continua aberto no funil de onde saiu.

  Contribuição de @webtecnica (#2295, fecha #1710).

- **Agente criado pela API sem `version`, ou duplicado de um agente antigo sem versão, nasce com rascunho v1 editável na tela** Uma integração que criava agente por `POST /api/v1/ai/agents` sem o campo `version`, e a duplicação de um agente antigo que nunca teve versão, gravavam um agente sem nenhuma versão, que nem o atendimento do CRM nem o agent-engine enxergam: ele existia na lista e nunca respondia.

  Agora os dois casos nascem como agente do formato atual (`kind: "mcp_agent"`) com uma versão 1 em rascunho, montada do prompt e do modelo enviados. O agente aparece como parado e só atende depois que alguém publica a versão na tela, como qualquer agente novo; por isso ele também deixa de gerar o aviso de "agente sem versão".

  A resposta da API para o formato sem `version` continua sendo a linha do agente, e o modelo omitido continua sendo `anthropic/claude-sonnet-5`. Muda o valor de `kind`, que passa de `rag_bot` para `mcp_agent`. Os agentes antigos que já existem não são alterados.

  Contribuição de @webtecnica (#2296, refs #1357).

- **O diálogo de excluir contato avisa do compromisso na Agenda antes do clique** Ao abrir "Excluir contato?", a tela agora consulta o que vai barrar a exclusão e, se o contato tem compromisso na Agenda, diz isso já no diálogo, com um link para abrir a Agenda. Antes o aviso só aparecia depois de tentar excluir. Sem compromisso, o diálogo continua igual e a exclusão segue normalmente. A tela usa a mesma contagem que a exclusão.

  Contribuição de @webtecnica (#2293, fecha #1925, continuação do #1949).

- **O item "demanda aberta sem próximo passo" do Radar vira link, e o caso cancelado ou resolvido marca um próximo passo na demanda que ele abriu** No Radar de risco, o item "demanda aberta sem próximo passo" deixava de ser só
  texto: agora é um link para a conversa vigente da demanda (ou, sem conversa,
  para a ficha do contato), como já eram as outras seções — dava para chegar à
  demanda pelo alerta.

  E um caso cancelado ou resolvido passa a marcar um próximo passo na demanda que
  ele abriu por handoff ("Revisar o caso encerrado e registrar o desfecho da
  demanda"): antes ela ficava "em atendimento" e sem próximo passo para sempre,
  presa na seção de risco do Radar. O sistema não decide o desfecho — só tira a
  demanda de "sem próximo passo" e a deixa visível em "Demandas abertas" do painel
  da conversa, com "Encerrar demanda" ao lado, até alguém registrar o desfecho.

  Demanda antes presa em `em_atendimento` num caso rescindido não é
  retroativamente corrigida por esta versão. Sem ação necessária.

  Contribuição de @webtecnica (#2056, fecha #2035).

- **As recusas da régua de campos obrigatórios agora chegam a quem precisa ver** Com a régua na criação de negócio (#2295), quatro caminhos recusavam sem que a pessoa certa visse — ou deixavam um resto. Os quatro passam a se comportar assim:

  1. **Roteador de intenção (#2290).** Quando a etapa de destino exige um campo, `transfereParaOFunil` lança e a recusa morria num `runLog.warn` que ninguém lê. Agora a recusa é capturada em `aplicaDestinoDaIntencao` — onde o negócio de origem é conhecido — e abre um aviso na Central (`kind: other`, apontando para o negócio), sem empilhar o mesmo aviso aberto. O negócio de origem continua aberto, como antes: nada se perde, e agora alguém fica sabendo.
  2. **Tool MCP `crm_create_lead`.** Ganhou `custom_fields` no `inputSchema`: o agente que sabe o valor consegue criar um negócio numa etapa exigente, pelo mesmo `createLeadHandler` e a mesma régua de todo mundo. Sem a chave, `z.object` descartava o argumento antes de chegar a quem pergunta a exigência.
  3. **Import de planilha.** O contato da linha 1 é criado antes do `createLeadHandler` da mesma linha, e um 422 da régua (ou um 404 de etapa) derruba a importação inteira: agora os contatos que ESTA requisição criou e que ficaram sem negócio são devolvidos ao banco antes da resposta de erro. Os que já estavam no cadastro e os que já viraram card nunca entram no desfazimento.
  4. **Captação.** O motivo da recusa na tela "Leads recebidos" deixa de ser `erro_ao_criar_lead` para tudo: a régua vira `recusa_da_regra` com rótulo próprio, funil/etapa seguem com o rótulo original, e o resto vira `erro_inesperado` — o rótulo não promete mais "funil e etapa" numa recusa que não é deles.

  A régua não afrouxa em nenhum dos quatro: a isenção da rota de captação (`exigirCamposDaEtapa: false`, decisão do #2295) continua intacta, e nenhum caminho passa a criar o que a régua recusava.

  Contribuição de @webtecnica (#2302, fecha #2297).

- **O banco recusa nome de sessão WAHA acima do teto de 54, em vez de só o teste conferir** O teto de 54 caracteres que o WAHA impõe no nome da sessão era conferido em três lugares de código — o teste de banco, o teste unitário e a guarda antes de chamar o WhatsApp — e em nenhum deles dentro da escrita da linha. Um INSERT direto (um script, o PostgREST, ou uma migration que copiasse o corpo antigo) gravava um nome acima do teto sem que nada recusasse, e o erro só aparecia quando o operador tentava conectar o número, com o card preso em "Parado".

  Agora a própria tabela `channel_sessions` recusa a linha com o mesmo código de erro das recusas de domínio da reserva: um nome novo acima de 54 não entra, e renomear uma linha para cima do teto também não. Instalação existente não é afetada — uma linha antiga com nome acima do teto continua recebendo mudanças de status, metadata e lease normalmente, porque a recusa olha apenas o nome que está sendo escrito; e o caminho de conserto (renomear para o formato curto de 45) continua cabendo na mesma linha.

  De quebra, o teste de tela de pré-go-live deixa de montar `prego_` à mão e passa a usar o mesmo gerador que o banco usa, com o formato real conferido.

  Contribuição de @webtecnica (#2301, fecha #686).

- **Ligação telefônica de contato bloqueado é recusada e aparece como "Cancelada"** Quem mandou "PARAR" não recebe mais ligação da IA: no telefone (SIP), a chamada de entrada de contato bloqueado é desligada na hora, sem virar negócio, sem tocar aviso para a equipe e sem carimbar a linha do tempo — recusar é não-interação. A linha fica gravada no histórico e na tela de chamadas como "Cancelada", o status existente mais próximo de recusa (um rótulo próprio pode vir em PR seguinte), para a equipe saber que a ligação existiu sem precisar agir. No WhatsApp a ligação não é recusada: a perdida de bloqueado só deixa de gerar aviso e linha do tempo, e a atendida por alguém da equipe continua na linha do tempo. A saída (discar para bloqueado) já era recusada e continua igual; falha ao ler o bloqueio deixa a chamada passar, nunca derruba ligação legítima por instabilidade.

  Contribuição de @paulolimajr77 (#2299).

- **O WAHA passa a assinar as entregas de webhook e a exigência de assinatura passa a funcionar** O compose entregava o segredo ao contêiner do WAHA numa variável que não existe na documentação dele (`WHATSAPP_HOOK_HMAC` em vez de `WHATSAPP_HOOK_HMAC_KEY`), então o WAHA ignorava e nunca assinava nada — e ligar "Exigir assinatura nas entregas do canal" cortava a entrada de mensagens com `401 signature_required`.

  Agora o nome é o exato da documentação (nos três composes e no runbook). Na atualização o contêiner do WAHA é recriado e passa a mandar `X-Webhook-Hmac` em toda entrega; quem tem a exigência ligada volta a receber mensagens, agora com `valid_signature = true` no log. Nenhuma ação do operador: o segredo é o mesmo, só o nome da variável mudou.

  Contribuição de @paulolimajr77 (#2268).

## [1.72.0] — 2026-10-04

### Adicionado

- **Quem escreve fora do horário de atendimento pode receber um aviso configurável — uma vez por contato por período fechado** O turno de quem chega fora da janela do agente era adiado para a abertura sem nenhuma resposta: no sábado à noite, silêncio até segunda de manhã, e a pessoa sem saber se a mensagem chegou. Agora a tela de gatilho do agente (em "Só atender em horário de funcionamento") aceita um texto de aviso, e esse texto é enviado quando a mensagem chega fora da janela, registrado na conversa como Automação. Vale só para quem preencher o texto: o padrão é não enviar nada, e quem não mexer na tela não vê mudança nenhuma.

  O aviso só sai DENTRO da janela de envio do número (por padrão 7h–22h, ajustável por canal). Quem escreve entre o fechamento dessa janela e a abertura seguinte (por padrão, das 22h às 7h) não recebe o aviso na hora: o turno fica em silêncio até a janela de envio abrir, e só então o aviso sai, se o horário de atendimento ainda estiver fechado.

  Vale no máximo um aviso por contato por período fechado: o período começa quando a janela fecha e só volta a valer quando ela abre e fecha de novo: um segundo contato na mesma noite não recebe de novo, e o contato bloqueado (opt-out/`is_blocked`), o titular anonimizado e o número interno da própria organização não recebem nunca. O aviso é RESPOSTA a quem escreveu primeiro, não disparo ativo: ele respeita a janela de resposta do número, o warm-up, o teto diário e o espaçamento, e entra na contagem de envios como qualquer outro. Quando o horário de atendimento abre, a IA responde normalmente sobre a conversa que já tem o aviso.

  Contribuição de @webtecnica (#2284, refs #1926).

- **Em coexistência, o que a equipe cadastra no endereço do app WhatsApp Business vira cadastro no CRM** Num número em coexistência (o mesmo número no app WhatsApp Business e na Cloud API), a empresa também cadastra e renomeia contato no **endereço** do app — o da agenda do celular. A Meta entrega isso no webhook `smb_app_state_sync`, que o canal oficial descartava: o CRM ficava sem o nome que a equipe usa no celular, e o contato só nascia na primeira mensagem, muitas vezes sem nome nenhum.

  Agora esse webhook entra: o contato passa a existir no CRM com o nome do app (o mesmo que a Meta manda para o `display_name`, pela mesma resolução de número da mensagem recebida e do eco). A aba "API Oficial (Meta)" passa a listar `smb_app_state_sync` entre os campos a assinar no dashboard da Meta — sem coexistência a Meta não envia esse evento, então assinar é inofensivo para quem não usa.

  O que este passo **não** faz, de propósito: não cria conversa nem mensagem (nada mudou na caixa de entrada, em `last_inbound_at`, no contador de não lidas nem no agente — ninguém trocou mensagem), não sobrescreve um nome que já existe no CRM (o `coalesce` da `fn_upsert_wa_contact` preenche quando vazio e nunca sobrescreve), e não apaga cadastro quando o app remove o contato do endereço (a Meta manda `remove` sem nome, e apagar histórico do CRM por causa da agenda do celular não está provado em lugar nenhum).

  A importação do histórico de conversas (`history`, até 180 dias) e o botão de Embedded Signup com coexistência continuam fora deste passo — ver a #1632.

  Contribuição de @webtecnica (#2283, refs #1632).

- **Relatórios ganham a aba Por etiqueta** Em Relatórios (Atividades) há agora a aba **Por etiqueta**: para cada etiqueta em uso, quantas conversas ela teve no período (7, 30 ou 90 dias), quantas estão abertas e quantas foram resolvidas, a espera média e a fatia do total. Espera que não foi medida aparece como "—", nunca como zero, e período sem conversa etiquetada diz o motivo em vez de mostrar uma tabela de zeros. A aba abre direto por `/app/activities?aba=etiquetas`.

  Cada etiqueta leva à caixa de entrada na aba Todas, já filtrada por ela. O número da linha e a lista podem não bater: a lista também traz as conversas em que a etiqueta está no contato, e não se limita ao período.

  Nada a fazer na VPS.

  Contribuição de @webtecnica (#2285, refs #1891).

- **Empresas ganham consulta de CNPJ antes de criar, edição e exclusão na tela, e o CNPJ mantém a máscara quando o enriquecimento falha** No cadastro de uma empresa nova, o botão "Consultar CNPJ" busca os dados públicos na BrasilAPI e preenche o formulário para revisão antes de criar. Nada é gravado na consulta, e a tela avisa quando o CNPJ já existe na organização. Quando a BrasilAPI recusa a consulta (403) ou está fora do ar, a tela diz que é indisponibilidade e sugere tentar de novo, em vez de dizer que o CNPJ não existe. A consulta exige o papel de gestor, o mesmo da criação.

  A tela de detalhe da empresa passa a permitir editar o cadastro e excluir a empresa. Excluir exige o papel de gestor e fica registrado na auditoria. Se houver pessoas vinculadas à empresa, a exclusão é recusada e a tela mostra quantas são.

  O CNPJ deixa de perder a máscara (aparecia `33547054000120` no lugar de `33.547.054/0001-20`) quando o enriquecimento automático falha.

  Nada é preciso fazer na instalação.

  Contribuição de @webtecnica (#2273), a partir da issue #1937 de @Fabricio-Point-Machine.

- **A ficha do negócio lê as pessoas relacionadas ao negócio** A ficha do negócio passa a listar, abaixo do contato principal, as outras pessoas ligadas àquele negócio, com o papel de cada uma e a marca de anonimizado quando for o caso. Nesta versão nenhuma tela grava esse vínculo ainda (é a próxima etapa da #1506), então quem opera não vê diferença. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2272, refs #1506, proposta de @Alencaf).

### Corrigido

- **O cron do scheduler que falha deixa de falhar em silêncio — o log do scheduler diz qual rota errou e o que conferir** Quando uma rodada de cron do `scheduler` falha (o caso clássico é o `sync-model-catalog` tomando 401 porque o segredo que o agendador manda não é o que o app enxerga, o defeito da #1109), a linha do crontab descartava a saída E o erro do `curl` (`>/dev/null 2>&1`), e o crond ignora o status de saída. O resultado era um cron quebrado sem sintoma nenhum em lugar nenhum: o catálogo ficava vazio e ninguém via um log.

  Agora o `>/dev/null` fica só no corpo da resposta. O status continua no STDERR do `curl -fsS` (é o `-S` que o imprime) e, quando o comando falha, a linha imprime no STDERR qual rota falhou e o que conferir — os dois chegam ao `docker logs` do scheduler. Em rodada saudável nada muda: o `||` só dispara em falha.

  Nada a fazer na instalação.

  Contribuição de @webtecnica (#2279, refs #1109).

- **Com o Jev medindo o clima, relatar o problema deixa de passar a conversa para uma pessoa, e a concordância do Jev usa o limiar de cada agente** Quando o Jev decide o clima da conversa (Jev decidindo, ou sem IA de linguagem configurada), a escala dele passa a separar o relato do problema, que fica no neutro e não aciona a passagem, da insatisfação com o atendimento e da hostilidade aberta, que acionam. É a mesma separação que a IA de linguagem ganhou na 1.71.0. Vale para toda organização com o Jev decidindo, sem ajuste nenhum. Quem atende e-commerce deve ver menos passagens para uma pessoa por decepção com produto; para passar mais, suba o limiar do agente.

  O cartão do Jev passa a medir a concordância e os clientes irritados pelo limiar de cada agente, gravado em cada mensagem. Mensagens anteriores seguem medidas pelo padrão 0,3 até saírem da janela. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2248, refs #2219, #2209).

- **As ações do assistente numa conversa passam a valer só para o cliente dessa conversa** Durante uma conversa, toda ação do assistente que aponta um registro pelo identificador (contato, conversa, compromisso, retorno, chamado, marcador) só é aceita quando o registro é do cliente com quem a conversa está. Fora disso, a ação é recusada com uma explicação para o assistente seguir a conversa, e nada é alterado. Integrações e pessoas usando o sistema continuam com o mesmo alcance de antes.

  Nada a fazer na instalação.

- **Com as propostas desligadas, Configurações › Propostas esconde o link de modelos, e a tela de modelos explica como ligar em vez de travar em Carregando** Com as propostas comerciais desligadas na organização, a tela Configurações › Propostas deixa de mostrar o link Modelos de proposta, que levava a uma tela que travava em Carregando…. O link segue o valor salvo, então virar a chave sem salvar não o mostra. Quem chega à tela de modelos pela URL vê uma explicação e o atalho para Configurações › Propostas, em vez do aviso cru Not found e de Carregando para sempre. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2270, refs #1889).

- **A atualização não devolve mais INSERT/UPDATE/DELETE em orçamentos de IA nem TRUNCATE do log de auditoria às chaves anon e authenticated** O `baseline.sql` é reaplicado inteiro em toda atualização. Duas concessões do snapshot ao papel `anon` eram revogadas só no fim do arquivo: `INSERT/UPDATE/DELETE` em `ai_budgets` e `TRUNCATE` em `api_audit_log` (o privilégio que a RLS não alcança). Entre as duas pontas, e até a próxima atualização completa se a passada morresse no meio, a chave anônima carregava o privilégio.

  Agora as revogações acompanham as concessões, e o estado final não muda: o `anon` segue sem o que era revogado e com o resto — a leitura escopada por política em `ai_budgets` e `SELECT`/`INSERT` no log de auditoria. Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2257).

- **A atualização para de devolver o TRUNCATE do log de auditoria ao papel de serviço, e anon/authenticated perdem o TRUNCATE em orçamentos de IA** O `baseline.sql` é reaplicado inteiro em toda atualização. Três pontas da mesma família ficaram de fora do #2257: o `service_role` recuperava `TRUNCATE` no log de auditoria entre a concessão do snapshot e o bloco da 0258 (mais de 20 mil linhas de janela, de pé até a próxima atualização completa se a passada morresse no meio); e `anon`/`authenticated` mantinham `TRUNCATE` em `ai_budgets` no estado final, porque a 0160 revogou só INSERT/UPDATE/DELETE.

  Agora a revogação acompanha as concessões nos três casos, e o `TRUNCATE` de `ai_budgets` sai também do estado final para as duas chaves — ele não passa pela RLS e nenhum consumidor o usa (toda escrita da tabela é service role). Leitura e escrita legítimas seguem como estavam. Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2259).

- **A atualização interrompida não deixa mais de pé a versão antiga do portão de anonimização** O `baseline.sql` reaplica a história da função de anonimizar contato em duas definições. A intermediária, anterior à correção do #2196, ainda usava a checagem de plataforma que ignora o `scope` do JWT: se uma atualização morresse entre as duas, era essa versão que ficava no banco até a próxima passada completa, e um platform admin `support_readonly` fora de sessão de suporte voltava a poder anonimizar contato.

  A definição intermediária passou a usar a guarda completa (`fn_is_platform_admin_full`, que já existe no snapshot), então o furo não fica de pé em nenhuma passada. O estado final não muda e nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2256).

- **A atualização não devolve mais o privilégio de TRUNCATE ao papel anônimo em idempotency_keys** O `baseline.sql` é reaplicado inteiro em toda atualização. A concessão de `ALL` ao `anon` em `idempotency_keys` vinha do snapshot e a revogação de `TRUNCATE` — um privilégio que a RLS não alcança — ficava no apêndice: entre as duas pontas, e até a próxima atualização completa se a passada morresse no meio, o papel anônimo carregava o privilégio.

  Agora a revogação acompanha a concessão, e o estado final não muda: o `anon` continua sem `TRUNCATE` e com os demais privilégios da concessão. Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2253).

- **A atualização da VPS deixa de reabrir o gatilho velho da demanda e a permissão anônima das tabelas de conhecimento** O `baseline.sql` é reaplicado inteiro em toda atualização. Dois trechos eram reconstruídos no começo do arquivo e desfeitos no fim, e cada passada reabria a janela: o gatilho `trg_demanda_fecha_com_conversa` (substituído pelo modelo de atendimento na migration 0222) voltava a valer até ser derrubado, e quatro tabelas de conhecimento (fontes, versões, chunks e FAQ da IA) recebiam `ALL` para o papel `anon` — a chave pública do navegador — até serem revogadas adiante. Se a atualização morresse no meio, o gatilho antigo e a permissão anônima ficavam de pé até a próxima tentativa.

  Agora as duas recriações saíram do texto: o gatilho não é mais reinstalado, e as quatro tabelas não são mais concedidas ao `anon` de passagem. O estado final é o mesmo de antes — nenhuma tela, nenhuma regra e nenhum dado mudam, e nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2250).

- **A Central para de abrir em dobro os avisos de orçamento de IA (limite atingido e aviso de gasto)** Os dois avisos de orçamento — "o orçamento de IA foi atingido" e "o gasto passou do aviso" — deduplicam por organização e tipo, mas a pergunta "já existe um aberto?" e a escrita não eram atômicas, e dois turnos podem avaliar o gasto no mesmo instante (o worker roda tarefas em paralelo, e o worker de respostas é outro processo). Dois avisos idênticos apareciam para o mesmo problema.

  Agora o banco é quem segura: um índice único parcial em `agent_inbox_items` (organização e tipo, só enquanto o aviso está aberto) recusa a segunda linha. A decisão do orçamento continua chegando inteira — os dois caminhos do motor tratam a recusa como "já havia aviso", sem trocar o bloqueio por um erro. E a escrita do aviso não depende de o índice já existir: para quem atualiza, tanto faz se o código novo sobe antes ou depois do banco — o portão de orçamento segue fechando, e a deduplicação vale a partir do momento em que o índice chega. Os dois tipos convivem abertos, como sempre: um relata que a IA parou, o outro que o gasto passou do aviso e ela segue.

  Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2265, com o refinamento do #2266).

- **A Central para de abrir em dobro os avisos de IA por título (Jev parado, saldo, endereço sem chave)** Quatro avisos da Central deduplicam pelo TÍTULO — o "O Jev parou de funcionar", o de IA sem saldo, a recusa por endereço sem chave da empresa e o aviso de laço do processamento de eventos. A pergunta "já existe um aberto?" e a escrita não eram atômicas, e os escritores rodam concorrentes: o worker roda tarefas em paralelo e o aviso do Jev chega por dois drenos. Dois avisos idênticos apareciam para o mesmo problema.

  Agora o banco é quem segura: um índice único parcial em `agent_inbox_items` (organização, kind e título, só enquanto o aviso está aberto) recusa a segunda linha, e os quatro escritores tratam a recusa como "já havia aviso" — nenhum deles para de avisar. Avisos que abrem UM POR NEGÓCIO (o espelho de estágio e o de etapa) continuam abrindo um por negócio, mesmo com o título repetido.

  Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2263).

- **A Central para de abrir em dobro o aviso de resposta a caso obsoleto quando a rota e o worker escrevem no mesmo instante** A resposta de um humano a um caso que já mudou de atendimento abre um aviso na Central ("Resposta registrada; atendimento mudou"), deduplicado por conversa. Dois escritores podiam chegar juntos — a rota que registra a resposta e o worker que percebe a fronteira de serviço velha — e os dois inseriam, porque a pergunta "já existe um aviso aberto?" e a escrita não eram atômicas.

  Agora o banco é quem segura: um índice único parcial em `agent_inbox_items` (organização, kind e conversa, só enquanto o aviso está aberto) recusa a segunda linha. A resposta do humano continua sendo registrada mesmo quando o aviso já existia — o caminho transacional isola o aviso num savepoint, para que a recusa do banco não derrube a resolução do caso. Avisos `job_dead` de tarefa e de cron seguem como sempre foram, um por ocorrência.

  Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2260).

- **Numa conversa de atendimento, preencher resposta pronta e abrir conversa ficam no contato da conversa** Numa conversa de atendimento, `crm_render_message_template` passa a preencher a resposta
  pronta apenas com os dados do contato daquela conversa: um `contact_id` ou um `lead_id` de
  outro contato é recusado, e sem nenhum dos dois o contato da conversa é usado. Em
  `crm_get_conversation`, toda conversa que não é do contato da conversa recebe a mesma
  recusa. Fora de uma conversa de atendimento (integração, MCP externo, rota HTTP), nada muda.

- **Numa conversa de atendimento, as consultas do agente a negócios, agenda, retornos e casos ficam no contato da conversa** Numa conversa de atendimento, as consultas do agente a negócios, compromissos, retornos,
  radar de risco e casos humanos passam a considerar apenas o contato daquela conversa. Um
  pedido sobre outro cliente recebe a mesma recusa que um identificador inexistente. A
  busca de contatos encontra o contato da conversa mesmo quando outros nomes parecidos vêm
  antes na lista.

  Fora de uma conversa de atendimento (integração, MCP externo, rota HTTP), nada muda.

- **A mensagem de um fluxo de follow-up apagado não sai mais depois da exclusão** Apagar um fluxo de follow-up pela tela encerra a inscrição, mas o turno que já estava na fila (ou adiado para a janela de envio, via cron) continuava valendo: o worker enviava a mensagem e só depois conferia se a inscrição ainda existia — o cliente recebia um passo de um fluxo que não existe mais, e o item terminava como concluído, sem aviso.

  Agora o turno confere a inscrição antes de qualquer efeito: se ela foi apagada, cancelada, pausada ou já saiu do nó, o envio é descartado em silêncio — a mesma regra que o caminho sem worker já aplicava. Nada muda para quem tem a inscrição viva no nó certo, e nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2261).

- **Os pedidos de privacidade, os honorários e a lista de conversas de uma conversa de atendimento também ficam do lado do contato do turno** O #2182 escopou ao contato da conversa as quatro leituras do Atender, mas deixou três
  ferramentas e um conserto de página de fora. Um pedido de EXCLUSÃO de outro cliente
  (`crm_list_privacy_requests`) continuava chegando ao modelo como instrução de "não insista
  com esta pessoa", e o contrato e as parcelas de honorários de um caso que não é desta
  conversa (`crm_get_honorarios_contrato`, `crm_list_honorarios_parcelas`) continuavam
  trazendo valor, percentual e repasse para o lado de cá. As três agora leem
  `ctx.contatoDoTurno`: a lista de privacidade filtra a própria consulta pelo contato do
  turno, e o contrato e as parcelas são recusados — antes da consulta — quando o caso não
  é deste cliente, com a mesma resposta para caso que não existe, caso de outra organização
  e caso de outro cliente.

  `crm_list_conversations` também passa a filtrar o contato NA CONSULTA, e não mais na
  página que o handler já tinha truncado: com a conversa mais antiga do mesmo cliente fora
  da primeira página, o agente ouvia que não havia mais nada. No predicado, cursor e
  `has_more` voltam a valer, porque a página já é do contato. O `404` de um uuid
  inexistente em `crm_get_conversation_history` passa a ser a MESMA recusa de uma conversa
  de outro cliente, em vez de dois estados distintos para o mesmo "não é seu para ler".

  Fora de uma conversa de atendimento — rota HTTP, MCP externo, agente sem conversa —, os
  pedidos de privacidade, os honorários e o histórico seguem como antes. A lista de conversas
  muda num ponto: `GET /api/v1/conversations` passa a aceitar `?contact_id=` (antes o parâmetro
  era ignorado e a resposta era a lista da organização inteira), e `crm_list_conversations` com
  `contact_id` explícito passa a filtrar no banco, então cursor e `has_more` descrevem as
  conversas daquele contato. O filtro só estreita a lista, nunca a amplia.

  Contribuição de @webtecnica (#2271, refs #2184).

- **A reunião remarcada para mais longe volta a receber o lembrete da data nova** Quando um lembrete já tinha saído e a reunião era remarcada para uma data mais distante, a data nova ficava sem esse lembrete, porque o sistema guardava apenas que ele já tinha sido enviado, sem dizer para qual data. Agora o lembrete volta a valer para a data nova e sai uma única vez, na hora certa.

  Para não mandar duas mensagens em sequência, o lembrete só volta quando a hora dele na data nova fica a pelo menos metade do seu intervalo depois do último envio. Para o lembrete da véspera, isso quer dizer 12 horas: a reunião empurrada para o mesmo horário do dia seguinte recebe a véspera nova, e a reunião empurrada em 30 minutos logo depois de a véspera sair não recebe uma segunda. Remarcar para mais perto não reenvia nada, e o lembrete cuja hora já tinha passado no momento da remarcação continua não saindo. Reuniões remarcadas antes da atualização para a 1.71.0, quando o sistema ainda não registrava a hora da remarcação, seguem como antes.

  Contribuição de @webtecnica (#2249, refs #2243).

- **O Testar do agente mostra a resposta mesmo fora do horário de envio, com um aviso** Fora do horário de envio configurado, o botão Testar do agente escondia a resposta: a regra de ritmo de envio (horário, aquecimento do número e limite diário) barrava o candidato também no teste, onde nada é enviado. Agora o Testar mostra a resposta com o aviso de que, em produção, ela não sairia naquele momento, e o registro da verificação diz que essa regra não foi aplicada ao teste, em vez de dizer que passou. O envio real não muda: fora do horário ele continua barrado. Só essa regra é afrouxada, e só no Testar; a janela de 24 horas do WhatsApp, o descadastro e as regras de conteúdo seguem na mesma cadeia de antes, e o rascunho do modo assistido continua barrado fora do horário.

  Na aba Execuções, as rodadas do Testar passam a aparecer como teste. Os rascunhos do modo assistido, que atendem conversas reais, continuam aparecendo como produção. E um teste que não produziu resposta deixa de aparecer como aprovado.

  Contribuição de @leadframeassessoria-lab (#2254, substitui #2252).

- **O follow-up pausado volta a andar quando o atendimento humano termina** Um follow-up que estava no passo de enviar mensagem e ficava pausado porque uma pessoa assumiu o atendimento perdia o envio em silêncio: o turno rodava durante a pausa, era descartado, e nada ficava registrado. Quando o atendimento era retomado, o motor continuava achando que aquele turno estava em voo — só conferia de novo, nunca mandava outro — e o fluxo ficava parado no mesmo passo até o sistema marcá-lo como morto por tempo esgotado, com um motivo que não era o verdadeiro.

  Agora o descarte durante a pausa deixa o mesmo rastro que a suspensão da conta já deixava: na retomada, o passo é reenfileirado e a mensagem sai normalmente. Follow-ups encerrados, passos que já andaram e fluxos apagados continuam descartados em silêncio, como antes — e nada precisa ser feito na instalação.

  Contribuição de @webtecnica (#2277, refs #2262).

## [1.71.0] — 2026-10-04

### Adicionado

- **Card do funil e dossiê do lead ganham a ação "Abrir conversa"** Lead recebido por webhook chega ao funil com telefone e sem conversa nenhuma, e nem o card nem o dossiê ofereciam jeito de começar o atendimento: o atalho só existia quando a conversa já estava lá. Agora o card e o painel do lead mostram o botão "Abrir conversa" quando o negócio tem contato — ele chama a MESMA rota que a tabela de contatos usa (POST /api/v1/conversations/open-with-contact), que reabre a conversa que já existe ou cria a que falta, e leva para a Inbox na conversa aberta. Conversa já vinculada continua sendo um elo direto, sem ida ao servidor. Sem telefone, o botão fica desabilitado na linha dizendo o motivo, e nenhuma chamada sai do navegador. Nenhuma mudança de banco: os dados já estavam no payload do quadro.

  Contribuição de @webtecnica (#2207, refs #1993).

- **Criar negócio para um contato que já tem outro aberto no mesmo funil agora avisa, sem bloquear** Na tela do funil, o diálogo de novo negócio para no aviso, com link para o negócio aberto, e pergunta se deve criar mesmo assim; recusar não cria nada. Pelo Inbox, o aviso chega depois da criação. A API POST /api/v1/leads continua criando e devolvendo 201, e acrescenta meta.avisos=["negocio_aberto_existente"] e meta.negocio_aberto_existente {id,title}. Funil diferente ou negócio encerrado não avisam. Nenhuma mudança de banco.

  Contribuição de @webtecnica (#2218, refs #1751).

- **Análise do funil na API — conversão por etapa, dias até fechar e ganho × perda por origem** A rota `GET /api/v1/metrics/funil` responde as três perguntas básicas do funil que hoje não têm resposta: quantos passam de cada etapa para a seguinte (sempre com a amostra da própria linha, e `null` — nunca `0` — quando não há medida), quanto tempo leva do primeiro contato ao fechamento (mediana e quartis, só dos ganhos, com a palavra "mediana" no payload) e de que origem vêm os que fecham (ganhos × perdas por origem, com valor somado **por moeda**, sem total cruzando moedas). A conversão é reconstruída das passagens de etapa já registradas — as feitas à mão e também as feitas pelo agente, pelo handoff e pela agenda: nenhuma tabela nova, nenhuma migration.

  A contra-métrica vem no mesmo corpo, como manda a doutrina: turnos até o desfecho e opt-outs medidos na mesma janela pelo `fn_atrito_metrics` que alimenta o Índice de Atrito — se essa leitura falhar, os números vêm nulos com a razão escrita, não somem e não viram zero.

  Ainda não há painel em `/app/metrics`: esta entrega é a consulta (rota + contas testadas sem banco); a tela é o passo seguinte da mesma issue.

  Contribuição de @webtecnica (#2222).

- **A CA do Supabase pode ser declarada uma vez no .env, e o diagnóstico passa a testar o TLS do banco** Quem exige verificação de certificado na conexão com o banco do Supabase agora declara uma linha no `.env`: `SUPABASE_SSL_ROOT_CERT=/root/certs/prod-ca-2021.crt`. Com o arquivo existindo, o kit o monta somente leitura no app, no worker, no agendador (onde o Node soma a CA à confiança) e nos psql temporários de instalação, atualização e backup. O `healthcheck.sh` ganhou o passo "TLS do banco", que testa a conexão com verificação total da cadeia e do nome do servidor.

  Sem a linha, o app, o worker e os psql funcionam como antes. O healthcheck mostra uma linha informativa dizendo que a chave é opcional, sem aviso e sem pedir download nenhum; no single-server ele diz que o passo não se aplica. A verificação de certificado nunca é desligada.

  Para quem declara a CA: nos psql do kit, uma connection string com `sslmode=require` passa a verificar a cadeia, porque a libpq trata `require` como `verify-ca` quando há uma CA. Uma CA errada faz a instalação, a atualização e o backup falharem fechado. Sem `sslmode` na string, nada muda.

  O diagnóstico da connection string no `install.sh` também passou a explicar a falha de certificado com o nome da variável, sem confundir senha errada ou queda de rede com problema de certificado.

  Contribuição de @webtecnica (#2215, fecha #829).

- **O Jev pode conferir na conversa o campo personalizado que a IA vai gravar** Nova tarefa do Jev, "Conferir o campo antes de a IA gravar": antes de o agente de IA gravar um campo personalizado do negócio, o valor é conferido nas mensagens do cliente daquele turno. Número, data, e-mail e valor em dinheiro são procurados no texto, sem chamada nenhuma; só o que sobra vai numa única pergunta ao Jev. O campo que o cliente não disse deixa de ser gravado e a IA é orientada a perguntar a ele; os outros campos da mesma chamada seguem gravando.

  A tarefa nasce DESLIGADA: ela lê as mensagens do turno juntas, e por isso só roda com o aceite da conversa e depois de alguém ligá-la no cartão do Jev (IA › Provedores). Desligada, sem credencial ou com o Jev fora, o campo é gravado como antes.

  Vale só para o agente de IA interno (o Conversador e o Operador). A tela, a API e as integrações MCP por token gravam como sempre, sem conferência e sem leitura extra. A chamada aparece em IA › Execuções e o gasto em Uso de IA.

  Contribuição de @webtecnica (#2245), a partir da issue #2234 de @TOSTES-LAB.

- **Ajuste o visual do sistema com CSS personalizado** A página Marca da instalação passa a permitir regras CSS cosméticas para ajustar login e telas das organizações, com validação de segurança e sem editar arquivos nem reiniciar o servidor. Se uma folha deixar as telas ilegíveis, abra a página com `?sem_css=1` no endereço para vê-la sem o CSS personalizado e desfazer o ajuste.

  Contribuição de @rodrigotxt (#2241).

- **Pedido de parar de receber mensagens ou de falar com uma pessoa dito em áudio passa a abrir aviso na Central** Um "não quero mais receber mensagens" falado chegava ao CRM com o texto vazio, e nem o bloqueio da entrada nem o Jev o enxergavam. Agora, quando a transcrição de um áudio do cliente fica pronta, a mesma regra que reconhece o pedido por escrito roda sobre o transcrito e, onde ela não reconhece e a tarefa de pedidos do Jev está ligada, o Jev é perguntado como numa mensagem de texto. O resultado é só um aviso na Central. O aviso da regra ("Um cliente pediu para parar de receber mensagens num áudio" ou "...para falar com uma pessoa num áudio") abre com a tarefa do Jev ligada ou desligada. O aviso só abre onde o atendimento automático rodaria naquela conversa: há um agente não pausado no número, a IA pode responder, o contato não está com uma pessoa nem bloqueado, e a conversa não é de grupo.

  A transcrição de um áudio não bloqueia o contato. O bloqueio corta todo envio ao contato (resposta do agente, funil, follow-up, campanha) e só um admin o desfaz, à mão (Contatos › Desbloquear); uma transcrição pode errar, e o erro dela somaria com o da regra. É a mesma política do texto digitado, onde o pedido ambíguo escala para uma pessoa e não bloqueia. Quem quiser parar de receber continua bloqueado ao responder PARAR por escrito, e o aviso diz isso à equipe.

  Contribuição de @webtecnica (#2246, refs #2233).

- **Taxa histórica de ganho por etapa, sugerida ao gestor para calibrar a probabilidade** Quem monta o funil passa a ver, ao lado do campo de chance de cada coluna, **quantos negócios encerrados passaram por ela e quantos foram ganhos** — a contagem com o denominador sempre visível e o período de onde o número veio («nos últimos 12 meses»). Abaixo de 10 casos a fração aparece sem convite («poucos casos para sugerir»); uma coluna sem histórico diz «sem dados», nunca 0%.

  Nada é gravado sozinho: o botão «Usar N%?» escreve pelo MESMO caminho de digitar no campo, quem aceita o número é quem opera, e `crm_lead_scores` não é tocado.

  Contribuição de @webtecnica (#2221).

- **Webhook de saída ganha os gatilhos de ganho, perda, reabertura e troca de responsável** Quem liga o CRM a um ERP, ao faturamento ou a uma planilha de comissão agora recebe um evento quando um negócio é **ganho** ou **perdido**, quando um lead encerrado **reabre** e quando o **responsável muda** — e recebe o mesmo evento com o mesmo corpo em todo caminho que muda um negócio que já existe: arrastar o card, o botão Ganhou/Perdeu, o mover em lote, o fechamento da IA (`crm_close_demand`) ou o mover de uma automação. Antes, o arrasto emitia `lead.stage_changed` e o botão não disparava regra nenhuma: o fato era o mesmo e o webhook dependia do botão.

  Limite conhecido: criar o negócio já numa etapa de ganho ou perda, ou já com responsável, **não** emite esses eventos — eles só nascem quando um negócio existente muda.

  Os quatro gatilhos novos aparecem no seletor de automações com os campos de condição do próprio negócio. Neles, por ora, a automação não pode "Atribuir a um atendente" nem "Criar/mover lead no funil": a própria mudança dispararia a automação de novo, sem fim. O corpo da troca de responsável **não** leva UUID de usuário nenhum.

  Duas mudanças aditivas valem também para quem já tem regras de negócio (`lead.created`, `lead.stage_changed`): o lead no corpo do webhook passa a trazer `lost_reason` e `closed_at`; e a opção "Incluir o responsável no corpo", que antes só valia em compromisso, passa a incluir o responsável do negócio (`owner`: `kind`, `id`, `name`). Quem valida o corpo com lista fechada de campos precisa aceitar os dois.

  Contribuição de @webtecnica (#2211, fatia da proposta #1528).

### Alterado

- **O limiar de sentimento do agente se ajusta pela tela, e o medidor de clima passa a medir hostilidade com o atendimento, não o assunto** A tela do agente ganha o cartão "Limiar de sentimento": a nota abaixo da qual o clima da conversa é considerado fechado e ela passa para uma pessoa. Antes, o valor só mudava por SQL direto no banco. O padrão continua 0,3, e o limiar não muda para quem não mexer nele. Nota mais alta manda mais conversas para uma pessoa; nota mais baixa deixa só a hostilidade forte acionar a passagem.

  O que muda para todos os agentes, sem ajuste nenhum, é o texto do medidor de clima quando quem mede é a IA de linguagem (o caminho padrão). Ele deixou de presumir e-commerce e passa a medir hostilidade com o atendimento (ameaça, xingamento, pedido agressivo de falar com uma pessoa). Quem só descreve o problema que o trouxe, como em advocacia, saúde ou assistência técnica, fica no neutro e não aciona a passagem. Quem atende e-commerce deve ver menos passagens para uma pessoa por decepção com produto ou entrega; para voltar a passar mais conversas, suba o limiar.

  Quando o clima é medido pelo Jev (Jev decidindo, ou sem IA de linguagem configurada), a escala dele não mudou e ainda lê "reclamando" abaixo de 0,3; o acompanhamento está na #2219. Contribuição de @webtecnica (#2216, refs #2209).

### Corrigido

- **O selo "Consultado por" do acervo de conhecimento volta a mostrar os assistentes que usam cada material** Na tela de materiais da base de conhecimento, todo material aparecia com "Consultado por: nenhum assistente ainda", mesmo quando a versão publicada de um assistente o usava em conversa. A consulta da tela era recusada pelo banco por ambiguidade, e a recusa era descartada em silêncio. Agora a tela lê a versão publicada de cada assistente e mostra quem consulta o material. Se a consulta falhar por outro motivo, a tela continua abrindo, e a causa fica registrada no log do servidor. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2238, fecha #2236, relatada por @kristhianlumai-lgtm).

- **A recusa "o atendimento desta conversa mudou" para de citar um link que não existe em compromisso sem Meet** A frase que `meet_conversation_stale` mostra na tela dizia "O atendimento desta conversa mudou **depois que o link foi criado**". Em compromisso PRESENCIAL ou POR TELEFONE não existe link nenhum, então a frase afirmava um fato que não aconteceu — e é a frase que aparece no fluxo natural do atendente (resolver a conversa → marcar o compromisso → mandar os dados), porque quem recusa é `fn_meet_boundary_current`, que compara `service_revision`, `current_demanda_id`, `demanda.revision`, `fechada_em` e o status da conversa, nunca um link.

  A frase passa a dizer só o que é verdade nos dois casos: "O atendimento desta conversa mudou. Escolha a conversa atual e autorize o envio de novo." Nenhuma mudança de fluxo, de status ou de recusa — só a frase. As traduções (`es` no dicionário e `en.json`) acompanham a chave nova.

  O ponto de produto que o relator também sugeriu (texto próprio quando o atendimento está ENCERRADO, ou o envio abrir um novo atendimento) continua em aberto: escolher entre as duas é decisão de mantenedor, e este fragmento não toma nenhuma delas.

  Contribuição de @webtecnica (#2244, refs #2188, relatada por @amexgestao).

- **O aviso de envio retido na conversa julga cada envio pela janela certa, e o aviso de escalação dentro de um follow-up segue a janela de disparo** O registro de envio retido passa a guardar se a mensagem segurada era uma resposta a quem escreveu ou um disparo (follow-up, campanha). O aviso de retenção da conversa usa a janela de resposta para respostas e a janela de disparo para disparos, e a hora que ele mostra é a da janela do envio retido. Antes todo envio retido era tratado como resposta. O aviso de que uma pessoa vai atender, quando nasce dentro de um follow-up, agora é avaliado pela janela de disparo. Com as janelas padrão (7h às 22h nas duas) nada muda. Registros antigos continuam lidos como resposta. Nenhuma ação do operador.

  Contribuição de @webtecnica (#2227, refs #2112).

- **Atualização com o registro de imagens fora do ar não derruba mais a instalação** Clicar em **Atualizar** num momento em que a VPS não alcançava o registro de imagens (DNS saturado, rede instável) podia deixar o CRM fora do ar: o update parava os serviços, não conseguia baixar a versão nova, tentava construir as imagens na própria VPS, gastava a memória inteira dela e terminava com app, worker e proxy parados — 502 para todo mundo até alguém reiniciar o Docker à mão.

  Agora, antes de parar qualquer coisa, o update confere se as quatro imagens da versão nova existem no registro. Se não existem, ou se o registro não responde, ele recusa sem começar (código 3) e a versão atual segue no ar, intocada. A construção local deixa de acontecer sozinha quando quem falhou é o registro; continua disponível de propósito, com `DESKCOMM_BUILD_LOCAL=1`.

  Se a atualização falhar depois de trocar a versão — inclusive quando o app responde mas o worker, o agendador ou o proxy não sobem —, os pins de versão do `.env` voltam sozinhos para a versão anterior e os serviços sobem nela. O banco nunca é revertido. Toda execução deixa um resumo em `.deskcomm-update-diagnostico.log`, e o healthcheck passou a ter prazo, em vez de ficar preso em "▶ Containers" quando o Docker não responde.

  Nada é preciso fazer na instalação: a mudança chega com a próxima atualização.

  Contribuição de @webtecnica (#2208, fecha #1955).

- **A conversa passada para humano só porque o áudio ainda não tinha transcrição volta sozinha ao agente quando a transcrição chega** Quando a transcrição ou a descrição de uma mídia atrasava (por exemplo, sem saldo no provedor) e o agente passava a conversa para humano porque não havia texto, a conversa ficava parada até alguém clicar em "Devolver ao automático", e o motivo exibido seguia dizendo que não havia transcrição. Agora, quando a transcrição chega e ninguém assumiu nem respondeu ao cliente, a conversa volta ao agente pela mesma função do botão e o agente responde ao áudio. Se uma pessoa já assumiu ou já respondeu (pelo inbox ou pelo celular), a conversa fica com ela e só o motivo é corrigido. O pedido do cliente por um atendente, feito por escrito, continua permanente. Contribuição de @webtecnica (#2217, fecha #2210).

- **O lembrete de véspera não sai mais na hora quando a reunião é marcada com menos de 24h, nem sai duas vezes** Lembrete cuja hora já tinha passado quando a reunião foi marcada não sai mais, e isso vale para qualquer lembrete, inclusive o principal: reunião marcada com menos antecedência que o lembrete não recebe esse lembrete (por exemplo, num tipo de compromisso que só tem o lembrete de véspera, a reunião marcada para o dia seguinte não recebe nenhum). O mesmo lembrete não sai duas vezes para o mesmo compromisso, mesmo quando a gravação do envio falha: se o registro não grava, a rodada não envia e tenta na seguinte, e o lembrete que falha no envio depois de registrado não é reenviado. Contribuição de @webtecnica (#2226, refs #2223).

- **A marca da instalação aparece também no login** O nome configurado em Administração → Marca passa a aparecer também sob o título Entrar, sem editar a configuração do servidor.

  Contribuição de @rodrigotxt (#2241).

- **O painel de Provedores mostra quem de fato ouve o áudio do cliente, e não mais whisper-1 fixo** O ponto "Ouvir o áudio do cliente" anunciava `whisper-1` para toda organização, inclusive para a que não tem chave OpenAI e transcreve pelo próprio modelo de conversa (por exemplo, Gemini com a chave do Google validada). O painel passa a rodar a mesma escada de transcrição do worker e mostra o degrau que vai rodar: o serviço da instalação (`TRANSCRIPTION_API_KEY`), a chave OpenAI com o modelo de transcrição em vigor, ou o modelo de conversa da organização quando ele declara a capacidade de áudio. Sem nenhum dos três, mostra "—" e o motivo, traduzido no idioma de quem usa a tela. A ordem dos degraus não mudou. Contribuição de @webtecnica (#2205, refs #2190).

- **A reunião remarcada para menos de 24h não recebe mais o lembrete de véspera minutos depois da remarcação** Quando uma reunião marcada com dias de antecedência era remarcada para o dia seguinte, o lembrete de véspera saía logo depois da remarcação, porque o sistema ainda media a partir da data em que a reunião foi criada. Agora vale o momento em que o horário atual foi marcado: o lembrete cuja hora já tinha passado nesse momento não sai, e o lembrete que ainda estava por vir continua saindo na hora certa. Reuniões que nunca foram remarcadas não mudam de comportamento. Contribuição de @webtecnica (#2239, fecha #2230).

- **Quatro bibliotecas internas sobem de versão para fechar avisos de segurança** O aviso automático de segurança do repositório apontou quinze alertas em quatro bibliotecas que o sistema usa por dentro. Três vão na instalação: `ip-address` (lida com endereços IP no limite de requisições do servidor MCP), `fast-uri` (interpreta endereços na validação de esquemas) e `brace-expansion` (expande padrões de nomes de arquivo). A quarta, `undici`, é usada só nos testes do projeto.

  Todas subiram para versões corrigidas dentro da mesma linha que já usavam (`ip-address` 10.7.3, `fast-uri` 3.1.8, `brace-expansion` 1.1.21 e 5.0.12, `undici` 8.11.2). Nenhuma tela, nenhuma configuração e nenhum comando mudam: quem opera uma VPS só precisa atualizar como de costume. (#2214)

- **Acesso só de leitura ao painel de plataforma deixa de escrever nas tabelas de IA, agenda, campanhas, CRM, financeiro, vendas e comissões** A 0508 e a primeira fatia fecharam a escrita de quem entra no painel de plataforma com `scope=support_readonly` em parte do banco, mas 45 regras de escrita criadas nos blocos seguintes ainda aceitavam a checagem que ignora o scope do JWT: agentes de IA, base de conhecimento, disponibilidade e agenda, campanhas, catálogo, funil e tarefas do CRM, honorários, sessões de voz, os moldes de lançamento recorrente, contas, formas de pagamento, plano de contas, vendas, comissões, lançamentos financeiros e fidelidade.

  Agora todas exigem `scope=full` para escrever. A leitura continua como estava — `support_readonly` segue enxergando os dados, só não altera; os moldes recorrentes e as nove tabelas de dinheiro (contas, formas de pagamento, plano de contas, vendas e seus itens, regras de comissão, comissões, lançamentos e fidelidade) ganharam um par de regras (ler/escrever), porque nenhuma tinha regra de leitura própria. Membros da organização e platform admin `full` escrevem exatamente como antes.

  Nada é preciso fazer na instalação.

  Contribuição de @Tong-bit-art (#2202, continua #2115).

## [1.70.0] — 2026-10-03

Esta versão junta 106 mudanças. Cada item é curto para caber na tela de atualização; a explicação completa está no PR citado. Nenhuma exige ação na atualização.

### Adicionado

- **Fluxo de follow-up ganha caixas de mover o card no funil e gravar tag** Duas caixas novas no editor: "mover lead no funil" e "editar tag do lead". Contribuição de @webtecnica (#2181).

- **Token de API administra fluxos de follow-up, agentes, prospecção e tipos de agendamento** Vale para o token `dsk_` com papel `admin`; a escrita vai para rascunho e publicar continua pela tela. Contribuição de @webtecnica (#2028).

- **A assinatura (HMAC) de uma fonte de captação agora se liga pela tela** Em Automações › Fontes, seção "Assinatura (HMAC)": o segredo aparece uma vez e o endereço passa a recusar envio sem assinatura. Contribuição de @maclevison (#2023).

- **Mensagens enviadas ao cliente podem mostrar quem fala (atendente ou IA) em negrito, na linha de cima** Liga em Configurações › Distribuição de atendimento; nasce desligado. Contribuição de @webtecnica (#2079), a partir da issue #2066 de @Cgaban.

- **O balão do áudio avisa "Transcrevendo…" enquanto a transcrição é gerada** Contribuição de @webtecnica (#2154).

- **Cadastrar, na captação, o campo que o formulário mandou** Em Webhooks › Leads recebidos, o botão "Cadastrar como campo do lead". Contribuição de @paulolimajr77 (#2051).

- **O chat de casos mostra os trechos do acervo ligados à pergunta** Os trechos aparecem ao lado; a IA ainda não os usa para responder. Contribuição de @webtecnica (#1952).

- **Venda de quem veio de anúncio da Meta pela sua página agora é reportada ao pixel, com o valor lido da conversa** Vale para quem chega com UTM de anúncio da Meta; sem valor no negócio, a IA lê o valor escrito na conversa. Contribuição de @agencyspeedagend-del (#2076).

- **Cada etapa do funil pode avisar a Meta, não só a venda** Em Configurações › Conversões, o cartão "O que cada etapa do funil informa à Meta". Contribuição de @agencyspeedagend-del (#2087).

- **Um guia de IA passa a orientar o uso diário do CRM pela interface** Contribuição de @italopabloferreria (#2088).

- **O "digitando…" do agente passa a aparecer também no número oficial (WhatsApp Cloud API)** Contribuição de @lauropilatti-c01 (#2054).

- **O segundo fator pode ser exigido de qualquer nível de papel, com carência** Em Configurações › Segurança: nível mínimo de papel e carência de 0 a 30 dias. Contribuição de @webtecnica (#2163).

- **Extensão declarativa pode contribuir um tema (gancho)** Contribuição de @webtecnica (#2091).

- **A janela de esfriando de cada etapa vira um campo editável** Atenção: diminuir a janela de uma etapa cheia esfria vários negócios de uma vez na passada seguinte do radar. Contribuição de @webtecnica (#2161), construída sobre a proposta de @franceschini-lucas (#1532).

- **O cartão do Jev avisa quem é da área da saúde** Contribuição de @webtecnica (#2085).

- **Uma rede a mais para a LGPD alcançar os módulos instalados** Contribuição de @webtecnica (#2083).

- **Campos do formulário nas mensagens das automações** `{{servico}}` vale como atalho do campo do lead, e os campos do funil viram botões na ação de WhatsApp. Contribuição de @paulolimajr77 (#2051).

- **O operador escolhe quais empresas da prospecção entram na fila antes de iniciar as abordagens** O padrão continua sendo todas marcadas. Contribuição de @webtecnica (#2048).

- **Quem responde PARAR tem o negócio aberto fechado sozinho, com o motivo "Pediu para não receber mensagens"** Contribuição de @paulolimajr77 (#2049).

- **O fluxo de silêncio pode esperar antes de recomeçar para quem já passou por ele** Com a pausa em 0 (o padrão), nada muda. Contribuição de @jmpo (#2037).

- **A pausa do gatilho de silêncio pode contar a partir do último envio do fluxo** Contribuição de @jmpo (#2037).

- **Portugal entra no registro de países, ainda fora do seletor até a citação do RGPD ser revisada** Contribuição de @webtecnica (#2084), com revisão de @maclevison.

- **O pino de localização do WhatsApp pode chegar com a rua e a cidade aproximadas** Exige uma chave da Geocoding API do Google em Agente de IA › Provedores › Mapas; sem chave, nada muda. Contribuição de @jmpo (#2043).

- **Cada empresa escolhe quanto tempo a IA espera depois de uma resposta pelo celular** Em Configurações › Atendimento, de 5 minutos a 24 horas; o padrão continua 60 minutos. Diagnóstico e teste de @gaberaldo-svg (#2005).

- **A proteção contra promessas considera as condições comerciais consultadas pelo agente** Contribuição de @vitorlacerdadigital (#2010), construída sobre o caminho aberto por @webtecnica no #1981.

- **Dá para ajustar o ritmo de uma campanha de prospecção pausada** Contribuição de @paulolimajr77 (#2104).

- **Na Prospecção, dá para mexer na fila de uma campanha pausada e excluir as empresas desmarcadas** Contribuição de @paulolimajr77 (#2106).

- **Na Prospecção, a empresa pode entrar no funil só quando for abordada** Campanhas novas nascem nesse modo; as já criadas seguem como eram. Contribuição de @paulolimajr77 (#2105).

- **A distribuição de atendimento ganha o modo por menor carga** Em Configurações › Atendimento. Contribuição de @webtecnica (#1711).

- **O gatilho de silêncio aceita um máximo — o fluxo só começa enquanto o silêncio for recente** Sem o máximo (o padrão), nada muda. Contribuição de @jmpo (#2037).

- **O texto do áudio aparece no balão da conversa, logo abaixo do player** Contribuição de @webtecnica (#2060), a partir do pedido de @Alencaf.

- **As varreduras de LGPD, RLS e security definer agora veem os módulos instalados** Contribuição de @webtecnica (#2201).

### Alterado

- **O seletor de etiqueta do atendimento passa a ter prova com dublês que respeitam a organização ativa** Contribuição de @webtecnica (#2045).

- **A resposta do agente com Anthropic custa menos — os passos do laço de ferramentas leem do cache** Contribuição de @jmpo (#2038).

- **A bolinha colorida no avatar da lista de conversas diz o que significa** Contribuição de @valterhjr (#2075).

- **Migration nova se descreve no próprio arquivo e para de conflitar com as outras** (#2149)

- **A busca de prospecção passa por um despachante de provedor, e a Apify continua sendo a fonte** Contribuição de @webtecnica (#2174).

### Corrigido

- **Sessão volta a ser renovada na tela de conta suspensa** Contribuição de @webtecnica (#2019).

- **A regra "admin de plataforma pode escrever nesta empresa?" agora é UMA função** Contribuição de @webtecnica (#2027).

- **"Mandar ao cliente" passa a enviar compromisso que não é Google Meet** Valia para compromisso presencial ou de qualquer local que não seja Google Meet. Contribuição de @Tong-bit-art (#2192); causa medida no banco por @amexgestao.

- **O calendário de "Novo agendamento" não abre mais num mês sem horário livre** (#2058)

- **A anonimização de um contato não é mais desfeita por um worker de mídia ou de clima que estava no meio do trabalho** (#2191) Construído sobre o trabalho de @webtecnica (#2030).

- **Campos diferentes gravados ao mesmo tempo no mesmo negócio não se apagam mais** Contribuição de @paulolimajr77 (#2009).

- **Aplicar uma proposta deixa de apagar onze configurações do assistente** Contribuição de @webtecnica (#2145).

- **O registro de auditoria passa a ser só-inclusão para todo papel do banco, inclusive o do worker** (#2137)

- **Quem responde pedindo para parar (ex.: "Parar não é daqui") recebe a confirmação de saída, e não o texto de "passei seu pedido para um atendente"** Contribuição de @paulolimajr77 (#2050).

- **Envio das boas-vindas numa empresa já configurada não mostra mais "db_error"** Contribuição de @webtecnica (#2152).

- **O vazio da aba Grupos do inbox explica quais grupos entram e a partir de quando** Contribuição de @webtecnica (#2200).

- **O banco deixa de acusar os avisos de segurança do painel do Supabase** Contribuição de @usebeehub (#2125).

- **O gatilho de silêncio não tenta mais inscrever, a cada minuto, quem já está num follow-up** Contribuição de @jmpo (#2107).

- **Boas-vindas gravam na organização da aba, não na que estava ativa** Contribuição de @webtecnica (#2072).

- **Boas-vindas não renomeiam mais uma organização que já terminou o onboarding** Contribuição de @webtecnica (#2143); relato de @trackerrm122-hub (#2113).

- **Fonte de captação com assinatura só aceita envio que ela consegue conferir** Se o segredo não puder ser lido nesta instalação, gere a assinatura de novo no painel da fonte. (#2136)

- **A Central para de abrir o aviso de mídia não lida em dobro quando dois workers rodam juntos** Contribuição de @Tong-bit-art (#2185).

- **Comanda nasce na moeda da organização, não mais em real fixo** Contribuição de @webtecnica (#2173).

- **Atendimentos sem comanda mostram a moeda da empresa, não mais real fixo** Contribuição de @webtecnica (#2159).

- **A conversão de venda clique-para-WhatsApp para de ser recusada pela Meta** Para a venda passar, preencha em Configurações › Conversões o ID da Página (ou da conta do WhatsApp Business). Contribuição de @webtecnica (#2197).

- **O cálculo de custo do runtime nativo legado reconhece os ids da OpenRouter e não chama de grátis o preço que não conhece** Contribuição de @webtecnica (#1963).

- **O dossiê do follow-up não lê mais falha do motor como contato com o cliente** Contribuição de @webtecnica (#2081), a partir da issue de @hudson-souza-mkt (#2014).

- **Empresas paradas deixam de virar uma lista de ids na URL que crescia sem teto (5 varreduras)** Contribuição de @webtecnica (#2122), vindo do #2022.

- **Encerrar uma conversa com a tela desatualizada não deixa mais o CRM lento** Contribuição de @AlecsanderAbreu (#2123).

- **Escape no nome e na chance da etapa volta a descartar o rascunho, não a gravar (#2164)** Contribuição de @webtecnica (#2172).

- **As conversas, o histórico e os pedidos numa conversa de atendimento também só alcançam o contato do turno** Contribuição de @webtecnica (#2182).

- **Exportação LGPD do titular passa a incluir a transcrição/texto extraído da mídia** Contribuição de @webtecnica (#2020).

- **O resumo que o agente grava ao fim de cada resposta pede uma correção antes de repetir a resposta inteira** Contribuição de @jmpo (#2039).

- **A ficha do negócio e o painel do CRM não desfazem mais o que outra pessoa alterou** Contribuição de @webtecnica (#2151).

- **A trava de imutabilidade da versão publicada do agente cobre proposal_ai_draft_enabled e inbound_debounce_ms** Contribuição de @webtecnica (#2013).

- **O aviso ao cliente na passagem para atendente humano não usa mais travessão** Contribuição de @webtecnica (#2026).

- **Roma entra nos fusos, e o fuso escolhido no primeiro acesso aparece igual em Configurações** Contribuição de @fabianmartinelli-fm (#2187).

- **O guia de montagem para escritório de advocacia deixa de prometer a passagem automática por assunto jurídico** (#2157)

- **A dica do laço na ação de texto do follow-up deixa de mostrar um "e" em português para quem usa em espanhol** Contribuição de @ajsaranetaeu (#2177).

- **Retenção, escalação e resposta aprovada usam a janela de RESPOSTA pelo tipo** Contribuição de @webtecnica (#2031).

- **Janelas (Dialog) com conteúdo alto rolam por dentro, e os botões ficam alcançáveis** Contribuição de @webtecnica (#2055).

- **O agente deixa de perder a resposta quando o modelo repete o objeto JSON** Contribuição de @webtecnica (#2144).

- **O comentário da timeline do negócio não promete mais o valor anterior no log de auditoria** Contribuição de @webtecnica (#2024).

- **A busca e a ficha de contato numa conversa de atendimento só alcançam o contato do turno** Contribuição de @webtecnica (#2175).

- **O media-derive-worker não grava mais transcrição em mensagem já anonimizada** Contribuição de @webtecnica (#2030).

- **O negócio que nasce de uma mensagem no Instagram ou no Facebook não aparece mais como vindo do WhatsApp** Contribuição de @paulolimajr77 (#2199).

- **A nota interna de uma conversa deixa de poder ser editada ou apagada por um colega que não a escreveu — só o autor ou um manager+ pode** Contribuição de @webtecnica (#2080).

- **OpenRouter: quatro auxiliares do agente leem o JSON do modelo mesmo com cerca de código, prosa ou repetição** Contribuição de @webtecnica (#2096).

- **Quem tem acesso só de leitura ao painel de plataforma deixa de conseguir alterar empresas e outros dados pela API** Contribuição de @webtecnica (#2078).

- **No número oficial intermediado, o pino que chegou sem coordenadas é recuperado sozinho** Contribuição de @jmpo (#2043).

- **A barra do prazo das telas de LGPD conta até o fim do dia, e não até a meia-noite do servidor** Contribuição de @Tong-bit-art (#2170).

- **A coluna "Vence em" da lista de LGPD para de anunciar atraso antes do prazo vencer** Contribuição de @Tong-bit-art (#2176).

- **O prazo de uma solicitação LGPD passa a sair no dia certo no e-mail ao DPO, e a lista deixa de marcar "Vencido" na véspera** Contribuição de @Tong-bit-art (#2101).

- **O painel da instalação deixa de contar prazo de LGPD a mais e de anunciar atraso na véspera** Contribuição de @Tong-bit-art (#2179).

- **O painel da plataforma para de marcar "Vencido" na véspera do prazo, e a contagem de "Vence em" passa a contar até o fim do dia** Contribuição de @Tong-bit-art (#2168).

- **O prazo nas telas de detalhe de LGPD sai no dia certo, e a última hora do dia do prazo para de mostrar "0h restantes" ao lado de "Vencido"** Contribuição de @Tong-bit-art (#2169).

- **O próximo passo que o sistema escreve na demanda nova aparece no idioma de quem lê** Contribuição de @jmpo (#2040).

- **O link de "esqueci a senha" da instalação single-server passa a abrir a troca de senha** Quem já instalou recebe a correção pelo `update.sh`. Contribuição de @webtecnica (#2153), sobre o diagnóstico de @brunno-soaress na #2109.

- **A regra "criar ou mover negócio" agora transfere o card quando o gatilho é uma etiqueta de negócio** Contribuição de @webtecnica (#2162).

- **Mudar a regra de verificação em duas etapas da empresa pede o código na sessão de quem já usa a verificação** (#2167)

- **A gravação de sessão do diagnóstico de erros passa pelo mesmo filtro de URL do resto da telemetria** (#2186)

- **O roteador de intenções volta a classificar a transcrição do áudio — a conversa não fica mais presa no agente anterior** Contribuição de @webtecnica (#2082).

- **O fluxo de silêncio deixa de inscrever conversa que uma pessoa da equipe assumiu** Contribuição de @jmpo (#2037).

- **O instalador single-server deixa de apagar o REVERSE_PROXY escolhido no ambiente** Atenção: a instalação single-server atrás de proxy próprio ainda não conclui (Traefik para com 404 na fase 2; ver #2099). Contribuição de @webtecnica (#2150), sobre o diagnóstico de @brunno-soaress na #2099.

- **Skill importada por .zip volta a ser editável na tela sem perder references/ e assets/** Mudar os arquivos do pacote continua sendo por novo .zip. Contribuição de @webtecnica (#2203).

- **Acesso só de leitura ao painel de plataforma deixa de poder anonimizar contatos** Contribuição de @Tong-bit-art (#2196).

- **Acesso só de leitura ao painel de plataforma deixa de alterar conversas, mensagens, leads, sessões de canal e convites** Contribuição de @Tong-bit-art (#2193).

- **Suspender uma empresa passa a calar a IA e os envios dela; quem tem acesso só de leitura ao painel deixa de poder alterar dados** Ao reativar, nada sai em rajada: a Central lista as conversas que receberam mensagem durante a suspensão. (#1987) @Draven9 atacou o mesmo defeito, em paralelo, no #1967.

- **O teste do kit "instalar sem chave de IA" para de reprovar por acaso (intermitência da #1570)** Contribuição de @webtecnica (#2033).

- **Teto de escrita por token passa a valer também no upload de mídia e na abertura de conversa pelo contato** Contribuição de @webtecnica (#2012).

- **A transcrição de áudio usa o modelo de conversa da organização quando não há chave OpenAI, e o status da derivação nunca fica nulo** Contribuição de @webtecnica (#2189).

- **Reverter uma versão ou criar um agente pela tela não desliga mais o follow-up automático** Contribuição de @webtecnica (#2011).

- **Formulários do Elementor Pro passam a criar lead pelo webhook** Contribuição de @paulolimajr77 (#2051).

- **O lixo interno do JetFormBuilder não aparece mais no lead** Contribuição de @paulolimajr77 (#2051).
## [1.69.0] — 2026-09-30

### Adicionado

- **O Jev passa a ler, só observando, a resposta do cliente ao follow-up e comparar a saída que ele escolheria com a da sua IA** O Jev ganha a tarefa **Ler a resposta ao follow-up**. Num fluxo de follow-up com o passo **"Classificar (IA)"**, a sua IA de sempre lê a resposta do cliente à mensagem do fluxo e escolhe por qual das saídas que você criou no passo o fluxo segue. Com o Jev ligado, ele responde a mesma pergunta, entre as mesmas saídas e ao mesmo tempo, recebendo só o que o cliente digitou na resposta — sem CPF, telefone e e-mail — e as saídas e a dica que você escreveu no passo. Resposta em áudio, imagem ou documento não é enviada ao Jev.

  Nesta versão a tarefa **só observa**: quem escolhe a saída do fluxo é sempre a sua IA de sempre, e o follow-up não espera pelo Jev. O cartão do Jev, em **IA › Provedores**, mostra em quantas mensagens dos últimos 30 dias os dois puseram a resposta do cliente na mesma saída, e diz por que não há o botão "Deixar o Jev decidir" nela: a saída escolhida muda o caminho do cliente no fluxo, e primeiro se mede, com respostas de verdade, o quanto os dois concordam. Passos "Classificar (IA)" com uma saída só não são enviados ao Jev: sem escolha, os dois concordariam sempre. Onde nenhum follow-up publicado tem o passo com duas saídas ou mais — e nenhum cliente ainda está andando num fluxo que o tenha, mesmo desativado —, o cartão mostra a tarefa como **"Não roda"**, com o motivo e o link para **Follow-ups**, antes e depois de ligar o Jev. Em **IA › Execuções**, a chamada aparece como **"Ler a resposta ao follow-up"**, marcada como observação.

  **Quem já tem o Jev ligado** vê a tarefa com o selo **"Nova"**, já observando: ela usa o mesmo dado que você já autorizou — cada mensagem, sozinha. Isso é uma chamada a mais ao Jev a cada vez que a sua IA de sempre lê uma resposta digitada pelo cliente (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão. A política de privacidade passa a listar essa finalidade. Nada precisa ser editado para atualizar.

  Se a instalação voltar para uma versão anterior, a tarefa deixa de rodar e o estado dela fica guardado.

### Corrigido

- **O passo "Classificar resposta" dos fluxos de follow-up espera o cliente responder** Num fluxo que manda uma mensagem e em seguida classifica a resposta com a IA, o
  passo de classificar seguia pela saída "Sem resposta" poucos segundos depois do
  envio, sem dar ao cliente o tempo de espera configurado no passo (15 minutos
  por padrão, ou o prazo que você escolheu). O cliente que respondia dentro desse
  prazo já tinha sido tratado como quem não respondeu.

  Agora o passo espera o prazo inteiro:

  - se o cliente responder dentro dele, a resposta dele à mensagem do fluxo é
    classificada e o fluxo segue pelo caminho da classe — inclusive quando o
    agente ou alguém da equipe já respondeu ao cliente antes;
  - se o prazo acabar sem resposta, o fluxo segue por "Sem resposta", e uma
    condição "Desfecho do passo anterior" logo depois enxerga esse desfecho;
  - enquanto espera, a história do follow-up mostra "Esperando a resposta do
    cliente" com a hora limite, em vez de parecer parada.

  Não é preciso fazer nada para receber a correção. Quem colocou um passo
  "Aguardar" antes do "Classificar resposta" para contornar o problema vai ver os
  dois tempos somados (a espera do "Aguardar" e depois o prazo do classificar);
  se a espera extra não faz mais sentido, basta tirar o "Aguardar" do fluxo.

## [1.68.0] — 2026-09-30

### Adicionado

- **O Jev passa a perceber quando o cliente pede para falar com uma pessoa ou para parar de receber mensagens, e pode avisar a equipe na Central** O Jev ganha duas tarefas: **Perceber pedido para falar com uma pessoa** e **Perceber pedido para parar de receber mensagens**. Hoje quem percebe esses pedidos é uma regra sem IA: ela passa a conversa a uma pessoa quando o cliente escreve "quero falar com um atendente" (ou uma das palavras de passagem do agente) e bloqueia o contato quando ele manda "PARAR". Ela é precisa, mas estreita: "quero falar com alguém de verdade, não com robô" passa por ela sem ser visto.

  O Jev só é perguntado **onde a regra de hoje disse não** — a mensagem que ela já pegou nem sai para a TypeSafe, e a regra olha todas as mensagens do cliente ainda sem resposta, como o atendimento automático olha: "quero falar com um atendente" seguido de "por favor, alguém de verdade" é um pedido que ela pegou — e só onde há um atendente automático no ar naquele número, sem pessoa no comando. Pedido mandado por áudio não é perguntado. As duas perguntas vão juntas, numa chamada ao Jev separada da do clima da conversa: uma falha nela nunca muda a medição do clima.

  As duas tarefas **começam só observando**. O cartão do Jev, em **IA › Provedores**, mostra em quantas **mensagens** dos últimos 30 dias o Jev percebeu um pedido que a regra de hoje não reconheceu, com links para as conversas mais recentes, para você ler o que o cliente escreveu. A conta é por mensagem, e não por pedido: um cliente que escreve duas frases desse tipo seguidas conta duas. Onde nenhum atendente automático está no ar (ou o atendimento está com um sistema de fora), o cartão mostra as duas tarefas como **"Não roda"**, com o motivo. Em **IA › Execuções**, a chamada aparece como **"Perceber pedidos do cliente"**.

  Quando quiser, clique em **"Avisar a equipe"** na tarefa (o cartão explica o efeito e pede confirmação antes de valer). A partir daí, cada pedido que o Jev perceber abre **um aviso na Central de avisos**, um por conversa, com o botão **"Abrir a conversa"**; se o cliente pedir de novo, o mesmo aviso volta a abrir (ou, se ainda estiver aberto, sobe para o topo), com a data do pedido novo. O aviso não repete o que o cliente escreveu — a mensagem fica na conversa, para quem pode vê-la. O de **falar com uma pessoa** se fecha sozinho quando a conversa fica com uma pessoa (alguém assume, ou o atendimento automático a passa) ou é encerrada; se isso aconteceu enquanto o Jev respondia, ele nem nasce. O de **parar de receber** diz à equipe o que ela pode fazer — assumir a conversa, para o assistente parar de responder, e pedir ao cliente que responda "PARAR", que é o que bloqueia o contato —, e por isso **não** se fecha ao assumir: fica aberto até o contato ser bloqueado ou a conversa ser encerrada. O "Marcar resolvido" continua valendo para os dois. Com as tarefas avisando, o cartão segue dizendo que o Jev **observa**: ele não decide nada no lugar da regra. Em nenhum estado o Jev passa a conversa, bloqueia alguém, cala o agente ou responde o cliente: quem passa a conversa continua sendo a regra de hoje ou uma pessoa, e quem bloqueia o contato é só a regra de hoje, quando o próprio cliente manda "PARAR". Para voltar, clique em **"Voltar a só observar"**.

  **Quem já tem o Jev ligado** vê as duas tarefas com o selo **"Nova"**, já observando: elas usam o mesmo dado que você já autorizou — cada mensagem, sozinha, sem CPF, telefone e e-mail. Isso é uma chamada a mais ao Jev por mensagem em que a regra não viu algum dos pedidos (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão. A política de privacidade passa a listar essas duas finalidades. Nada precisa ser editado para atualizar.

  Se a instalação voltar para uma versão anterior, as duas tarefas deixam de rodar e o estado delas fica guardado; os avisos já abertos continuam na Central, e seguem se fechando sozinhos.

### Corrigido

- **O update.sh não falha mais com "duplicate key ... ai_pricing_pkey" quando um mesmo modelo está cadastrado em dois provedores** A atualização do aplicativo parava na etapa "Atualizando o banco de dados" com erro
  `duplicate key value violates unique constraint "ai_pricing_pkey"` quando o mesmo
  modelo existia ativo, com preço, em dois provedores ao mesmo tempo (ex.: openrouter
  e requesty) e ainda não tinha linha em `ai_pricing`. Como `ai_models` permite um
  `model_id` por provedor, o backfill de preços gerava duas linhas iguais dentro do
  mesmo comando e a chave primária (que é só o `model`) recusava a segunda. O erro
  não deixava nenhuma versão atualizar nem voltar com `--force` naquela instalação.

  Agora o backfill emite uma única linha por modelo, escolhendo de forma determinística
  o provedor de menor preço quando houver o mesmo modelo em mais de um provedor;
  o mecanismo idempotente (não reescrever preço já existente) continua intacto. Quem
  estava travado por esse erro basta rodar a atualização de novo: ela completa sem
  ação manual no banco.

  Contribuição de @webtecnica (#2008); reportado e investigado no banco por @aerosuiteapp (#1998).

- **O agente respeita os funis autorizados ao atualizar a etapa de um negócio** Ao confirmar uma etapa durante a conversa, o agente agora passa ao espelho do CRM os funis autorizados em sua versão publicada. Um agente sem acesso ao funil não move mais o cartão, inclusive quando retoma um caso interno; agentes com o funil autorizado continuam podendo atualizar a etapa. O estado da conversa e a resposta ao cliente seguem seu fluxo normal.

  Contribuição de @arodalves (#2006).

## [1.67.0] — 2026-09-30

### Adicionado

- **O tempo que o agente espera antes de responder passa a ser ajustável por número** A proteção de envio de cada número (em Conexões › Proteção de envio) ganhou quatro campos para o "tempo de pensar" do agente antes da primeira mensagem da resposta: o tempo para ver a notificação, o tempo por caractere digitado, o mínimo e o máximo. Campo vazio mantém exatamente o ritmo de antes (0,9 s + 22 ms por caractere, entre 1,2 s e 7,5 s). Um mínimo acima do máximo é recusado na hora, com a explicação na tela.

  Quando a resposta sai em várias mensagens, o intervalo entre elas passa a seguir o "intervalo entre mensagens" configurado para o número, em vez de um valor fixo de 1,2 s a 2 s. Quem nunca mudou esse intervalo não nota diferença; quem mudou vê as mensagens da resposta seguindo o valor escolhido.

  Não é preciso fazer nada na instalação: a atualização acrescenta as colunas sozinha.

  Contribuição de @webtecnica (#1996), fechando a #653.

- **Espera antes de responder (janela de rajada) configurável por agente** No cadastro do agente, em "Freios de segurança", agora dá para ajustar quanto tempo o agente espera antes de responder mensagens do mesmo contato que chegam em partes (ex.: "Obrigada" e, 14 s depois, "Tem piscina?"). Deixar o campo vazio usa a janela padrão da instalação (8 s), e o valor máximo é 60 segundos — nada de travar o atendimento sem querer. Não muda nada para quem não mexer: o campo é opcional e o comportamento de antes (janela padrão da instalação) segue valendo quando ele está vazio.

  Contribuição de @webtecnica (#1997).

## [1.66.1] — 2026-09-30

### Corrigido

- **Anonimizar um contato passa a apagar também a transcrição dos áudios e o texto lido das imagens dele** Quando um contato era anonimizado (LGPD), o texto das mensagens virava "[mensagem anonimizada]", mas a transcrição automática dos áudios e o texto lido das imagens e documentos continuavam guardados e legíveis, inclusive para o agente de IA. Agora a anonimização apaga esse texto junto, pelo pedido formal e pelo botão da ficha, e a atualização limpa também os contatos que já tinham sido anonimizados antes. Não é preciso fazer nada na instalação. Achado na triagem do #1988 (@AlecLimaDev).

## [1.66.0] — 2026-09-30

### Adicionado

- **Cada número ganha uma janela de resposta separada da janela de disparo** Até aqui, a proteção de envio de cada número tinha um único horário (7h às 22h por padrão), e ele valia para tudo: a resposta do agente a quem escreveu, os disparos em massa e as mensagens que retomam conversa parada. Para o agente responder de madrugada, era preciso abrir o horário inteiro, e com ele os disparos.

  Agora há duas janelas por número, em Conexões › Proteção de envio. A **janela de resposta** vale quando o cliente escreveu e o agente responde. A **janela de disparo** vale para disparos em massa, prospecção e mensagens que retomam conversa parada. Para o agente responder a qualquer hora, use 0 e 24 na janela de resposta.

  Nada muda ao atualizar: enquanto a janela de resposta estiver em branco, ela segue a janela de disparo, como antes. O teto diário, o aquecimento do número e o intervalo entre envios continuam valendo para os dois tipos de envio.

  Contribuição de @suporteubere99-coder (#1983).

## [1.65.0] — 2026-09-30

### Adicionado

- **Instalação em VPS ARM64** O instalador agora atende VPS ARM64/aarch64, como Oracle Ampere A1, AWS Graviton e Hetzner CAX, inclusive no modo com Supabase na mesma VPS. As imagens do DeskcommCRM são construídas em máquina ARM nativa e publicadas na mesma tag das de amd64, e o WAHA usa a variante oficial NOWEB ARM64 (`devlikeapro/waha:noweb-arm-2026.7.2`). Nada é compilado na VPS. Quem já roda em ARM passa a atualizar pelas imagens publicadas, e o `update.sh` troca no `.env` o WAHA amd64 antigo pela variante ARM (um valor escolhido à mão fica intacto). Em amd64 nada muda.

  Contribuição de @mauriciobera1990-droid (#1938).

- **Skills mostram o que mudou entre a sua cópia e a versão nova do catálogo antes de adotar** Ao ver o aviso de que o catálogo publicou uma versão nova de uma skill, o operador agora vê o que mudou em relação à cópia que a organização tem em uso — descrição, palavras-chave de ativação e as linhas adicionadas/removidas do procedimento — antes de decidir adotar.

  Contribuição de @webtecnica (#1972).

### Alterado

- **A anonimização de um contato passa a apagar também as notas do agente, os argumentos das ferramentas da IA, a próxima ação da lead e a identidade social — direto no banco** Antes, o pedido de esquecimento (LGPD) só limpava a memória do agente, os argumentos de ferramentas da IA, a próxima ação da lead e o perfil social quando a camada de aplicação rodava; se a anonimização acontecesse por outro caminho (um update direto, por exemplo), essas quatro fontes ficavam com dados da pessoa. Agora a cascata do banco, disparada quando o contato vira anonimizado, redige as quatro na mesma transação: as notas da IA, o registro das ferramentas (preservando o nome da ferramenta), o estado da lead e a identidade social. Operação idempotente, então a varredura diária não reescreve o que já foi limpo.

  Contribuição de @webtecnica (#1973).

### Corrigido

- **A exportação de dados do titular inclui a memória e os registros da IA sobre ele** O direito de acesso entregava conversas, leads, atividades e a ficha do titular, mas não três fontes que a cascata de anonimização já limpa a pedido dele: as notas de memória da IA (`lead_notes`), os argumentos passados às ferramentas (`ai_agent_runs.tool_calls`) e a próxima ação e a qualificação do funil (`lead_state`). O que se apaga a pedido do titular é o que se entrega a pedido dele.

  A exportação agora coleta as três, filtradas por organização e contato, e as entrega no arquivo que o titular recebe (`data.json`), com a qualificação íntegra e, de cada execução da IA, o nome e os argumentos de cada ferramenta — que é o texto que o titular escreveu. O resultado das ferramentas e o texto intermediário do modelo ficam de fora: uma busca de contatos feita pelo agente devolve telefone e e-mail de outras pessoas, e isso não pode chegar ao arquivo de um titular. Quem já usa o produto recebe o relatório mais completo sem precisar fazer nada na instalação.

  Refs #1965

  Contribuição de @webtecnica (#1969).

- **Turno descartado como obsoleto não emite mais a pergunta pendente do roteiro** Quando o #1940 recusa a resposta de um turno porque o cliente escreveu de novo enquanto o agente pensava, o turno é descartado. Mas, num agente com roteiro de atendimento, a pergunta pendente do roteiro ainda saía no fim desse turno descartado — e o turno da mensagem nova respondia em seguida. Efeito: resposta dupla.

  Agora, num turno descartado como obsoleto nada mais sai, nem a pergunta do roteiro: ela fica pendente para o turno da mensagem nova, que lê a conversa inteira. Nenhuma configuração ou ação é necessária.

  Refs: #1940, #1943

  Contribuição de @webtecnica (#1968).

## [1.64.1] — 2026-09-30

### Corrigido

- **A agenda desenha no fuso da organização, não no do navegador** A agenda aberta fora do fuso da empresa desenhava as horas no relógio de quem
  abriu a tela: um compromisso às 09:00 da clínica aparecia às 09:00 do relógio
  de quem estava viajando ou com a máquina em outro fuso, a régua do "agora"
  subia para a hora local, e a chave de dia dos horários livres era a do navegador.

  A âncora da semana já vinha do relógio da organização; faltava a grade. Os
  blocos, os rótulos de hora, a linha do "agora" e a chave de dia agora saem de
  `partesNoFuso` e `diaLocalISO` (`lib/agenda/fuso.ts`) sobre o fuso resolvido em
  `page.tsx` — a mesma fonte que o servidor usa para a primeira pintura.

  Para quem tem navegador e organização no mesmo fuso — a maioria das
  instalações — a conversão é a identidade e nada muda de lugar. Um teste novo
  escolhe de propósito um fuso diferente do ambiente, fixa o instante e mede a
  posição da régua e o rótulo do card contra a hora de parede esperada; ele
  reprova se a grade voltar a ler o relógio local.

  Refs #1362

  Contribuição de @webtecnica (#1831).

- **A cópia de playbook que a organização editou também avisa quando sai versão nova no catálogo** Até aqui, a primeira edição de um playbook copiado do catálogo desligava de vez o aviso de versão nova: a cópia editada passava a aparecer como "manual" e nunca mais era avisada, justamente na empresa que mais precisa saber da atualização. Agora a cópia editada continua ligada à versão do catálogo de onde veio, segue marcada "do catálogo" e mostra o aviso quando a plataforma publica versão nova.

  O aviso agora diz que, se a cópia foi editada, adotar a versão nova torna ativa a versão do catálogo e deixa as alterações só no Histórico de versões, de onde podem ser restauradas. Skills importadas por arquivo .zip continuam sem aviso. Uma cópia editada antes desta versão já tinha perdido o vínculo e continua sem o aviso.

  Refs #1951

  Contribuição de @webtecnica (#1960).

- **Anonimizar um contato também limpa a memória e os registros da IA sobre ele** Anonimizar um contato limpava a ficha, as conversas, as leads, as atividades e a régua, mas deixava dado pessoal em quatro lugares que o agente de IA escreve: as notas de memória (`lead_notes`), o registro de execução com os argumentos passados às ferramentas (`ai_agent_runs.tool_calls`), a próxima ação e a qualificação do funil (`lead_state`) e a identidade social do contato (`contacts.social_identity`).

  As quatro fontes agora entram na cascata de anonimização. No registro de execução fica só o nome das ferramentas que rodaram, para a trilha do que o agente fez continuar legível; o texto do modelo, os argumentos e os resultados são apagados. Quem anonimiza pela ficha do contato tem tudo limpo na hora. Um pedido formal de exclusão tem essas fontes limpas na varredura diária de retenção, que já completava cascatas interrompidas. Nada precisa ser feito na instalação.

  Refs #1957

  Contribuição de @webtecnica (#1958).

- **O nome da marca no onboarding segue a configuração da tela Marca** As telas de boas-vindas, de primeiro acesso e o cabeçalho do onboarding escreviam o nome da marca lido só do arquivo de instalação (.env), então quem trocou o nome em Administração › Marca continuava vendo o nome antigo justamente nas primeiras telas. Agora elas usam o mesmo resolvedor do título da aba: a configuração salva na tela vence, e o .env segue como reserva. Sem marca própria configurada, nada muda.

  Refs #1944

  Contribuição de @webtecnica (#1961).

## [1.64.0] — 2026-09-29

### Adicionado

- **A cópia de um playbook do catálogo avisa quando sai versão nova, e deixa adotar** Quando a plataforma publica uma versão nova de um playbook do catálogo que a organização
  instalou, o painel de Skills passa a mostrar um aviso nessa skill com o botão "Adotar versão
  nova". Nada é trocado sozinho: adotar é um clique de quem é gerente, a versão nova passa a ser
  a ativa e a que estava em uso continua no Histórico de versões, de onde pode ser restaurada.
  Skills importadas por arquivo .zip nunca mostram o aviso. Uma cópia que a organização já
  editou no editor ainda não mostra o aviso.

  Contribuição de @webtecnica (#1950).

### Corrigido

- **A busca deixa de devolver a lista inteira quando o termo tem só asteriscos** Digitar um termo feito só de asteriscos (duplo estrela, `* *` sem espaços) na busca da caixa de
  entrada ou de contatos podia devolver tudo: o asterisco não era tratado como separador e virava
  curinga no `or=`, equivalente a buscar sem critério. Agora o piso da busca o ignora — um termo só
  de asteriscos não vai ao banco.

  Contribuição de @webtecnica (#1948, issue #1935).

- **Excluir contato com compromisso avisa o que barra e como resolver** Ao excluir um contato que tem compromisso na Agenda, a mensagem genérica ("registros
  vinculados") cede lugar a um aviso que diz qual é o vínculo e oferece abrir a Agenda para
  resolver antes de excluir.

  Contribuição de @webtecnica (#1949, issue #1925).

## [1.63.6] — 2026-09-29

### Corrigido

- **O cabeçalho do onboarding mostra o ícone da marca própria em vez de nenhum** Quem configurou marca própria em Marca da instalação não via ícone nenhum no cabeçalho do onboarding, só o nome escrito. Agora aparece o mesmo ícone da aba do navegador: o arquivo subido em Marca, ou a inicial na cor da marca quando nenhum arquivo foi subido. Sem marca própria, nada muda: o cabeçalho segue com o símbolo do produto, que acompanha o tema claro ou escuro. Nenhuma configuração ou ação é necessária.

  Contribuição de @carlos0195 (#1942).

- **O agente não envia a resposta que ficou desatualizada porque o cliente escreveu de novo enquanto ele pensava** Cliente que escreve em várias mensagens ("Oi", "Boa tarde", depois a pergunta) recebia duas ou mais respostas seguidas. A primeira saía desatualizada ("Como posso te ajudar?" com a pergunta já na conversa) porque o agente leu a conversa antes de a pergunta chegar e levou alguns segundos para escrever. Numa instalação real, 39% das respostas de um agente saíram a menos de 3 minutos de outra resposta ao mesmo cliente.

  Agora, se chega mensagem nova do cliente enquanto a resposta está sendo escrita, ela não é enviada: o turno seguinte lê a conversa inteira e responde a tudo de uma vez. Para quem escreve sem parar não ficar sem resposta, a regra vale só enquanto a mensagem mais antiga sem resposta tiver menos de 2 minutos. Depois disso, a resposta sai mesmo assim. O tempo é ajustável por `RESPOSTA_OBSOLETA_TETO_MS`, e `0` desliga. Uma mensagem reentregue com atraso, com horário anterior ao da última que o agente leu, não segura a resposta: essa mensagem não abre turno próprio, e segurar a resposta deixaria o cliente sem nenhuma. Nenhuma configuração ou ação é necessária.

  Contribuição de @automatikpg-ux (#1940).

- **O valor do negócio e o documento do contato deixam de dizer Brasil sempre** Quem escolheu outra moeda em Configurações › Organização continuava lendo "Valor (R$)" ao criar ou editar um negócio, embora o valor já fosse gravado e mostrado na moeda da empresa. Agora o rótulo e o eco logo abaixo do campo usam a moeda certa — a do próprio negócio, que continua valendo mesmo se a empresa trocar de moeda depois, e a da empresa quando o negócio é novo. Na ficha do contato, o documento e o exemplo de telefone passam a vir do país da organização — a API já validava o documento por ele, só a tela é que escrevia "CPF" e um telefone brasileiro em duro. Para quem opera no Brasil nada muda. Crédito: @maclevison.

  Contribuição de @maclevison (#1945).

## [1.63.5] — 2026-09-29

### Corrigido

- **A busca da caixa de entrada para de consultar o banco com um termo feito só de parênteses** Um termo como `()`, `((` ou `(a` passava pelo tamanho mínimo da busca da caixa de entrada: o parêntese contava como letra, mas na consulta vira curinga, e a busca casava todas as conversas. Era uma consulta cara que não filtrava nada. Agora o tamanho mínimo é medido sem os parênteses, com a mesma régua que a busca de contatos já usava. Um termo assim conta como curto: a tela mostra a lista sem filtro, como acontece com uma letra só, e quem chama a API recebe a recusa de termo curto em vez da lista inteira. Nenhuma configuração ou ação é necessária.

  Contribuição de @webtecnica (#1934).

- **Gasto de IA sem arredondamento para cima, sentimento parado quando nenhum agente está no ar, e a frase de falta de saldo da OpenAI reconhecida** Três consertos medidos numa instalação real.

  O custo das chamadas registradas pelos workers de sentimento e de resposta legada era arredondado para cima até o centavo inteiro. Uma classificação de sentimento, que custa cerca de um centésimo de centavo, entrava como um centavo inteiro. No mês medido, isso respondia por mais de 90% do gasto que o teto de orçamento enxergava. Agora o custo é gravado fracionado, como o motor do agente já fazia. Os registros antigos não são recalculados automaticamente. Por isso o gasto de IA mostrado em Uso e orçamento cai a partir desta versão, e o mês corrente mistura os registros antigos, arredondados, com os novos. O teto passa a disparar menos, porque deixa de contar gasto que não existiu.

  Com todos os agentes pausados ou despublicados, o classificador de sentimento continuava rodando em cada mensagem recebida. A passagem para humano por sentimento mandava ao cliente "não há atendente disponível… sua conversa entrou na fila" enquanto a equipe já respondia por fora. Agora, sem agente no ar, o sentimento não roda: não cobra e não avisa ninguém.

  A espera pela recarga de saldo não reconhecia a frase "You have no credits remaining" da OpenAI. Nesse caso a fila voltava a gastar as tentativas e gerava um `job_dead` por conversa. Agora a frase é reconhecida e a resposta espera a recarga como nos outros casos. Nenhuma configuração ou ação é necessária.

  Contribuição de @automatikpg-ux (#1936).

## [1.63.4] — 2026-09-29

### Corrigido

- **Com OpenRouter, o custo das respostas da IA volta a ser contado — e o limite de gasto passa a valer** Com o provedor OpenRouter (ou qualquer gateway que nomeie o modelo como `anthropic/claude-…` ou `openai/gpt-…`), o custo das respostas do agente, das guardas e da classificação de etapa ficava em branco: a tela Uso de IA mostrava gasto zero e o limite de gasto da organização nunca era alcançado. A busca de preço agora entende esse formato. Modelo que não está na tabela de preços continua sem custo — nunca com o preço de outro.

  O que muda depois de atualizar: a tela Uso de IA passa a mostrar o gasto das chamadas feitas a partir da atualização (as anteriores seguem sem custo, então o total deste mês começa a contar do dia em que você atualizou). Se alguma organização tem limite de gasto configurado para interromper o atendimento, esse limite passa a valer de verdade: ao chegar nele vem primeiro o aviso na Central e, depois, a IA para de responder e as conversas vão para a fila humana. Aumentar o limite evita paradas novas, mas não devolve a IA às conversas que já pararam — cada uma é retomada na própria conversa. Para conferir antes, abra Uso de IA › Orçamento; a parada de emergência da instalação inteira fica em Administração › Recursos opcionais › Comportamento ("Proteção de gasto de IA"), com `AI_BUDGET_ENFORCEMENT=off` no `.env` como alternativa.

  Contribuição de @webtecnica (#1929). Relatado por @eduardosuruagy (#1880).

- **O aviso de evento morto não abre mais em dobro quando dois drenos rodam juntos** O dreno que vaza eventos para a Central consultava "já existe um aviso aberto?" e só depois inseria — e o cron `event-log-drain` e o drain-loop do worker disparam os dois ao mesmo tempo. Os dois liam "não existe" antes de qualquer escrita, os dois inseriam, e o problema de verdade ficava com dois avisos idênticos na Central. Aviso repetido é aviso que ninguém abre.

  O banco agora é quem segura a fila: um índice único parcial em `agent_inbox_items` (organização, kind e título, só enquanto o aviso está aberto) recusa a segunda linha, e os dois caminhos de escrita passam a tratar essa recusa como o que ela é — "o aviso já estava aberto", e não um erro do dreno. A chave leva o título porque o `event_dead` tem duas famílias que precisam conviver abertas na mesma organização (a da IA que parou de responder e a de mídia), e o predicado é parcial porque uma linha resolvida não pode segurar o slot: reabrir um aviso continua funcionando, e reabrir quando já existe um aberto idêntico volta com resposta clara em vez de erro interno.

  Kinds diferentes, organizações diferentes e as duas famílias do `event_dead` seguem gravando normalmente, em paralelo.

  Contribuição de @webtecnica (#1928).

- **O playbook de agenda ensina os dois passos — listar o que a empresa atende e só depois consultar horários** O playbook `agendamento` é o texto que entra na conversa quando o cliente fala em "agendar", "horário disponível" ou "que horas vocês". Ele começava no meio da cadeia: dizia que a IA só tem acesso à agenda se `crm_find_free_slots` estiver disponível e mandava consultar horários, mas nunca dizia de onde vem o `event_type_slug` que essa ferramenta exige. O primeiro passo, `crm_list_event_types`, não aparecia em nenhuma linha do texto.

  Por isso acontecia a cena da issue #1019: a IA listava os tipos de atendimento, parava ali e respondia "vou verificar", ou passava para a equipe, em vez de oferecer um horário real.

  Agora o texto ensina a cadeia inteira. Primeiro `crm_list_event_types`, de onde sai o `slug` de cada tipo de atendimento. Depois, **no mesmo turno**, `crm_find_free_slots` com esse `event_type_slug`. Quando o cliente escolhe um horário, `crm_book_appointment` com o `starts_at` que a consulta devolveu. Parar depois da lista e responder "vou verificar" passa a ser descrito como o erro que é.

  Cada ferramenta só é mencionada com a condição "se ela estiver na sua mão". O texto vale para a organização inteira e chega por palavra-chave, sem saber quais ferramentas o agente tem ligadas. Para o agente que não tem a ferramenta, nada muda: ele não inventa horário e avisa a equipe.

  A atualização reaplica o `baseline.sql`, e isso já troca o texto padrão. Nenhuma ação é necessária. Uma organização que instalou este playbook pelo catálogo, ou o editou, tem uma cópia própria: essa cópia continua como está e não recebe o texto novo.

  Contribuição de @webtecnica (#1922).

## [1.63.3] — 2026-09-29

### Alterado

- **O CI passa a rodar a conferência de isolamento da atualização contra o banco novo** Da v1.61.0 à v1.63.0, a atualização de quase toda instalação parava no meio e deixava o CRM atrás da página de manutenção: a conferência das regras de isolamento do `update.sh` passou a cobrar regras de um módulo que a instalação não tinha, e nenhum dos cinco checks obrigatórios rodava essa conferência. Agora o check `invariants` a roda contra o banco recém-montado pelo `baseline.sql`, em três versões do script — a do próprio PR, a da última release publicada (é a que roda do disco de quem atualiza) e a da v1.63.0, a última que ainda lê as regras só pelo texto. Uma mudança de banco que travaria a atualização de alguém passa a reprovar antes do merge. Nada muda para quem opera.

### Corrigido

- **O histórico de um follow-up e as versões publicadas de um fluxo não podem mais ser apagados por quem só visualiza** Qualquer membro da organização, inclusive quem só tem o papel de visualizador, conseguia apagar ou alterar o histórico de uma inscrição de follow-up (o que foi enviado, pulado ou cancelado) e as versões publicadas de um fluxo, que são a base para voltar a uma versão anterior, falando direto com o banco pela chave pública do sistema e pela própria sessão, sem passar pelas telas. Agora o histórico só recebe registros novos, e só de quem é gerente ou administrador, que é o papel que as telas já exigiam para pausar, retomar, pular, adiar ou cancelar um follow-up. Ninguém altera nem apaga um registro do histórico por esse caminho, e as versões de um fluxo só saem quando um gerente ou administrador apaga o fluxo inteiro. A leitura continua liberada para todos os membros, e as telas e os envios automáticos funcionam como antes. Não há nada para fazer: a regra entra sozinha na próxima atualização.

## [1.63.2] — 2026-09-29

### Corrigido

- **O tempo na etapa do card do Kanban não zera mais a cada nota ou mensagem** O rodapé do card do Kanban contava o "tempo no estágio" a partir da última atividade do negócio: qualquer nota, edição ou mensagem na conversa zerava o relógio de um negócio parado na mesma etapa havia dias. Agora o tempo é contado a partir da entrada na etapa atual (a coluna `crm_leads.stage_changed_at`, carimbada pelo banco desde a migration 0071), e só mudar de etapa zera o relógio. Negócio sem esse registro cai na data de criação, nunca na última mensagem. Contribuição de @webtecnica (PR #1908).

- **Excluir um contato que já passou por retorno automático não perde mais o histórico** Quem tentava excluir pela tela um contato que já passou por um retorno automático levava um erro **e** ficava com a ficha na base sem histórico: as mensagens e as conversas já tinham sido apagadas quando a exclusão foi recusada. A auditoria registrava `contact.delete_blocked` com `apagados: ["messages","conversations"]` — o rastro exato do estrago.

  O defeito tinha duas metades e as duas foram consertadas. O banco recusava com `42501` o DELETE que chega **em cascata** quando a ficha é apagada, porque o gatilho de proteção do follow-up não distinguia cascata de escrita direta — agora ele distingue pela profundidade do gatilho: a cascata passa, quem apaga um turno de follow-up pela API com sessão de usuário continua sendo recusado, como sempre. E a rota, que apagava mensagens, conversas e a ficha em **três passos separados**, passa a chamar uma função única: as três saem numa transação só, ou sai tudo ou não sai nada.

  Ficha com compromisso na agenda continua sendo recusada antes de qualquer coisa ser apagada, e uma exclusão que falhe por qualquer outro motivo deixa o histórico exatamente onde estava. Nada muda para quem opera além de a exclusão passar a funcionar. Não exige ação.

  Contribuição de @webtecnica (#1912).

- **Só gerente ou administrador consegue cancelar ou apagar uma inscrição de follow-up pelo acesso direto ao banco** Qualquer membro da organização, inclusive quem só tem o papel de visualizador, conseguia apagar ou alterar uma inscrição de follow-up, ou um fluxo inteiro, falando direto com o banco pela chave pública do sistema e pela própria sessão, sem passar pelas telas e sem ficar registrado na auditoria. Apagar a inscrição levava junto o histórico dela e as mensagens de follow-up já agendadas. Agora só quem tem o papel de gerente ou de administrador consegue criar, alterar, cancelar ou apagar uma inscrição ou um fluxo de follow-up por esse caminho, que é o mesmo papel que as telas e a API já exigiam. A leitura continua liberada para todos os membros, e as telas e os envios automáticos funcionam como antes. Não há nada para fazer: a regra entra sozinha na próxima atualização.

## [1.63.1] — 2026-09-29

### Corrigido

- **Atualização de instalação sem o módulo de honorários não para mais no aviso de regras de isolamento** Desde a 1.61.0, atualizar uma instalação que não tem o módulo de honorários parava no passo do banco com o aviso vermelho `⛔ REGRAS DE ISOLAMENTO AUSENTES`, listando 8 regras das tabelas `honorarios_contratos` e `honorarios_parcelas`, e deixava o CRM parado atrás da página de manutenção. Não faltava regra nenhuma: essas 8 só existem depois que o módulo é instalado, e a conferência as cobrava mesmo assim. Agora a conferência só cobra regra de tabela que existe no banco, e uma regra de tabela existente que sumir continua parando a atualização, como antes.

  Quem não ficou preso não precisa fazer nada: a próxima atualização passa direto. Isso vale também para quem ainda está numa versão anterior à 1.61.0, porque esta versão muda o `supabase/baseline.sql` de forma que a conferência do `update.sh` antigo, que é o que roda durante a atualização, deixa de contar essas 8 regras.

  Se a sua atualização para a 1.61.0, 1.62.0 ou 1.63.0 parou nesse aviso, o CRM está fora do ar e o botão da tela não responde. Entre no servidor e rode a atualização de novo, na pasta do CRM: `bash hostgator-setup-kit/update.sh`. Ela termina e tira a página de manutenção do ar. Se mesmo assim parar no mesmo aviso, rode estes três comandos, que trocam o código para esta versão antes de atualizar e assim usam a conferência nova: `git fetch --tags origin`, depois `git checkout v1.63.1`, depois `bash hostgator-setup-kit/update.sh --to v1.63.1 --force`.

  Contribuição de @webtecnica (#1906). Relatado por @emersonraza (#1893), @Draven9 (#1897) e @pmfproducer (#1899).

## [1.63.0] — 2026-09-29

### Adicionado

- **Módulos opcionais passam a poder declarar o que a anonimização de LGPD apaga neles** Um **módulo opcional** passa a ter como fazer a exclusão de dados de LGPD alcançar as tabelas dele, sem que a instalação precise lembrar de nada: o módulo declara uma vez, na própria migration, quais colunas guardam texto livre sobre a pessoa e como a linha se liga a ele, e a anonimização passa a redigir essas colunas junto com as do resto do sistema. Hoje nenhum módulo declara seção (honorários não guarda texto livre sobre a pessoa), então nada muda na sua instalação até um módulo declarar. Quem **não** instalou o módulo não muda de comportamento — a seção declarada para uma tabela que não existe é pulada na hora, sem erro, e a exclusão do contato segue funcionando igualzinho. Antes, o caminho seguro seria alguém reescrever a cascata inteira de anonimização a cada módulo novo; quem esquecesse entregaria **sucesso com a pessoa ainda legível**, que é exatamente o que a LGPD não permite.

  A declaração errada (coluna que não existe) agora **falha alto**, dizendo qual módulo e qual tabela, em vez de redigir pela metade e devolver sucesso — porque entregar um pedido de exclusão como cumprido com dado legível é pior do que ele falhar e ser repetido. O registro que guarda essas seções é fechado: só quem aplica o schema escreve nele — nem a chave de serviço do app —, e o gatilho não roda em papel de cliente.

  Também entra a prova de que **as funções de um módulo existem mesmo sem as tabelas dele** — que é como toda instalação vive, já que as tabelas só nascem quando alguém instala o módulo: a cadeia inteira é recriada com a validação de corpo ligada e as tabelas ausentes, e tem de compilar. Não exige ação de quem já está rodando: o `update.sh` cria a tabela do registro (vazia) e o gatilho, sem nenhuma mudança de tela.

  Contribuição de @webtecnica (#1901).

- **A tela de atualização diz onde está o detalhe da disputa de banco** Quando a atualização pelo botão da tela encontra o banco em uso por outro processo e precisa de mais de uma passada, o resumo dessa disputa já aparecia no fim da atualização. Faltava dizer onde procurar o detalhe.

  Agora, logo abaixo do resumo, a tela aponta o arquivo `.update.log`, na pasta do projeto no servidor, onde fica o que cada passada não aplicou. A linha aparece tanto quando a atualização termina bem quanto quando ela volta para a versão anterior. Se a rodada não teve disputa, ou se ela não foi medida, a linha não aparece. Nada muda para quem atualiza pela linha de comando. Não exige ação.

  Contribuição de @webtecnica (#1898, issue #1040).

- **Relatório por etiqueta — volume, espera e desfecho de cada assunto no período** Quem opera agora pode perguntar à API **qual assunto ocupou a operação em um período e quanto tempo o cliente esperou**. `GET /api/v1/reports/tags` devolve, para cada etiqueta em uso, quantos atendimentos começaram no período, quantos ainda estão abertos e quantos foram encerrados, a espera média pela nossa resposta e a fatia de cada etiqueta sobre o total. A lista de etiquetas vem das que existem de fato nas conversas: uma etiqueta sem atendimento no período aparece com zero em vez de sumir, e um período sem dado nenhum diz isso na resposta em vez de devolver uma tabela de zeros. O pedido aceita `de`, `ate` (datas válidas, até 90 dias) e `tz`, porque a janela é contada no fuso de quem lê. Quando a janela tem mais conversas do que a leitura alcança, a resposta avisa que está cortada. É só leitura, sem migration e ainda sem tela: a tela vem depois. Contribuição de @webtecnica (#1888).

### Alterado

- **A exclusão de uma conexão passa a ter prova de que o aviso dela sai junto** O fecho do aviso quando a conexão é removida já existia na rota, mas a prova na rota só cobria o ramo que ARQUIVA. O ramo que EXCLUI de vez — canal sem histórico, o `.delete()` — seguia sem teste nenhum com aviso aberto, que é exatamente o caso descrito na issue: o operador apaga a conexão e o crítico continuava na Central. Agora há um caso de rota para esse ramo, afirmando que nenhum aviso daquela conexão sobra, que o aviso de outra conexão segue aberto e que a auditoria diz `avisos_fechados: resolvido`. Nada muda no comportamento de quem opera: só a cobertura.

  Contribuição de @webtecnica (#1903, issue #1023).

### Corrigido

- **A busca de contatos entende como a gente digita — e para de devolver a lista inteira** Quem procura um contato passa a achar mesmo digitando do jeito que se digita na pressa: **"Paulo  Lima"** com espaço duplo, **"Paulo Jr"** com as palavras separadas e **"Silva, Maria"** com ou sem vírgula encontram o cadastro, onde antes davam zero para gente que existe. Digitar **uma letra só** deixa de devolver a lista inteira dos contatos — lista inteira sob busca não é resposta, é ruído que parece resposta.

  A busca de contatos passou a seguir a **mesma régua da caixa de entrada**: todo separador (espaço, vírgula, ponto e vírgula) vira o curinga da busca e o termo só vai ao banco depois de ter os dois caracteres mínimos. A régua é uma só e continua morando em `lib/inbox/termo-de-busca.ts`, então a caixa de entrada e os contatos andam juntos a partir de agora — e se a regra mudar, muda para os dois ao mesmo tempo. A busca por telefone, CPF e e-mail continua exatamente como estava, e a caixa (maiúscula/minúscula) continua sendo do banco.

  A busca continua sem diferenciar acento: "Joao" ainda não encontra "João". Isso é outra fatia, porque exige coluna nova no banco e preenchimento dos cadastros existentes. Não muda esquema nenhum. Não exige ação.

  Contribuição de @webtecnica (#1892, issue #1835).

- **Dar merge na main deixa de ser acusado como autoria de quem fez o merge** Mergear a `main` na sua branch voltou a passar sem válvula nenhuma — e sem afrouxar nada. Quem atualizava a branch com o que a `main` publicou (um invariante reescrito, uma migration nova) era tratado como quem escreveu aquilo: a catraca de invariantes e a guarda de `plan/features.json` liam o índice do merge inteiro e não tinham como separar o que veio da `main` do que a branch introduziu. A causa era do git, não da regra: ele chama o `pre-merge-commit` ANTES de escrever o `MERGE_HEAD`, então as referências de procedência estavam vazias no instante exato em que a pergunta é feita — e a guarda, no lado seguro, falhava fechado sobre o merge todo. Era o lado seguro errado: ela não estava defendendo a regra, estava punindo o merge.

  A regra continua idêntica. O que mudou é como o alcance é calculado: o git entrega o outro lado, naquele instante, em `GITHEAD_<sha>=<ref>`, e é por ali que a guarda agora enxerga de onde veio o que o commit tem. Com o outro lado em mãos, as condições de procedência valem igual no caminho limpo e no caminho conflituoso — o que a `main` já tinha continua não sendo autoria de quem mergeia, o invariante da `main` modificado pela branch continua barrado, e a migration com sequência já usada continua barrada. Nenhuma barreira foi removida, nenhum escape foi retirado: o que some é só a acusação sobre o merge.

  Como esse sinal é uma variável de ambiente, quem roda o commit pode forjá-lo, e o mesmo valia para um `MERGE_HEAD` escrito à mão. Por isso a guarda de `plan/features.json` ganhou as duas condições que a catraca de invariantes já tinha: o conteúdo que entra tem de ser o que a `main` tem agora, e a branch não pode ter tocado o arquivo. Antes, um commit comum com o sinal apontando para uma versão antiga da `main` conseguia apagar features do plano.

  Não exige ação de ninguém.

  Contribuição de @webtecnica (#1900).

## [1.62.0] — 2026-09-28

### Adicionado

- **Perguntar ao acervo direto da conversa, e a busca do atendente ganha gráfico próprio em Evolução** Quem atende ganha, no painel ao lado da conversa, uma caixa "Acervo" para perguntar sobre o material da própria empresa (as fontes que a IA usa nas respostas). A resposta traz os trechos que passaram no limiar, com a semelhança de cada um, e separa três situações que antes chegavam iguais: o acervo está vazio, a base não tem essa informação, ou há algo parecido abaixo do limiar. É a mesma busca e o mesmo limiar que a IA usa; não existe uma segunda régua para a tela.

  Cada pergunta gasta uma chamada de embedding na chave da organização, então a caixa tem limite de 12 perguntas por pessoa e 60 por organização a cada minuto, e a pergunta vai até 1000 caracteres. Sem chave de embedding cadastrada, a caixa diz isso e aponta Credenciais.

  A pergunta do atendente passa a ser registrada, e a tela de Evolução a mostra num gráfico próprio, "Consultas da equipe ao acervo". Ela não entra nos números do agente nem nas "perguntas de clientes sem resposta". Não há ação para quem opera a VPS: a migração é aditiva e roda sozinha na atualização.

  Contribuição de @webtecnica (#1877, entrou pelo #1882).

- **Anexo de imagem, arquivo, áudio ou vídeo dentro de nota interna** A nota interna de conversa passa a aceitar anexo. Quem escreve nota pode anexar imagem, documento, áudio ou vídeo, e o anexo aparece na própria nota como apoio para o time. Documento aparece como cartão com o tipo e o tamanho do arquivo; o nome original do arquivo não é guardado.

  O arquivo não sai da empresa: ele fica num espaço de armazenamento próprio (`internal-media`), separado da mídia de conversa, e **nunca vai para o cliente no WhatsApp**. Ele também fica fora da retenção por idade da mídia de conversa (a que a empresa configura): enquanto a nota existir, o anexo continua lá.

  Para quem lê a nota, o anexo abre por um endereço temporário (60 segundos) e só se a pessoa puder ver a conversa daquela nota — a mesma regra de permissão que a própria nota já tinha, sem permissão nova.

  **Limpeza**: quando uma nota com anexo é apagada, a rotina diária de limpeza remove o arquivo dela depois de 1 dia. Quando um contato pede exclusão de dados (LGPD), o texto das notas das conversas dele é redigido e o anexo vai para a fila de remoção. A exportação de dados do titular passa a listar as notas internas, com os dados do anexo (tipo, tamanho e caminho), sem o arquivo em si.

  **Para quem opera a VPS**: anexo de nota que continua existindo **não expira** e ocupa o armazenamento da instalação (o mesmo espaço da mídia do WhatsApp). Cada anexo pode ter até 50 MB.

  **Sem mudança de comportamento para a nota sem anexo**: ela continua como estava.

  Contribuição de @webtecnica (#1883).

- **A base de conhecimento pode ser preparada pelo Google (Gemini), não só pela OpenAI** Quem só tem a chave do Google passa a ter base de conhecimento: em **IA › Conhecimento**, o cadastro de chave oferece Google ao lado de OpenAI e OpenRouter, e a tela mostra quem prepara a base hoje, com o botão para trocar. Trocar entre OpenAI e Google **refaz a base inteira** — todo o material é preparado de novo com o novo provedor, e a tela avisa isso antes de trocar. Enquanto o material é refeito, o agente pode não encontrar o que ainda não foi refeito.

  Nada muda para quem já usa a OpenAI: a chave do Google só é usada sozinha quando não há nenhuma chave OpenAI, OpenRouter ou gateway, e trocar é sempre uma escolha feita na tela. Depois que a base é preparada, o provedor fica fixo: cadastrar ou remover uma chave não o troca — se a chave do provedor da base deixar de funcionar, a tela diz isso e oferece a troca, em vez de passar a buscar com outro provedor e não achar nada. Não há mudança no banco: o Google entrega vetores do mesmo tamanho (1536) que a OpenAI. Não exige ação.

  Contribuição de @vgamkt (#1130, entrou pelo #1864).

- **Filtre a lista por várias etiquetas de uma vez — todas (E) ou qualquer uma (OU)** O filtro de etiqueta passa a aceitar mais de uma escolha nas três listas: Inbox, Funil e Contatos. Você marca quantas quiser no menu (o menu não fecha mais a cada clique) e escolhe o sentido:

  - **Todas (E)** — a lista mostra só quem tem todas as etiquetas escolhidas, juntas na mesma caixa (na conversa ou no contato), que era o sentido de filtrar por duas e comparar na cabeça.
  - **Qualquer uma (OU)** — a lista mostra quem tem pelo menos uma delas, em qualquer caixa.

  O modo aparece no menu só quando há duas ou mais etiquetas, porque com uma ele não muda nada. O gatilho do filtro resume a escolha ("vip +1") e "Limpar filtros" continua limpando tudo. Os filtros continuam nos endereços: `?tag=vip&tag=orçamento` com `&modo=ou`, e qualquer link salvo ou chamada de API com uma etiqueta só segue funcionando igual, sem mudança.

  Uma combinação ainda não é possível: "vip na conversa **e** orçamento no contato", misturando as caixas. Ela fica registrada como decisão de produto pendente — as duas caixas de hoje não a expressam, e o filtro não finge que expressa.

  Contribuição de @webtecnica (#1886, issue #1274).

- **Uma área só mostra todos os recursos opcionais, se estão ligados e onde se ajustam** Os recursos que se ligam e desligam estavam espalhados: os módulos do servidor numa tela chamada "Comportamento", as chaves de cada empresa em pelo menos nove telas, e os que dependem do servidor em tela nenhuma. Agora há um lugar que junta tudo.

  - **Quem administra o servidor:** a entrada **Comportamento** do Admin passa a se chamar **Recursos opcionais**, na mesma tela, em três blocos: **Módulos** (os interruptores de sempre), **Comportamento** (as chaves de sempre, mais o caminho para Cadastro e Destinos internos) e **Depende do servidor**, só leitura, que diz se e-mail, Google Agenda, API oficial da Meta, WhatsApp oficial por parceiro, chamada de voz, Nuvemshop, Google Ads, notificação com a aba fechada e transcrição estão configurados, com o que fazer em uma linha. Nenhum valor de segredo aparece, só "configurado" ou "não configurado". A telefonia por SIP aparece como "não dá para ver daqui": ela vive nos contêineres do servidor, fora do alcance do app.
  - **Cada empresa:** tela nova em **Configurações › Sua empresa › Recursos opcionais**, para administrador e gerente. Lista os módulos do servidor ("disponível nesta instalação" ou "desligado por quem administra o servidor"), as chaves da empresa com o estado e as dos agentes numa linha só. O botão **Ajustar** leva à tela onde a chave mora. O gerente vê a lista inteira, mas só ganha o botão onde a tela de destino o aceita.

  A tela central não liga nada: quem liga continua sendo a tela de cada assunto, para não existirem dois lugares gravando a mesma chave. Não há mudança no banco. Não exige ação.

  Pedido do mantenedor (#1876).

- **Confira a senha ao entrar ou criar sua conta** O login e o cadastro, inclusive pelo link de convite, permitem mostrar ou ocultar cada senha digitada. No cadastro, o indicador de força ajuda a escolher uma senha melhor sem mudar as regras de aceitação atuais. Crédito: @matheuspedro360.

  Contribuição de @matheuspedro360 (#1871).

### Corrigido

- **O caminho de um arquivo enviado não sai mais da pasta da conversa por `..`** A conferência de que um arquivo pertence à conversa (`isMediaPathOwnedBy`) olhava só o começo do caminho, `{organização}/{conversa}/`. Um caminho como `{organização}/{conversa}/../../{outra}/arquivo` passava nessa conferência. Agora, depois do prefixo, só são aceitos nomes comuns: nada de `..`, `.`, segmento vazio ou barra invertida. A regra vale para o envio de mídia ao cliente e para o anexo da nota interna. Não foi medido se o Storage chegava a resolver o `..`; o conserto fecha a porta sem depender disso. Nada muda para quem opera a instalação.

  Achado na revisão do #1883, de @webtecnica (#1884).

- **O assistente não grava mais no negócio de outro cliente** Quando o assistente anota algo num negócio durante uma conversa (valor, campos, etapa), ele informa qual negócio é — e às vezes informa errado. Medido em produção em 15 de setembro: o cliente respondeu "sim, já tenho os textos", o assistente tentou anotar num negócio que não existia, a anotação foi recusada e a resposta se perdeu. O caso pior não chegava a dar erro: se o código informado fosse de um negócio real de **outro** cliente, no mesmo funil, a anotação era aceita e ia para a ficha errada.

  Agora toda anotação do assistente numa conversa é conferida contra os negócios da pessoa com quem ele está falando. Se o negócio informado é dessa pessoa, segue. Se não é e ela tem um único negócio aberto, a anotação vai para ele. Com nenhum ou com vários abertos, o assistente recebe a recusa com o motivo e segue a conversa, em vez de escolher por palpite. Anotações feitas por pessoas, pela API ou por automações não mudam. Crédito: @paulolimajr77.

  Contribuição de @paulolimajr77 (#1874).

## [1.61.0] — 2026-09-28

### Adicionado

- **Módulo opcional para quem vende para empresas — Empresas, Pessoas que decidem e importação de planilha** Quem administra o servidor ganha em Sistema › Módulos opcionais a chave "Empresas e pessoas (venda para empresas)", desligada por padrão. Ligada, o CRM de cada empresa passa a ter o cadastro de Empresas (razão social e CNPJ, com os dados públicos preenchidos pela BrasilAPI), as Pessoas que decidem dentro delas, com vários telefones, e a importação de planilha CSV ou Excel (.xlsx) que cria empresa, pessoa e contato de uma vez. As três telas ficam em CRM › Ver tudo. Desligada, nada muda: as telas, o menu e as rotas não existem, e nenhum CNPJ sai do servidor. Anonimizar um contato também apaga o nome da pessoa ligada a ele e as linhas de planilha que falavam dela, e o pedido de acesso aos dados passa a entregar essas informações. Não há ação para quem opera a VPS.

  Contribuição de @renatofortal (#1621, entrou pelo recorte #1860).

- **Grupos de clientes no chat, com resposta dos atendentes** Em **Conexões**, o botão **Grupos** de cada número conectado por QR Code lista os grupos em que ele está. Cada grupo tem uma chave, e todos vêm desligados. Os grupos ligados aparecem no chat com a etiqueta **Grupo**, mostram quem mandou cada mensagem e podem ser respondidos pelos atendentes como qualquer conversa. Grupo sem atendente fica na fila das pessoas (**Aguardando atendente**), nunca na aba do automático, e um grupo fechado volta a abrir sozinho quando chega mensagem nova. **A IA nunca responde em grupo**, e grupo não vira negócio no funil, não entra em campanha nem em listas de contatos. Só o **administrador** liga grupos pela tela. Ao ligar o primeiro grupo de um número, o WhatsApp dele passa a enviar as mensagens de todos os grupos para o sistema, que descarta os não escolhidos. Ao desligar o último, tudo volta a ser como antes. Entram só as mensagens que chegarem depois de ligar. Áudio e imagem mandados em grupo ficam guardados, mas — diferente do que já acontece numa conversa individual — não são transcritos nem descritos automaticamente. Um pedido de LGPD de quem já é contato alcança também o que essa pessoa escreveu nos grupos ligados: a anonimização apaga essas mensagens e a exportação as entrega; o participante de grupo que não é contato não tem pedido por esta tela.

  Contribuição de @bossprt (#1647).

- **Módulo opcional de Honorários para escritórios de advocacia** Contribuição de @nsbastosconsultoria (#1578). Um módulo opcional, **desligado por padrão**:
  contrato de honorários de cada caso (fixo, êxito ou misto), calendário de parcelas, e o agente de
  IA sabendo responder sobre os dois.

  **Instalar.** Quem administra a instalação vai em **Módulos**, no menu do painel da instalação, e
  instala "Honorários" com um clique. As tabelas do módulo só nascem nessa hora (ADR-0002): quem não
  instala não carrega tabela nenhuma, não vê porta no menu e o agente não ganha capacidade nova.

  **Usar.** A tela **Análise › Honorários** registra o contrato e as parcelas. Pagar uma parcela lança
  o valor no caixa da empresa, na conta escolhida, junto com o resto do dinheiro que entra. Um clique
  duplo em "Pagar" lança uma vez só, e a conta tem de ser da própria empresa.
  Toda a equipe vê os contratos; criar, alterar e apagar é de gerente ou administrador, e uma
  parcela paga não se apaga, nem o contrato que a tem.

  **A IA.** O assistente ganha "Ver o contrato de honorários" e "Ver as parcelas", para confirmar o
  modelo de cobrança e o status de pagamento em vez de estimar um número.

  **LGPD.** O pedido de acesso do titular traz os contratos e as parcelas dos casos dele. Os
  contratos não guardam dado pessoal (só valores e o vínculo com o caso), então a anonimização não
  tem o que apagar neles.

### Alterado

- **O README cita a Requesty entre os provedores de IA** A Requesty é provedor do produto desde o #1638, e a linha de IA da tabela de tecnologias do README (português, inglês e espanhol) passa a citá-la. Nada muda no produto nem para quem opera.

  Contribuição de @Thibaultjaigu (#1866).

- **Logo próprio nas telas de acesso respeita o tamanho do arquivo, até 80 px de altura** O logo da marca própria nas telas de entrada, cadastro e recuperação deixa de ter altura fixa de 40 px. Um logo grande passa a ocupar até 80 px de altura (no máximo 192 px de largura), mantendo a proporção. Um logo com menos de 40 px de altura natural deixa de ser ampliado e passa a aparecer **menor** do que antes, no tamanho do arquivo: para ter o logo maior, suba em Marca (`/admin/marca`, a marca da instalação, que é a que as telas de acesso usam) um arquivo com pelo menos 80 px de altura. O logo padrão do produto, usado quando não há marca própria, não muda. Não exige ação para quem não quiser trocar o arquivo.

  Contribuição de @vitorlacerdadigital (#1858).

- **O checkpoint e a abertura do turno saem de inbound-turn.ts para um módulo próprio em abertura/** O arquivo inbound-turn.ts, que concentra o turno de recepção, passou a delegar a dois módulos novos dentro da mesma pasta: abertura/checkpoint.ts guarda o schema do checkpoint, o tipo da linha, a instrução de fechamento, a leitura e a gravação; abertura/ritual.ts guarda o ritual de abertura do turno (ritualBlocks e buildOpeningMessage). O inbound-turn.ts continua importando e reexportando esses símbolos, então quem já os busca por ele — os testes, o follow-up, a resposta de caso, o preview — continua achando os mesmos objetos, sem mudança de comportamento e sem mudança de caminho. A extração é a primeira das três que a issue #636 pede, feita com git mv para o histórico do arquivo acompanhar o módulo novo. Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1861).

- **Roteiro de perguntas já concluído não recomeça para o mesmo cliente, a não ser que o roteiro permita** Um roteiro de atendimento que o cliente já respondeu até o fim não volta a fazer as mesmas perguntas quando ele repete a palavra-gatilho, nem quando um roteador de intenção ou o fim de outro roteiro aponta para ele de novo. Antes, repetir a palavra reabria um cadastro já feito. A palavra-gatilho passa a valer para o próximo roteiro que o cliente ainda não concluiu.

  Cada roteiro pode escolher o contrário: no início do roteiro, a opção **Pode recomeçar para quem já concluiu** faz ele começar de novo, útil para roteiros que se repetem, como agendamento. A opção nasce desligada, inclusive nos roteiros que já existem: quem dependia de um roteiro que recomeça precisa ligá-la nele. Um roteiro encerrado por prazo ou interrompido não conta como concluído e pode começar de novo. Não há mudança no banco.

  Contribuição de @vgamkt (#1130, entrou pelo #1865).

### Corrigido

- **O guardião do espanhol reprova t() sobre o que o operador digitou** A catraca de i18n passa a reprovar `t()` aplicado sobre dado que o operador
  digitou — parâmetro livre de função, não chave de tradução. Foi o defeito do
  PR 600: "Retorno" virando "Seguimiento". Dado de operador não é chave de
  dicionário, traduzi-lo muda o dado na tela.

  - 39 sítios reais (35 pares arquivo + expressão) congelados em
    `DADO_DO_OPERADOR_CONGELADO`, cada entrada com razão escrita; a lista só
    encolhe: entrada que deixa de casar com sítio é vermelho.
  - Literal, tabela de módulo e wrapper passa-adireto seguem passando: nenhuma
    tela legítima começa a reprovar.
  - Os cegos A e B da issue 603 ficam como próximo passo desta mesma entrega.

  Contribuição de @webtecnica (#1867).

- **A nota interna chega na hora para quem pode ver a conversa, e deixa de aparecer para quem não pode** A nota interna (a escrita no modo **Nota interna**, que nunca vai para o cliente) passa a chegar **em tempo real** para os demais atendentes. Antes ela só aparecia para os outros quando alguém recarregava a página: o canal ficava aberto, mas a tabela não estava publicada, e nada avisava do erro.

  As notas também passam a seguir a **mesma regra de visibilidade da conversa**. Numa organização com "ver as conversas" em `own_and_unassigned` (o padrão), o atendente que não pode abrir uma conversa deixa de ler e de escrever notas nela, e quem perdeu a conversa numa passagem de atendimento deixa de ver as notas dela. Antes, qualquer atendente da organização conseguia ler todas. Viewer, manager e admin continuam vendo as notas de todas as conversas que já veem, e o administrador da plataforma continua vendo tudo.

  Não exige ação de quem instalou.

  Contribuição de @webtecnica (#1868, issue #1863).

- **Follow-up de silêncio para de mandar mensagem a cada poucos minutos para o mesmo contato** Um fluxo de follow-up disparado por silêncio (ex.: "Triagem parada") reinscrevia o mesmo contato a cada rodada do relógio (1×/min), assim que o envio anterior terminava — em vez de esperar o intervalo de silêncio configurado (ex.: 2 horas) entre uma tentativa e outra. Um contato que nunca respondia recebia uma mensagem nova a cada poucos minutos, indefinidamente — medido numa instalação real: 32 disparos em cerca de 9 horas para o mesmo número, risco real de o número ser marcado como spam pelo WhatsApp. Agora a varredura respeita o intervalo configurado entre o fim de uma tentativa e o início da próxima para o mesmo contato no mesmo fluxo. Ninguém precisa reconfigurar nada.

  Contribuição de @nsbastosconsultoria (#1578).

## [1.60.0] — 2026-09-28

### Adicionado

- **O ícone enviado em Marca também identifica o aplicativo instalado** O campo de ícone da instalação passa a usar a mesma imagem na aba do navegador e no app instalado no celular, com tamanhos de 192 e 512 pixels. Sem imagem própria, mantém o desenho da marca. PNG ou JPG até 512 KB, sem editar arquivos no servidor. Crédito: @vitorlacerdadigital.

  Contribuição de @vitorlacerdadigital (#1848).

- **Use uma chave OpenRouter para preparar o acervo de conhecimento** O acervo aceita uma chave OpenRouter cadastrada em IA › Credenciais ou na instalação (`OPENROUTER_API_KEY`) para indexar e consultar documentos com o mesmo modelo de embedding. Em IA › Conhecimento, o aviso de chave faltando permite cadastrá-la sem sair da página. A OpenRouter só entra quando não há chave OpenAI nem gateway: quem já usa OpenAI continua com a configuração anterior.

  Contribuição de @obrunogonzaga (#1854).

- **A empresa passa a ter proposta comercial, do rascunho da IA ao PDF que o cliente recebe no WhatsApp** Nova tela Propostas. É módulo opcional, desligado por padrão, com duas chaves: quem
  administra o servidor liga "Propostas comerciais" em /admin/sistema › Módulos
  opcionais (com ela desligada, nenhuma empresa vê a tela, o menu nem as ferramentas
  do agente), e cada empresa liga a dela em Configurações › Propostas. Ligada, o assistente que conversa com o cliente levanta o briefing antes
  de rascunhar — objetivo, entregas, o que o cliente já tem e os acessos,
  responsabilidades, prazo, quem decide e orçamento, e uma referência —, formulando as
  perguntas com as palavras de cada pedido (serve para site, automação ou projeto sem
  nicho), mostra um resumo e só cria o rascunho depois que o cliente confirma. O
  rascunho abre um aviso na Central, aparece em destaque na tela de quem está com o
  CRM aberto e entra no Radar como "proposta esperando revisão"; nada sai para o
  cliente sem uma pessoa revisar. A empresa escolhe os modelos em Configurações ›
  Propostas › Modelos: pode desligar os que vêm com o sistema, editar, criar os dela
  e importar o PDF ou o texto que já usa — a IA divide em seções, troca por campos o
  que muda de um cliente e de um projeto para outro, e mostra o que o modelo vai pedir
  antes de salvar. No editor, "Preencher com a conversa" sugere valores para os campos
  em aberto (você confirma cada um), cada seção pode ser reescrita, e "Ver como o
  cliente recebe" abre o PDF exatamente como ele vai chegar. O envio exige modelo
  confirmado e preços definidos, grava o que foi digitado antes de enviar, numera a
  proposta por organização e ano, e manda o PDF pelo WhatsApp da empresa, com a marca
  dela. Anonimizar um contato (LGPD) também apaga do armazenamento o PDF das propostas
  dele, e o relatório de acesso aos dados passa a listá-las. Nada exige ação de quem
  opera a instalação: quem não liga o módulo não vê diferença nenhuma.

  Contribuição de @paulolimajr77 (#1832).

- **A venda que veio de anúncio pode ir para a Meta pelo próprio canal intermediado, atrás de uma chave que vem desligada** Contribuição de @jmpo (#1819).

  Quando o número de WhatsApp está conectado por um canal intermediado que já
  liga o conjunto de dados da Meta ao número (na tela do próprio provedor), a
  venda fechada no CRM — botão Ganhar, arrasto no quadro ou mover em lote —
  pode ser reportada por esse canal: o evento `Purchase` sai com o valor, a
  moeda, o telefone e o id da conversa, e o provedor completa o vínculo com o
  clique do anúncio.

  **Vem desligado.** Nada muda na atualização: o envio só acontece depois que um
  administrador liga **Enviar vendas pelo canal da conversa** em Configurações ›
  Conversões. Com a chave desligada, nenhum dado da venda sai para o provedor e
  a venda segue na pendência "sem conexão" de sempre.

  Com a chave ligada, o canal só entra quando a organização não tem conexão
  direta com a Meta; quem já configurou a conexão direta segue por ela. A venda
  sai por um caminho só, e a resposta do canal é lida por inteiro — um evento
  recusado dentro de uma resposta de sucesso aparece como recusa na tela de
  conversões, não como enviado.

### Alterado

- **O menu mostra quantos casos e quantas conversas esperam uma pessoa** «Casos» passa a aparecer no menu lateral do grupo de IA, com um número vermelho
  quando há casos em que a IA espera uma pessoa. Antes a tela ficava atrás de
  «Ver tudo em IA», e o caso só era visto por quem fosse procurar. O item «Inbox»
  ganha o mesmo número para as conversas que esperam uma pessoa (a aba Fila) —
  as que a IA passou para a equipe. Sem nada esperando, não aparece número.

  Para o menu continuar cabendo na tela de um notebook, «Roteadores» — que se
  configura poucas vezes — passa a ficar em «Ver tudo em IA».

  Contribuição de @jmpo (#1817).

- **Um gate novo compara o tipo da coluna no banco com o tipo declarado no TypeScript** O repositório ganhou um invariante novo, tests/invariants/tipo-de-coluna-x-typescript.test.ts,
  que compara o TIPO de cada coluna lido do supabase/baseline.sql com o tipo declarado
  na interface do TypeScript, nulidade incluída, e impede que o tipo de uma linha venha
  através de as unknown as, que é o que desliga a checagem do compilador na hora em que
  o dado entra. Ele é o irmão do vocabulario-banco-x-typescript, que compara o CHECK:
  juntos cobrem as duas metades do contrato entre o banco e o código. A cobertura
  inicial é a view ai_provider_credentials_safe contra a interface CredentialRow,
  que é onde nasceu o achado da issue #533. Nada é transcrito de um lado para o
  outro: o banco sai do baseline versionado e o TypeScript sai do próprio arquivo da
  interface, e toda falha de extração passa a recusar em vez de devolver lista vazia.
  Dois defeitos reais que o gate reprovara foram corrigidos junto: a coluna
  api_key_last4 é NOT NULL no baseline e estava declarada como anulável no TypeScript,
  e os três as unknown as CredentialRow[] das telas de Credenciais e de Agentes viraram
  a asserção verificável as CredentialRow[], que o TypeScript confere. Não há ação
  para quem opera a VPS.

  Contribuição de @webtecnica (#1850).

- **Os testes do envio de mensagem usam um dublê só** Os quatro testes do `sendMessageHandler` que ainda montavam o banco à mão passam a usar o dublê compartilhado, e a lista de exceções do gate que exige isso fica vazia: dublê novo feito à mão reprova. Nada muda no produto nem para quem opera.

  Contribuição de @webtecnica (#1843, issue #286).

- **Todo identificador que sai para um serviço de fora tem o limite do serviço conferido em teste** Um registro único lista as fronteiras (nome de sessão do WAHA, chave no Storage, `Idempotency-Key`, cabeçalhos do webhook de saída, sessão WaCalls, `external_id`), cada uma com o limite ou a forma que o serviço impõe e a fonte. O limite do WAHA vem da mesma constante que o código usa, e uma varredura reprova um envio novo para o Storage ou uma chave de idempotência nova que fique fora do registro. Nada muda no produto nem para quem opera.

  Contribuição de @webtecnica (#1851, issue #686).

### Corrigido

- **A resposta enviada pelo CRM não aparece mais duas vezes na conversa** Quando o WhatsApp devolvia o eco de uma mensagem enviada pelo CRM (pelo atendente ou pela IA) quase ao mesmo tempo em que o envio era confirmado, a mesma frase podia aparecer duas vezes na conversa. O eco agora é registrado com o mesmo identificador do envio, e o banco recusa a segunda linha. Mensagens duplicadas antes desta versão continuam no histórico. Nenhuma ação é necessária no servidor.

  Contribuição de @webtecnica (#1855).

- **As telas de convite, de erro e as páginas legais declaram o idioma em que estão escritas** Sete telas já apareciam traduzidas, mas diziam ao navegador que estavam em português: o convite para entrar na equipe, as páginas legais, as de acesso negado (403 e a do painel da instalação), a de erro interno (500), a de conta suspensa e a de acesso revogado. Para quem usa o sistema em espanhol, o leitor de tela lia o texto com a pronúncia do português, e o navegador oferecia traduzir "do português" uma página que já estava em espanhol. No convite, era a primeira tela que o convidado via. Agora essas telas declaram o idioma do texto, como as demais já faziam. Não há nada a fazer na atualização.

  Contribuição de @FabioMundoDigital (#1853).

- **O app instalado usa o nome configurado na marca da instalação** O diálogo de instalação do aplicativo no navegador passa a ler o nome configurado na instalação, em vez de manter o nome da compilação da imagem. A correção preserva as configurações existentes e não exige editar arquivos no servidor. Crédito: @vitorlacerdadigital.

  Contribuição de @vitorlacerdadigital (#1847, fecha #1845).

- **O vigia de saúde ignora a sessão de teste do e2e em vez de vigiá-la como conexão** Os seeds do e2e gravam em `channel_sessions` e nada apaga a linha, então entre uma suíte e outra a conexão de teste continua lá, parada. O cron de saúde varre a tabela, pergunta ao transporte e, com `STOPPED` entre os status que avisam, abria um aviso na Central de quem opera — resíduo de teste virando alarme permanente numa instalação de verdade. A faixa do topo anunciava o mesmo caso, dizendo que nenhuma mensagem entra nem sai por aquela conexão.

  Agora os dois caminhos reconhecem a categoria antes de agir: o cron conta a linha como ignorada sem perguntar nada a ela, e a faixa não a anuncia. A lista é a MESMA que a limpeza de fim de suíte apaga, e mora em `lib/channels/sessoes-e2e.ts` — num só lugar, para não haver uma cópia envelhecendo ao lado da outra. Quem não está na lista continua vigiado e anunciado como sempre, inclusive quando está mesmo caído.

  Este fragmento não cobre a limpeza do resíduo que já existe em instalação (é o script do PR #1051) nem o religamento de sessão parada.

  Contribuição de @webtecnica (#1844, issue #1032).

## [1.59.0] — 2026-09-28

### Adicionado

- **Automação e follow-up ganham o lembrete interno, que cria tarefa para a equipe sem mandar mensagem ao cliente, e os gatilhos por tempo** As regras de automação têm uma ação nova, Criar tarefa. Ela aceita título com
  o nome do contato e do negócio, prazo em dias, responsável (o dono do negócio
  ou uma pessoa escolhida) e prioridade. O responsável recebe o aviso no
  navegador, e a tarefa aparece na linha do tempo do negócio. Os fluxos de
  follow-up ganham o nó Lembrete interno, que faz o mesmo sem enviar nada ao
  cliente. Também ganham a opção Somente interno, que impede a publicação de um
  fluxo com qualquer nó que mande mensagem. Há dois gatilhos novos: N dias sem
  mensagem (da equipe, do cliente ou de qualquer lado) e N dias na mesma etapa.
  Os dois disparam uma vez por episódio, voltam a valer quando chega mensagem
  nova ou o card muda de etapa, e podem ser configurados para respeitar um
  compromisso marcado na agenda. O aviso de data do funil volta a disparar quando
  a data do negócio muda e passa a olhar só negócios abertos. O que já foi
  avisado antes da atualização não é avisado de novo. Não é preciso fazer nada
  na instalação.

  Contribuição de @webtecnica (#1683, fecha #1540).

- **O servidor pode falar com o Supabase por um endereço só dele** Quem tem o Supabase na mesma rede da instalação — Kong, Supabase self-host —
  passa a poder declarar `SUPABASE_SERVER_URL=http://kong:8000` no `.env`. Aí o
  app, o middleware e o worker do agente falam com o banco pelo caminho curto, e o
  navegador continua na URL pública: o endpoint interno deixa de precisar estar
  publicado na internet só para o servidor chegar nele.

  Vazio é o padrão, e vazio é o que toda instalação já faz — nada muda para quem
  não preencher. O valor tem de ser um endereço http(s) absoluto; se não for, o
  servidor avisa no log e volta a usar a URL pública, em vez de derrubar a
  instalação. É runtime puro: trocar o valor não pede rebuild da imagem.

  Contribuição de @webtecnica (#1786, fecha #1082).

### Alterado

- **README em inglês volta a acompanhar o português e o CONTRIBUTING ganha versão em inglês** A decisão do mantenedor de 16/09/2026 (#890) manda `README.md` e `CONTRIBUTING.md` serem
  mantidos em inglês ao lado das versões em português, e ela fecha dois buracos medidos:
  `README.en.md` estava atrás do `README.md` em dois lugares — o parágrafo dos guias do
  assistente de instalação (`scripts/instalar-guias.sh`, `.agents/skills/`) e a seção
  `📁 Estrutura` —, e `CONTRIBUTING.en.md` não existia. Os dois parágrafos foram
  traduzidos para o inglês sem mudar o conteúdo: comandos, caminhos de arquivo e
  identificadores ficaram iguais, e a árvore de diretórios da seção `📁 Structure`
  mantém os mesmos comentários por diretório. `CONTRIBUTING.en.md` é a tradução integral
  de `CONTRIBUTING.md` (234 linhas), e ambos ganharam o seletor de idioma no topo, no
  mesmo formato do `README.md`; os dois links para o CONTRIBUTING dentro do
  `README.en.md` passaram a apontar para a versão em inglês. Nenhum outro arquivo mudou:
  a seção `🧹 Desinstalar` e o comentário das extensões do Postgres continuam fora do
  inglês — drift pré-existente, fora dos dois itens que a decisão nomeou.

  Contribuição de @webtecnica (#1841, issue #890).

- **O lint da suíte passa a rodar o ESLint 10, e sai a versão que o registro do npm aposentou** O `pnpm lint`, executado pelo check obrigatório `verify`, rodava o ESLint 9.39.5, marcado como sem suporte pelo registro do npm. Agora roda o 10.11.0, que produz as mesmas mensagens, arquivo por arquivo, sem nenhuma regra mudada; o `AGENTS.md` declara a major nova e um teste passa a conferi-la. O ESLint não roda no produto: nada muda na imagem nem para quem opera a instalação.

  Levantamento de @melgarafael (#297). Contribuição de @in100tiva (#1840).

### Corrigido

- **No faturamento, cada moeda tem o seu bloco em vez de uma soma entre moedas** Quando o período tinha comandas ou lançamentos em moedas diferentes, a tela de
  Faturamento somava tudo e escrevia o resultado em real: R$ 150,00 e 200,00 €
  apareciam como "R$ 350,00" nos cartões Entrou e Saldo, no faturado e nas listas
  por forma de pagamento, serviço, cliente e comissão, e o ticket médio misturava
  as duas moedas. Agora cada moeda tem o seu bloco, com os seus cartões, o seu
  ticket médio e as suas listas, sem conversão, e a moeda da organização vem
  primeiro. Os lançamentos do período e os lançamentos recorrentes
  (Configurações › Financeiro) passam a mostrar cada valor na moeda da própria
  linha, em vez de sempre em real. A separação é preventiva: as comandas, os
  lançamentos e as recorrências criados pela tela ainda nascem em real, então no
  uso normal os valores continuam saindo em real, como antes; a mistura só
  aparece com dado gravado em outra moeda por fora das telas. Numa organização
  configurada em outra moeda, o período sem movimento mostra o zero na moeda
  dela. O relatório que a tela lê (/api/v1/reports/financeiro) ganha o campo
  por_moeda, com os mesmos totais separados por moeda, e os campos que já
  existiam não mudam. Não exige ação de quem opera a instalação.

  Levantamento de @franceschini-lucas (#1531).

  Contribuição de @in100tiva (#1839).

- **"Sair da lista de espera" e "meu filho não me liga mais" deixam de virar bloqueio** Duas frases de rotina gravavam `is_blocked` sem que a pessoa tivesse pedido
  descadastro. A primeira é o falso positivo que o freio do #1805 consertou em
  "me tira/remove da lista" — só que o irmão dela, "sair da lista", ficou de fora:
  "quero sair da lista de espera" é paciente querendo ser chamado, e "lista de
  presentes" é compra. As duas regras leem hoje a mesma lista de listas de envio,
  de modo que "sair da lista de transmissão" continua bloqueando.

  A segunda é `liga`, que é imperativo informal ("não me liga mais" = ordem) e
  também 3ª pessoa do indicativo ("meu filho não me liga mais" = relato). O que
  separa as duas é o sujeito, e ele vem antes de "não me": havendo sujeito
  explícito de 3ª pessoa — pronome (`ele`), ou nome com determinante (`meu filho`,
  `a doutora`, `meu antigo chefe`) — a frase deixa de ser tratada como pedido.
  Sem sujeito, a ordem continua bloqueando como antes, e "a partir de amanhã não
  me mande mais" também, porque ali vem uma preposição, não um sujeito. O
  sujeito precisa abrir a mensagem ou a frase: numa mensagem sem pontuação como
  "vou bloquear o numero não me liga mais", o pedido continua bloqueando.

  Contribuição de @webtecnica (#1825).

## [1.58.1] — 2026-09-28

### Corrigido

- **A atualização não acusa mais regra de isolamento que sempre esteve no banco** No Ubuntu 26.04 com o idioma do sistema em `en_US.UTF-8` ou `pt_BR.UTF-8` (outras distribuições e o `C.UTF-8` não são afetados), a conferência de regras de isolamento do `update.sh` podia acusar como ausentes regras que estavam no banco, e a atualização parava no meio com a tela de manutenção de pé, mandando procurar uma regra que nunca faltou. Agora a ordenação e a comparação usam ordem de bytes, e o resultado é o mesmo em qualquer idioma. Instalação que nunca passou por esse aviso não muda em nada.

  Se a sua atualização já parou nesse aviso, o `update.sh` que está no disco é o antigo, e é ele que roda a conferência na atualização que traz este conserto, tanto no terminal quanto no botão "Atualizar". Ela pode parar mais uma vez no mesmo aviso. Para sair numa passada só, rode uma vez na pasta do CRM:

  ```bash
  git fetch --tags origin
  git checkout v1.58.1
  bash hostgator-setup-kit/update.sh --to v1.58.1 --force
  ```

  Depois disso as atualizações seguintes voltam a rodar sozinhas.

  Contribuição de @gideony (#1837).

## [1.58.0] — 2026-09-28

### Adicionado

- **O ícone da aba do navegador pode ser uma imagem sua** Em Marca (`/admin/marca`), logo abaixo do logo, há um campo novo para subir o ícone da aba (favicon): uma imagem quadrada em PNG ou JPG, até 512 KB. Ele vale na hora para todas as telas da instalação, inclusive o login, sem reiniciar nada. Sem ícone próprio, a aba continua mostrando a inicial do nome sobre a cor da marca, e remover o ícone volta a esse desenho. Crédito: @Draven9.

  Contribuição de @Draven9 (#1826).

- **O webhook de saída passa a levar id de entrega, número da tentativa e assinatura com carimbo de tempo** A ação "Avisar outro sistema (webhook)" das automações passa a mandar, em toda chamada, quatro cabeçalhos novos: X-Webhook-Delivery, um id que é o mesmo em todas as tentativas da mesma entrega e também no botão Reenviar; X-Webhook-Attempt, o número da tentativa, que no Reenviar continua a contagem; X-Webhook-Timestamp, a hora do envio; e X-Webhook-Signature, uma assinatura que cobre a hora e o id da entrega além do corpo. Com eles, o sistema que recebe consegue recusar uma requisição capturada e repetida e reconhecer uma retentativa como a mesma entrega. O cabeçalho X-Deskcomm-Signature continua saindo exatamente como antes, então quem confere a assinatura não precisa mudar a conferência. Quem passar a conferir o X-Webhook-Signature deve, a partir daí, recusar a requisição que chega sem ele, em vez de cair para o legado: o legado só cobre o corpo, e uma requisição capturada com a assinatura nova apagada seria aceita a qualquer tempo. No corpo entram dois campos: delivery_id, o mesmo id do cabeçalho, e happened_at, a hora em que o fato aconteceu, que é a mesma no Reenviar. O occurred_at não muda: segue sendo a hora em que o sistema montou a entrega, como antes. Para medir a idade da requisição, a medida certa é o t de dentro do X-Webhook-Signature, que é a hora de cada tentativa e é coberto pela assinatura. O X-Webhook-Timestamp leva o mesmo número mas é só informativo: nenhuma assinatura o cobre, assim como o X-Deskcomm-Event e o X-Webhook-Attempt, e medir a idade por ele deixa passar uma requisição velha repetida com esse cabeçalho trocado. O guia de verificação, com exemplos em Node e Python, está em docs/integracao/webhooks-de-saida.md. Proposta de @franceschini-lucas (#1529).

  Contribuição de @in100tiva (#1830).

### Corrigido

- **O inbox não abre mais barra de rolagem lateral com texto longo na memória do contato** Um fato durável registrado em "Memória do contato" (painel lateral da conversa)
  com uma URL ou chave longa, sem espaços, não tinha onde quebrar a linha: o texto
  passava da largura do painel e abria uma barra de rolagem horizontal
  **dentro do painel lateral**. Agora o texto do fato quebra em qualquer ponto e
  cabe na coluna.

  A coluna do CRM também ganhou `min-w-0`, igual à coluna da conversa, como
  defesa uniforme. Um teste novo prende a quebra forçada em todo
  `whitespace-pre-wrap` do inbox, no fato e nesse `min-w-0`.
  Nenhuma tela mudou de estrutura e nenhuma configuração pede ação.

  O #1802 (rolagem com `Shift + Scroll` na conversa) segue aberto: este conserto
  não alcança aquele sintoma.

  Refs #1802

  Contribuição de @webtecnica (#1827).

- **No quadro do funil, o total da etapa separa as moedas em vez de somá-las** Quando uma etapa do funil tinha negócios em moedas diferentes, o total no alto
  da coluna e a linha "ponderado" somavam todos os valores e escreviam o resultado
  na moeda do primeiro negócio: R$ 5.000 e 5.000 € apareciam como "R$ 10.000,00",
  um valor que não existe. Agora cada moeda tem o seu total, lado a lado e sem
  conversão ("R$ 5.000,00 + 5000,00 €"), com a moeda mais frequente da etapa
  primeiro. Quando duas moedas usam o mesmo símbolo, como o peso mexicano e o
  dólar, cada total leva o código da moeda ("$1,500.00 MXN + $100.00 USD"). Etapa
  com uma moeda só continua exatamente igual. Não exige ação de quem opera a
  instalação.

  Levantamento de @franceschini-lucas (#1531).

  Contribuição de @in100tiva (#1829).

## [1.57.0] — 2026-09-27

### Adicionado

- **O caso aberto pela IA aparece no sino na hora, e sai quando é fechado** Quando a IA pede ajuda à equipe sem sair da conversa (um caso esperando uma
  pessoa), o pedido passa a aparecer na Central de alertas no mesmo instante, com
  o botão que abre o caso. Antes ele só aparecia na tela de Casos, e a Central só
  cobrava depois de 24 horas. Quando o caso é concluído, passado para uma pessoa
  ou cancelado, o aviso sai do sino sozinho. O aviso não repete o assunto do
  caso: diz só que a IA pediu ajuda, no idioma da organização.

  Contribuição de @jmpo (#1816).

- **A etapa do funil pode avisar a equipe na Central quando um negócio entra nela** Em Configurações › Funis › Etapas, cada etapa ganhou a chave «Avisar a equipe
  na Central quando um negócio entrar aqui». Ligada, todo negócio que entra
  nela — pelo arrasto no quadro, pelo mover em lote, por uma automação ou pelo
  assistente de IA — abre um aviso na Central com o botão «Abrir negócio».

  Serve para o momento que pede ação e não é o fechamento: numa venda com
  pagamento na entrega, o cliente confirmar o pedido com todos os dados é a hora
  de separar e despachar, e o ganho só vem com a entrega. O aviso diz a etapa,
  nunca o nome ou o telefone do cliente, sai no idioma da organização e não se
  repete enquanto o anterior do mesmo negócio estiver aberto. Vem desligada em
  todas as etapas: nada muda para quem não ligar. Contribuição de @jmpo (#1813).

- **Os avisos que pedem gente chegam ao celular** Com o push ligado no aparelho (Configurações › Notificações), três avisos da
  Central passam a chegar como notificação no celular, mesmo com o CRM fechado:
  a IA passou uma conversa para a equipe, a IA ficou sem saldo no provedor e as
  respostas estão esperando a recarga, e um negócio entrou numa etapa marcada
  para avisar. São os mesmos avisos que tocam som com o site aberto; o resto da
  Central continua só na tela. O texto sai no idioma da organização, sem o nome
  nem o telefone do cliente, e o toque abre a conversa, o negócio ou as
  credenciais. Precisa do par VAPID no `.env` (`VAPID_PUBLIC_KEY` e
  `VAPID_PRIVATE_KEY`), como o push de mensagem nova; sem ele, nada muda.
  Contribuição de @jmpo (#1815).

- **Os avisos que pedem gente tocam o som que a organização escolher** Em Configurações › Notificações, a seção «Sons dos avisos» deixa trocar o som
  de dois momentos da Central: a etapa que avisa (um negócio entrou numa etapa
  marcada para avisar — por exemplo, o pedido confirmado) e o pedido de pessoa
  (o assistente passou a conversa para alguém da equipe, ou ficou sem saldo no
  provedor de IA). MP3, OGG ou WAV de até 1 MB; sem arquivo, toca o som do
  sistema. Todo mundo ouve; trocar é de gestor para cima.

  O som toca com o site aberto, quando o aviso chega na Central — que passa a ser
  relida a cada 30 segundos, em vez de a cada minuto. Contribuição de @jmpo (#1814).

### Corrigido

- **O aviso "já acionei o time" só vai ao cliente se a IA (ou o agente conectado) atendia a conversa — e uma vez por dia** Numa instalação sem agente publicado, o detector de sentimento — que analisa
  toda mensagem, com ou sem agente — podia passar a conversa para a equipe, e o
  cliente recebia "Esse caso é melhor resolvido por uma pessoa. Já acionei o
  time." sem nunca ter falado com a IA. E quando o envio travava e o disparo era
  refeito, o mesmo aviso saía várias vezes seguidas.

  Agora o aviso só sai quando a IA de fato falou naquela conversa antes (ou
  quando foi o agente conectado por MCP quem pediu a passagem), e no máximo uma
  vez por conversa a cada 24 horas. Um aviso que falhou no envio não conta: o
  cliente nunca o recebeu, e o próximo sai. A passagem para a equipe continua
  acontecendo do mesmo jeito; só a frase ao cliente deixa de sair quando não faz
  sentido.

  Contribuição de @jmpo (#1818).

- **No número oficial intermediado, o cliente que chega por anúncio fica marcado — e a hora de entrega e de leitura passa a ser gravada** Quem chegava por um anúncio "Clique para o WhatsApp" pelo número oficial
  intermediado não ficava marcado como vindo do anúncio: o dado chegava num
  lugar do aviso que o CRM não lia. Agora o contato fica marcado com o anúncio de
  origem — que aparece na ficha do contato —, e as vendas desses clientes podem
  ser devolvidas à Meta. Nesse mesmo canal, a conversa passa a guardar a hora em
  que cada mensagem foi entregue e lida, além do tique.

  Contribuição de @jmpo (#1820).

- **No número oficial intermediado, evento sem conta não entra e o estado do número só vale para o próprio número** Evento de mensagem ou de modelo que chega sem a conta de origem passa a ser
  ignorado e fica no arquivo de webhooks, em vez de entrar na caixa de entrada.
  Aviso de estado de número (suspenso, liberado, reativado) só muda o canal
  quando o número do aviso é o número deste canal; se não houver como comparar,
  o aviso fica registrado sem mudar o estado do canal. A tela de conexão passa a
  orientar o preenchimento do filtro de contas na inscrição do webhook no
  provedor.

  Contribuição de @jmpo (#1821, completado no #1823).

- **No número oficial intermediado, a caixa de entrada só recebe o que é do próprio número** O aviso que o provedor intermediado manda ao CRM é por espaço de trabalho, não
  por número: quem tinha mais de uma conta no mesmo espaço (outro número, ou as
  redes de outro negócio) via na conversa de um número mensagens enviadas por
  outro. Agora o evento que traz a conta de outro número é ignorado e fica no
  arquivo de webhooks como "evento de outra conta"; o evento sem conta (como o
  aviso de queda do número) continua valendo.

  Contribuição de @jmpo (#1821).

- **No número oficial intermediado, o lugar escolhido no mapa chega com o link do mapa** Quando o cliente compartilhava um lugar com nome — uma praça, um mercado — em
  vez da própria localização, a conversa mostrava só o nome do lugar, sem o link
  para abrir no mapa. Agora esse pino chega igual ao da localização atual: com o
  nome, o endereço e o link, e o assistente recebe o ponto para o pedido.

  Contribuição de @jmpo (#1820).

## [1.56.1] — 2026-09-27

### Corrigido

- **A anotação interna do compromisso aparece no painel de detalhe da Agenda** O assistente coletava a qualificação inteira do lead, marcava a reunião e gravava
  o resumo na anotação interna do compromisso. A anotação era salva — e não
  aparecia em tela nenhuma: quem ia atender chegava à reunião sem a ficha. Pelo
  caminho da transferência o mesmo resumo chegava à Central; era só o caminho da
  reunião marcada que o perdia.

  Agora o painel de detalhe do compromisso mostra a anotação, com o rótulo
  "Anotação", logo depois da observação. É leitura: nada muda no que sobe para o
  calendário do cliente, que continua usando o campo próprio de observação, e a
  anotação segue interna ao CRM.

  Contribuição de @hiro-nikaitou (#1803, issue #511).

- **O aviso de caso não sai mais para um número que virou de uma conexão da própria conta** Uma conexão de WhatsApp arquivada deixou de contar como número da própria conta,
  para que o número dela pudesse voltar a receber os avisos. Mas arquivar não apaga
  a conexão: se ela for reativada depois, o número volta a ser atendido por um robô
  da própria conta — e o aviso passava a sair para ele, respondendo a si mesmo.

  Agora o envio do aviso confere o destino na hora de sair: se o número voltou a ser
  o de uma conexão ativa da sua conta, o aviso NÃO é enviado, o motivo fica
  registrado no histórico de avisos da tela e um alerta é aberto na Central. O
  atendimento continua na fila, esperando alguém — só não vai para o robô da casa.

  O botão "Enviar aviso de teste" recusa o mesmo número pelo mesmo motivo, em vez
  de mandar a mensagem e aparecer como sucesso.

  Contribuição de @hiro-nikaitou (#1804).

- **Em espanhol, a tela de rastreio e conversões do Google Ads passa a tratar por "tú", e o painel de perdas escreve cada moeda na convenção dela** A tela de rastreio do site e de conversões do Google Ads em espanhol deixou de alternar entre "usted" e "tú" e passou a usar "calificado"/"calificación" em vez das formas peninsulares "cualificado"/"cualificación", como o resto do produto. O painel de perdas das métricas passou a escrever o valor perdido na convenção da própria moeda, com o mesmo formatador da previsão, em vez de sempre no formato brasileiro; em BRL nada muda. Não exige ação de quem opera a instalação. Contribuição de @JowaniOrantes (#1807).

- **Em espanhol, os gatilhos e ações de Webhooks, o papel de assistente com autonomia e a gravidade "informativo" dos avisos da IA deixam de aparecer em português** Nove rótulos que a tela montava a partir de tabelas continuavam em português para quem escolheu espanhol: os gatilhos de agenda (horário marcado, confirmado, remarcado, cancelado), aniversário de contato e prazo de data do funil, a ação "Iniciar fluxo de mensagem" nas regras de Webhooks, o papel "Assistente com autonomia de operação" no convite de equipe e a gravidade "informativo" na Central de avisos da IA. Agora aparecem em espanhol. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Contribuição de @JowaniOrantes (#1808).

- **"Não me contate mais", "não entre mais em contato" e "pode me remover da lista" passam a descadastrar o contato** Três jeitos comuns de pedir para sair não eram reconhecidos, e quem escrevia
  assim continuava recebendo mensagens: "não me contate mais" (e "não me escreva
  mais", "não me chame mais"), "não entre mais em contato" (e "parem de entrar em
  contato comigo") e "pode me remover da lista". Agora eles bloqueiam o contato,
  como "não me mande mais" e "me tira da lista" já faziam.

  A regra continua exigindo que o pedido seja sobre as mensagens: "o dente não
  incomoda mais", "a dor não me perturba mais", "não entre em contato com meu
  marido, fale comigo" e "tira da lista de presentes" seguem sem bloquear. De
  brinde, "me tira da lista de espera", que é paciente pedindo para ser chamado,
  deixou de bloquear.

  Contribuição de @deskcommopp4s-cmd (#1607, trazida no #1805).

## [1.56.0] — 2026-09-27

### Adicionado

- **Busca dentro da conversa, nas mensagens já carregadas** Na Inbox, o botão de lupa no cabeçalho da conversa abre um campo que procura um
  termo nas mensagens que já estão na tela, sem diferenciar maiúsculas. As bolhas
  que batem ganham um contorno, a primeira vai para o campo de visão e um contador
  diz quantas foram achadas. A busca não consulta o servidor: mensagens mais
  antigas só entram depois de "Carregar mais antigas", e o rótulo diz isso para
  que "0" não seja lido como "não existe na conversa". Mensagens apagadas ou
  ocultas ficam de fora. Esc ou o botão de fechar encerram a busca, e trocar de
  conversa também.
  Contribuição de @gustavorodcruz96 (#1793, trazida no #1795).

- **Histórico e diagnóstico das conversões de anúncios** Em Configurações › Conversões, consulte envios por período, situação, plataforma, evento e negócio, com identificação da entrega e protocolo. O diagnóstico mostra ausência de configuração, falhas recentes e envios antigos; uma consulta indisponível aparece como erro, sem sugerir que está tudo funcionando.

  Contribuição de @gustavorodcruz96 (#1789).

- **Conversões do Google Ads por etapa do funil, venda sem valor e telefone criptografado** Em Configurações › Conversões, cada etapa aberta do funil pode enviar a sua própria ação de conversão ao Google Ads quando um negócio entra nela, com nome, categoria e filtro de canal de entrada (todos, só WhatsApp ou só fora dele). O botão "Usar o recomendado" liga as etapas sugeridas, e "Criar no Google" cria a ação de importação de cliques direto na conta quando a instalação tem developer token do Google Ads. A qualificação de etapa única que já existia vira a primeira regra, com o mesmo nome de evento — nada já enviado é reenviado. A venda do negócio ganho pode sair sem valor (nunca como zero), conforme a opção "Valor do negócio"; o padrão continua exigindo valor. Opcionalmente, o telefone do contato vai junto em SHA-256 (E.164), nunca em claro.

  Contribuição de @gustavorodcruz96 (#1789).

- **Links rastreáveis por campanha e instalação do script no site** Configurações › Conversões › Links rastreáveis permite criar, editar e desativar links de WhatsApp por campanha, copiar o script do site e verificar seu carregamento no navegador. A mensagem recebe um código que liga o clique ao contato quando o visitante a envia. A tela mostra cliques, contatos e negócios dos registros ainda retidos, sem apresentar isso como total histórico ou pessoas únicas. Se a gravação do clique falhar, o atendimento continua disponível, sem código de atribuição falso.

  Contribuição de @gustavorodcruz96 (#1789).

### Alterado

- **A checagem de permissão das rotas espera uma ida à rede a menos** Toda rota protegida por papel consultava primeiro o papel da pessoa no banco e,
  só depois da resposta, perguntava ao serviço de login se a sessão devia a
  verificação em duas etapas. As duas leituras agora saem juntas, e a espera
  passa a ser a da mais lenta, não a soma das duas.

  As respostas não mudam: quem não tem papel suficiente continua recebendo a
  recusa por falta de papel, sem que a verificação em duas etapas seja olhada; e
  uma falha ao ler a verificação continua impedindo o acesso quando ela seria
  exigida. Nada fica guardado entre uma requisição e outra.

  Contribuição de @gustavorodcruz96 (#1793, trazida no #1794).

### Corrigido

- **O número de uma conexão removida volta a poder receber os avisos** Ao remover uma conexão de WhatsApp, o número dela continuava sendo recusado como
  destino do aviso de caso, com a mensagem "Esse é um dos números conectados da sua
  conta". A verificação contava a conexão ARQUIVADA como se ela ainda estivesse
  ativa — e, como a conexão que já teve um agente publicado não pode ser apagada, o
  número ficava bloqueado para sempre. Agora a verificação considera apenas as
  conexões ativas. O número de uma conexão em uso continua recusado, que é o que
  evita um aviso respondendo ao outro sem parar.

  Contribuição de @hiro-nikaitou (#1797, issue #1779).

- **Host da Graph em `http` externo deixa de ser aceito em produção** `META_GRAPH_BASE_URL` e `META_ADS_GRAPH_BASE_URL` aceitavam `http://` em qualquer
  ambiente. Em produção o token da Meta viaja no cabeçalho de toda chamada, e um
  endereço externo em `http` o mandaria em texto claro por todo o caminho.

  Agora, em produção, `http://` só passa para destino que não sai da máquina:
  loopback (`127.0.0.0/8`, `::1`), faixas privadas (RFC 1918), ULA e link-local do
  IPv6, `localhost` e nome de serviço sem ponto. Fora daí o valor cai no host real,
  com o mesmo aviso de antes. Fora de produção nada mudou, e o receptor local da
  prova em tela continua aceito — é para isso que ele existe.

  Contribuição de @hiro-nikaitou (#1791, issue #1788).

- **A verificação em duas etapas não é dispensada quando a leitura dos fatores falha** Quando o serviço de login não responde no momento de conferir se a conta tem a verificação em duas etapas, a ação agora é recusada em vez de seguir como se a conta não tivesse o fator. Basta tentar de novo quando o serviço voltar.

- **Levar o negócio para outro funil passa a respeitar os campos exigidos pela etapa de destino** O funil pode declarar que entrar numa etapa exige um campo preenchido, e essa
  régua já valia no arrasto, no lote, no botão de ganhar/perder e nas ferramentas
  do assistente. A tela "Levar para outro funil" era o caminho que faltava: o
  negócio era criado no funil de destino — inclusive numa etapa exigente — com o
  campo em branco, e a exigência só aparecia na próxima escrita, quando o negócio
  já estava lá.

  Agora a troca de funil pergunta a mesma régua antes de escrever, e o campo que
  o negócio novo já traz da origem passa normalmente. Quem não declara etapa
  exigente nenhuma não vê diferença: a recusa só existe onde a exigência já
  estava ligada.

  Contribuição de @hiro-nikaitou (#1798, issue #1710).

## [1.55.0] — 2026-09-27

### Adicionado

- **O canal oficial pode apontar para um servidor de testes próprio** Quem opera a instalação pode, pela primeira vez, mandar o canal oficial do
  WhatsApp falar com um servidor diferente do da Meta, definindo
  `META_GRAPH_BASE_URL` no ambiente. Sem essa variável, nada muda: o sistema
  continua enviando, validando credenciais, baixando mídia, sincronizando modelos
  e registrando webhook exatamente para onde mandava.

  O que se abre com ela é a PROVA EM TELA do canal oficial. Até aqui não havia
  para onde a instalação falar durante um teste de ponta a ponta, porque o endereço
  do provedor estava escrito dentro do código, em onze lugares: a jornada de
  conectar e enviar era coberta só por testes de unidade, que provam a lógica e
  não a conversa de verdade com o outro lado. Com a variável apontando para um
  servidor local, a mesma jornada passa a poder ser exercitada na tela, contra um
  destino que responde. A conta de anúncios tem a sua própria variável,
  `META_ADS_GRAPH_BASE_URL`, justamente para que apontar o canal para o servidor de
  testes não leve junto o relatório de conversão.

  Dois cuidados escritos na própria configuração: o endereço precisa ser uma base
  `http://` ou `https://` de verdade (endereço colado sem esquema, `ftp://`,
  `file://` ou caminho relativo é recusado, com aviso no log, e a instalação volta
  a falar com o endereço de sempre), e ele é decisão da instalação inteira — não
  existe campo na tela nem valor por organização, porque destino de chamada
  definido por tenant mandaria o token de uma empresa por um servidor escolhido
  pela outra.

  Crédito: @webtecnica (#817).

  Contribuição de @webtecnica (#1787, issue #817).

### Alterado

- **Os 12 HANDOFF da raiz foram para docs/handoffs/ e um gate impede a volta** Os arquivos `HANDOFF*.md` de épico saíram da raiz do repositório para
  `docs/handoffs/`, com índice em `docs/handoffs/README.md`, e um teste impede
  que voltem. A regra antiga ("épico vivo mantém o handoff na raiz") saiu do
  `docs/index.md`: item de doutrina envelhece, teste reprova.

  Nada muda para quem opera a instalação.

  Contribuição de @webtecnica (#1771).

- **O caso de aceite que passa pelo agente agora mede o par** A doutrina mandava provar pela tela, e era o que ela cobrava. Só que um caso
  de aceite que atravessa um agente de IA não se prova com o verde do agente: em
  setembro, na validação da v1.12.0, o caso `"quero 2 iphone 15"` passou por uma
  bateria que o esperava reprovar — o agente perguntou se era o 128 ou o 256 — e a
  ferramenta, medida direto com o mesmo texto, devolvia zero. O verde media o
  modelo, não a ferramenta.

  Agora todo caso de aceite que atravessa o agente vem **em par** com a medição
  direta da ferramenta, com o mesmo texto cru, e só conta como prova quando os
  dois lados concordam. A regra está escrita nos guias de aceite, no pré-voo e no
  checklist da triagem, e um teste impede que ela suma sem ninguém ver.

  Nada muda para quem opera a VPS: nenhuma tela, nenhum dado e nenhuma variável de
  ambiente foi tocada.

  Contribuição de @webtecnica (#1781, issue #489).

### Corrigido

- **A fila de remoção de mídia avisa quantas linhas ela expurgou** O cron diário de retenção de mídia deixa de apagar a fila em silêncio. Ele já
  expurgava as linhas de mídia que saíram do bucket havia mais de 90 dias — o
  que impedia a fila de crescer sem teto — mas não dizia quantas: a contagem
  saía só da função interna, não chegava nem no registro de auditoria nem na
  resposta do cron. Agora quem administra o sistema vê, na trilha de auditoria e
  no retorno da rotina, quantas linhas da fila saíram na rodada, inclusive nas
  rodadas em que o expurgo foi a única coisa que aconteceu. Nada a fazer para
  quem já roda o sistema: é contabilidade, não mudança de comportamento do que
  é removido.

  Contribuição de @webtecnica (#1777, issue #1765).

- **A prova de tela passa a ser versionada junto com o repositório** A documentação de QA mandava gravar a evidência visual (screenshots e traces de
  Playwright) numa pasta que o `.gitignore` ignorava. A prova ficava só no
  computador de quem rodou o teste: quem clonasse o repositório recebia o mapa de
  jornadas apontando para imagens que não existiam, e nenhuma imagem aparecia.

  Agora as specs gravam na pasta `evidence/`, que é versionada — quem clona recebe
  a prova. Um teste novo impede que a documentação volte a mandar gravar fora do
  versionamento.

  Nada muda para quem opera a VPS: nenhuma tela, nenhum dado e nenhuma variável de
  ambiente foi tocada.

  Contribuição de @webtecnica (#1770, issue #533).

- **Quem já tinha o DeskcommCRM rodando em ARM (VPS aarch64) volta a conseguir atualizar** Quem já tinha o DeskcommCRM instalado numa VPS ARM (Oracle Ampere, aarch64)
  volta a conseguir rodar `update.sh`. Desde a v1.35.0 a atualização era recusada
  logo na primeira linha, dizendo que só existe VPS x86_64, mesmo onde o CRM já
  estava funcionando. Agora, onde já existe instalação, a recusa vira um aviso e
  as imagens da versão nova são construídas na própria VPS (leva de 15 a 25
  minutos a mais).

  A instalação NOVA continua recusada: quem ainda não instalou precisa de uma VPS
  x86_64, como antes.

  Se a sua VPS ARM está numa versão anterior à v1.35.0, a atualização normal já
  traz este conserto. Se ela já está na v1.35.0 ou mais nova e a atualização vinha
  sendo recusada, o `update.sh` que está no disco é o antigo e continua recusando,
  tanto no terminal quanto no botão "Atualizar". Para sair, rode uma vez na pasta
  do CRM, trocando `vX.Y.Z` pelo número desta versão:

  ```bash
  git fetch --tags origin
  git checkout vX.Y.Z
  bash hostgator-setup-kit/update.sh --to vX.Y.Z --force
  ```

  Depois disso as atualizações seguintes voltam a rodar sozinhas.

  Contribuição de @webtecnica (#1775).

- **Instalar pela primeira vez numa VPS ARM volta a ser recusado, mesmo com o .env já preenchido** Se você começou a instalar o DeskcommCRM numa VPS ARM (Oracle Ampere,
  aarch64) com o `.env` já preenchido — copiado de outra máquina, gerado por
  automação, ou deixado por uma instalação que parou no meio —, o `install.sh`
  não recusava como devia: confundia a pasta com uma instalação que já estava no
  ar e passava 15 a 25 minutos construindo as imagens na própria VPS. Agora ele
  recusa logo no começo e orienta a usar uma VPS x86_64/amd64.

  A instalação passa a ser reconhecida pelo que ela deixou de verdade: os
  contêineres do DeskcommCRM (ou do seu Supabase) no Docker, parados ou
  rodando, ou o arquivo `.deskcomm-instalado` que o próprio instalador grava
  quando termina. Quem já tem o CRM numa VPS ARM continua atualizando
  normalmente, com o aviso e o build local de sempre. Para quem instalou antes
  desta versão e ainda não tem o arquivo, o `update.sh` desta versão em diante
  o grava sempre que termina com o app no ar. Se nessa VPS ARM você derrubou os contêineres
  (`docker compose down` sem `-v`) antes de atualizar, suba-os de novo com
  `docker compose ... up -d` e rode a atualização.

  Se você usa o comando de "recomeçar" (`docker compose down -v && rm -f .env`),
  ele passou a apagar esse arquivo junto — ele faz parte do estado da instalação.

  Contribuição de @webtecnica (#1783, issue #1778).

- **A poda do arquivo de webhooks passa a ordenar o lote e a dizer quando falha** A limpeza automática do arquivo de webhooks passou a apagar em lotes
  **ordenados** (pelo identificador, do mais antigo ao mais novo — a mesma ordem
  que a limpeza do histórico de captação já usa) e a falha do banco deixou de ser
  engolida: ela sobe, responde 500, grava a linha `falhou` na trilha e chega ao
  Sentry — em vez de virar um "não havia nada para apagar" que não era verdade.

  A ordem não é enfeite. O banco de dados usado nas instalações novas recusa
  apagar um lote sem ordem definida, e nenhuma linha do arquivo era removida —
  com o arquivo sendo 468 MB de um banco de 545 MB medido numa instalação real,
  crescendo ~23 MB/dia contra o teto de 500 MB do plano gratuito. Onde a
  limpeza funcionava, a ordem torna o ritmo de esvaziamento reproduzível: hoje
  ela apaga sempre as mesmas linhas mais antigas primeiro.

  Sem ação para quem opera: as duas tabelas, os dois prazos e o tamanho do lote
  são os mesmos. O efeito é que uma instalação em que o banco recusa a limpeza
  passa a ser vista — na trilha e no Sentry — em vez de acumular arquivo em
  silêncio.

  Contribuição de @webtecnica (#1784, issue #1769).

- **A poda do histórico de captação passa a ordenar o lote e a dizer quando falha** A retenção do histórico de leads captados passou a apagar em lotes **ordenados**
  (`id` ascendente, a mesma coluna e a mesma direção da poda de rascunhos), e a
  falha do banco deixou de ser engolida: ela sobe, responde 500, grava a linha
  `falhou` na trilha e chega ao Sentry — em vez de virar um "não havia nada
  vencido" que não era verdade.

  Sem ação para quem opera: as duas tabelas e os dois horizontes são os mesmos. O
  efeito é que a poda deixa de poder escolher um subconjunto arbitrário a cada
  lote, e uma instalação em que o banco recusa o DELETE passa a ser vista.

  Contribuição de @webtecnica (#1768, issue #1721).

- **Voltar e avançar numa spec e2e também esperam a revelação da página** A suíte de e2e passa a esperar o streaming SSR terminar de revelar a página também depois de voltar (`goBack`) e avançar (`goForward`), como carregar e recarregar já esperavam desde o #1706; uma spec que volta a uma tela deixa de poder achar a cópia escondida da revelação e reprovar sozinha.

  Nada a fazer para quem já roda o sistema: a mudança é na suíte de testes, e o aplicativo se comporta exatamente como antes.

  Contribuição de @webtecnica (#1782, issue #884).

## [1.54.0] — 2026-09-27

### Adicionado

- **Aba Graph (Datafy): editar e apagar um modelo sem levar as outras traduções** Na aba **Modelos** do canal Graph (Datafy), os botões **Editar** e **Apagar**
  voltam a aparecer. Eles ficavam desligados porque apagar um modelo por nome
  removia todas as traduções de uma vez, enquanto a tela mostrava um só idioma.
  Agora a operação identifica a variante escolhida (nome + idioma) antes de falar
  com a plataforma: apagar tira só a tradução selecionada, e editar manda o
  conteúdo para a variante certa.

  Apagar continua perguntando antes, mostrando onde o modelo está em uso
  (follow-up ou prompt de agente), e só confirma com a sua confirmação. Se a
  plataforma não devolver a variante, nada é apagado no escuro — a operação
  recusa com o motivo.

  Contribuição de @webtecnica (#1761, issue #1734).

- **A ferramenta de agenda lê um período inteiro, no fuso da empresa e em páginas** A ferramenta `crm_list_appointments` passa a aceitar `de`/`ate` (até 62 dias, a agenda inteira da organização) e paginação por `depois_de`/`proximo`, e cada compromisso traz o nome do contato e do atendente, o tipo, o local e os negócios vinculados — as chaves `contato_id`/`atendente_id` continuam na resposta. O filtro por `dia` passa a contar o dia no fuso da organização. A listagem da agenda pela API recusa com 422 um período acima de 62 dias.

  Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1762).

- **O dono pode impedir que um agente marque novos retornos sem desligar os acompanhamentos configurados** Cada agente passa a ter um controle separado para permitir ou impedir novos retornos prometidos por conta própria. Os acompanhamentos configurados, a consulta e o cancelamento de retornos existentes e os agendamentos de compromisso continuam disponíveis. Agentes existentes mantêm o comportamento atual. Contribuição de @lucasa15 (#1764).

- **Nome da etapa editável direto no cabeçalho do quadro** Em **`/app/pipelines/:id`**, quem é `manager` ou `admin` agora renomeia a etapa clicando no próprio cabeçalho da coluna — sem precisar ir a Configurações › Funis. Salva ao confirmar (Enter ou saindo do campo), nunca a cada tecla, pela mesma rota que a tela de Configurações já usa. Para `viewer`/`agent`, que também abrem este quadro, o cabeçalho continua só leitura.

  Não há ação para quem opera a VPS.

  Contribuição de @lmarceloc (#1738).

- **Dá para trocar entre tema claro e escuro dentro do Modo Plataforma** O Modo Plataforma — a área de administração da instalação, que enxerga todas as
  organizações — não tinha como trocar o tema. Não era só o botão que faltava: o
  atalho de teclado também vive dentro desse botão, então quem estava ali não
  tinha caminho nenhum. Para mudar de claro para escuro era preciso sair para o
  app pessoal, trocar lá e voltar, e nada na tela dizia isso.

  Quem mais sentia é quem acabou de instalar: a instalação cria o dono como
  administrador da plataforma, então o Modo Plataforma costuma ser a primeira
  tela de uma VPS nova.

  Agora o controle fica na própria tarja amarela do topo, ao lado do "Sair pra app
  pessoal". Ele cicla entre claro, escuro e o que o sistema operacional estiver
  usando, e o atalho `Ctrl + Shift + L` funciona ali também. A escolha continua
  valendo nas duas áreas, como sempre valeu.

  A tarja também passou a acompanhar o tema. Antes ela era uma faixa clara fixa,
  que não mudava de cor — no tema escuro ficava gritando no topo da tela.

  Crédito: @Draven9

  Contribuição de @Draven9 (#1757, trazida no #1759).

### Alterado

- **Telemetria atualizada para o Sentry 11, com a coleta de dados pessoais travada no mínimo** O componente que envia relatórios de erro foi atualizado para a versão 11 do
  Sentry. A versão nova passaria a coletar, por padrão, IP, cookies, corpo das
  requisições e o texto trocado com a IA. Aqui essa coleta continua desligada, de
  forma explícita, e a limpeza de dados pessoais (e-mail, CPF, telefone, IP,
  tokens de webhook e de convite) agora é conferida no pacote que de fato sai do
  servidor. Quem usa o padrão (Sentry da comunidade) ou desligou a telemetria
  (`SENTRY_DSN=off`) não precisa fazer nada.

  Se você aponta `SENTRY_DSN` para o seu próprio Sentry, o rastreamento de
  desempenho passa a ser enviado em fluxo contínuo, sem o antigo limite de 1.000
  trechos por requisição. Alguns atributos mudaram de nome (por exemplo,
  `http.method` virou `http.request.method` e `db.statement` virou
  `db.query.text`), então alertas e painéis que filtram pelos nomes antigos
  precisam ser revistos. Se o seu Sentry é auto-hospedado, o SDK novo só dá
  suporte à versão 26.4.2 ou mais nova. Os relatórios de erro continuam chegando
  como antes.

### Corrigido

- **Mídia já removida pode ser enfileirada de novo e a fila deixa de crescer sem teto** A fila de remoção de mídia guarda cada arquivo por `object_path` e a 0432 pedia
  `on conflict (bucket, object_path) do nothing`. Como o worker marca a linha
  como `deleted` e a linha nunca sai da fila, um arquivo NOVO gravado naquele
  mesmo caminho era ignorado em silêncio: não entrava mais na retenção nem na
  anonimização da LGPD, e nenhuma das duas conseguia alcançá-lo depois.

  Agora o conflito reabre a linha só quando ela já terminou — `deleted` ou
  `skipped` volta a `pending` com as tentativas zeradas — e não toca em `pending`
  nem `failed` em curso, que é justamente o `where` que garante isso. O cron
  diário de retenção passa também a expurgar a linha `deleted` da retenção com
  mais de 90 dias, para a fila deixar de crescer sem teto; a linha ligada a um
  pedido LGPD permanece, porque é o registro de que a mídia do titular foi
  removida. Nada a fazer para quem já roda o sistema.

  Contribuição de @webtecnica (#1763).

- **O servidor do app segura a conexão ociosa por mais tempo que o proxy na frente** O app fechava a conexão ociosa com o proxy (Caddy ou Traefik) aos 6 segundos, enquanto o proxy
  a guardava por até 2 minutos para reaproveitar. Quando a próxima requisição saía no instante
  em que o app fechava, ela morria no meio e a pessoa via um erro 502 raro e sem explicação —
  um salvamento podia falhar e dar certo ao tentar de novo. Agora o app segura a conexão por
  125 segundos, e quem fecha primeiro é sempre o proxy. Nada a fazer: vale ao atualizar.

## [1.53.0] — 2026-09-26

### Adicionado

- **O aviso de compromisso por webhook traz horário, situação, tipo, local e negócios, e comparecimento e falta viram gatilho** Os gatilhos `appointment.*` passam a mandar no corpo o início, o fim, a situação, o tipo, o local, o link da reunião (quando houver) e os negócios ligados (`lead_ids`). Nada muda para quem já integra: as chaves antigas continuam com o mesmo nome e o mesmo tipo. Surgem dois gatilhos novos de regra, `appointment.completed` (compareceu) e `appointment.no_show` (faltou), que disparam uma vez por mudança de situação. A ação de webhook ganha a opção "Incluir o responsável no corpo", que vem desligada. Contribuição de @webtecnica (PR #1709, issue #1612).

- **Funis podem exigir campos ao entrar numa etapa ou ao encerrar, e o motivo de ganho vira campo próprio** Na tela de funil, cada campo pode ser marcado como exigido ao entrar em etapas escolhidas, ao ganhar ou ao perder. Sem nenhuma marca, nada muda. Quem arrasta um card sem os dados recebe um diálogo que pede só o que falta. Quando o assistente de IA é barrado, aparece um aviso na Central. O motivo de ganho passa a ser um campo próprio do negócio, com lista e exigência opcionais por funil, e sai no webhook. Contribuição de @webtecnica (PR #1688, issue #1536).

- **Mudar a etapa do negócio pela conversa, sem abrir o quadro do funil** O painel da conversa ganhou o seletor "Etapa do funil" no bloco "Leads
  recentes": quando o cliente confirma pelo WhatsApp, quem atende passa o negócio
  para a etapa seguinte (por exemplo, "Pedido confirmado") sem sair da conversa.
  É o mesmo caminho do "Mover para…" do quadro, então a atividade, a auditoria e
  o aviso da etapa na Central saem iguais. Etapa de perda continua pelo quadro,
  onde se informa o motivo.

  Contribuição de @jmpo (#1726).

- **O follow-up manda modelo aprovado do WhatsApp e respeita o retorno combinado** O passo de mensagem pronta de um follow-up passa a oferecer, além dos textos de
  Ajustes → Modelos, os modelos aprovados no WhatsApp — no canal oficial, o único
  envio que chega ao cliente depois de 24 horas sem resposta. Antes, um passo apontado para um
  modelo aprovado era publicado sem erro e falhava no primeiro disparo. A
  mensagem escrita pela IA também passa a usar o modelo aprovado escolhido como
  plano B quando a janela de 24 horas já fechou; até aqui esse campo era salvo e
  nunca usado. Esse plano B só é exigido na publicação de quem tem conexão com
  janela de 24 horas: quem conecta só por um canal sem janela segue publicando
  sem ele.

  E quando o assistente combina com o cliente um retorno numa data ("te escrevo
  no dia 30"), o follow-up de silêncio não escreve por cima: o contato não entra
  no fluxo enquanto o retorno está agendado, e quem já estava nele fica em espera
  até um dia depois do retorno. O detalhe do follow-up mostra o motivo.

  Contribuição de @jmpo (#1729).

- **Os modelos do provedor intermediado se editam e se apagam pela tela, com prévia como no WhatsApp** Na aba de modelos do provedor intermediado, abrir um modelo mostra a prévia de
  como ele chega ao cliente: o balão com o texto e os botões embaixo, cada um com
  o ícone do tipo. Dois botões novos: **Editar**, que abre o formulário já
  preenchido com o texto aprovado e a prévia ao lado (nome, idioma e categoria não
  mudam, porque a plataforma não deixa), e **Apagar**, que pede confirmação. Se o
  modelo estiver em uso num follow-up ou no prompt de um agente, o apagar mostra
  onde antes de confirmar. Editar manda o modelo de novo para a revisão da
  plataforma, e a Meta limita quantas vezes um modelo aprovado pode ser editado;
  um nome apagado só pode ser reusado depois de 30 dias.

  Contribuição de @jmpo (#1728).

- **Motivos de perda com categoria, filtro por motivo e relatório de perdas** Em **Configurações › Funis**, cada motivo de perda ganha uma categoria (Cliente, Concorrência, Mérito, Nós, Ausência). No quadro, com a aba **Perdidos**, aparecem os filtros **Motivo** e **Categoria**, que viram link (`?motivo=`, `?categoria=`). Em **Métricas**, quem é gerente ou admin vê o relatório **Perdas**: por motivo, por categoria e pela etapa de onde o negócio saiu, com o valor separado por moeda (moedas nunca são somadas). Transferência entre funis não conta como perda. A tool MCP `crm_list_leads` aceita `lost_reason` e `lost_reason_category`.

  A coluna nova `crm_leads.lost_from_stage_id` passa a ser gravada a partir desta versão. Perdas anteriores aparecem como "Etapa desconhecida", porque não há como saber a etapa delas sem inventar.

  Não há ação para quem opera a VPS: funis com motivos só de texto continuam funcionando como antes e nenhum dado existente é reescrito.

  Contribuição de @webtecnica (#1715).

- **Chance de fechamento por etapa e previsão ponderada do funil** Em **Configurações › Funis**, cada etapa aberta ganha o campo **Chance de fechamento (0 a 100)**, calibrado por quem gere a equipe. Etapas de ganho e de perda valem 100 e 0 automaticamente. No quadro, cada coluna mostra o valor **ponderado** abaixo do total. Em **Métricas**, o painel **Previsão** mostra o valor bruto e o ponderado por mês de fechamento previsto e por moeda (moedas nunca são somadas); negócios sem data prevista e em etapa sem chance configurada aparecem à parte, em vez de sumirem como zero. A previsão respeita o que cada atendente pode ver. A API ganha `GET /api/v1/pipelines/{id}/forecast` e a tool MCP `crm_get_pipeline_forecast`; `crm_update_stage` e `crm_list_stages` passam a aceitar e devolver `win_probability`.

  A coluna nova `crm_stages.win_probability` nasce vazia em todas as etapas: nada muda até alguém configurar a chance.

  Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1716, issue #1535).

- **O rascunho sugerido por integração passa a ser apagado 30 dias depois de vencer** O rascunho que outro sistema cria na conversa, o texto sugerido para revisar antes de enviar, guarda uma mensagem escrita para uma pessoa. Depois de vencido ele não abre nem pode ser usado, mas ficava guardado para sempre. Agora a limpeza diária (`data-retention`) apaga o rascunho 30 dias depois do vencimento (mínimo de 7), usado ou não. O que foi enviado continua na conversa, e a criação e o uso continuam na auditoria. Nada a fazer na VPS; o prazo muda com `DRAFT_RETENTION_DAYS` no `.env`. Contribuição de @webtecnica (#1719).

- **A retenção de mídia passa a ser cumprida — arquivos vencidos e órfãos saem do armazenamento** A configuração «retenção de mídia» da organização existia no formulário e não
  era cumprida por nada: todo áudio, foto, vídeo e PDF do WhatsApp ficava no
  armazenamento para sempre, inclusive os de conversas já apagadas. Numa
  instalação no Supabase gratuito isso chega ao limite de 1 GB, e o Supabase
  restringe o projeto inteiro — login, mensagens e agente param juntos.

  Agora, uma vez por dia, o CRM separa para remoção:

  - o arquivo de mensagem mais antigo que a retenção da organização (mínimo 30
    dias). A mensagem continua na conversa, com texto e horário; o arquivo aparece
    como «Mídia indisponível». Se outra mensagem mais recente ainda usa o mesmo
    arquivo (a foto de catálogo reenviada, por exemplo), ele fica;
  - o arquivo que nenhuma mensagem ou contato usa mais (o rastro de conversa
    apagada), depois de um dia de carência.

  As imagens de cabeçalho de modelo nunca são tocadas. A remoção sai pela mesma
  fila da anonimização da LGPD, com reintento. Quem precisa guardar mídia por mais
  tempo aumenta a retenção em Configurações — o padrão segue 365 dias.

  Na primeira rodada depois de atualizar, sai de uma vez o que já passou da
  retenção de cada empresa; com o padrão de 365 dias, hoje isso só alcança
  empresas que configuraram uma retenção menor.

  Contribuição de @jmpo (#1731).

- **Retomada de negócio perdido como novo negócio, por funil** **Retomada de negócio perdido como novo negócio, escolhida por funil.** O funil ganha `settings.reabertura` com dois modos: `mesmo_registro` (padrão, o comportamento de sempre) e `novo_negocio`. No segundo, mover um negócio encerrado para uma etapa aberta não o reabre — o arrasto, o lote, a IA, a automação e a tool MCP devolvem 409 `reabertura_cria_novo`, e a tela oferece "Retomar como novo negócio", que chama `POST /api/v1/leads/{id}/retomar`: nasce um lead novo com o mesmo contato, campos e tags copiados (o que se copia é configurável em `reabertura_campos`), `source = "retomada"` e `retomado_de_lead_id` apontando para o encerrado, que fica intacto, com o motivo dele. É por essa coluna que "quantas tentativas até fechar" passa a ser derivável. O clone entre funis também aceita origem encerrada nesse modo.

  Liga-se em **Configurações › Funis**, na caixa "Negócio encerrado que volta abre um negócio novo". Retomar duas vezes a mesma origem devolve a retomada que já está aberta, e a etapa em que ela nasce aplica os campos obrigatórios do funil.

  Não há ação para quem opera a VPS: a opção nasce desligada e nenhum dado existente é reescrito.

  Contribuição de @webtecnica (#1712).

- **A transcrição de áudio aceita idioma declarado e modelo melhor sem copiar a chave** Quem atende em espanhol ou português pode declarar o idioma dos áudios em
  `TRANSCRIPTION_LANGUAGES` (por exemplo `es`) e trocar o modelo em
  `TRANSCRIPTION_MODEL` (por exemplo `gpt-transcribe`) usando a mesma chave da
  OpenAI já cadastrada na organização — antes, trocar o modelo exigia copiar a
  chave para o `.env`. O motivo é medido: com o padrão, um áudio sem fala virava
  "Thanks for watching!" e "ya es caro" virava "ya es claro", e o assistente
  respondia ao que leu; com o idioma declarado e `gpt-transcribe`, os dois saem
  certos e o áudio sem fala sai vazio. A tela de Provedores passa a mostrar o
  modelo de transcrição que está em uso. Sem essas variáveis, nada muda. Sem a
  chave própria, `TRANSCRIPTION_MODEL` só vale com `TRANSCRIPTION_BASE_URL` vazio:
  quem já tinha o modelo de outro serviço (Groq, por exemplo) no `.env` segue com
  `whisper-1` na OpenAI, como antes.

  Contribuição de @jmpo (#1723).

### Corrigido

- **Repetir uma marcação devolve o compromisso já criado** Retries de uma mesma operação de agendamento passam a reutilizar o compromisso criado e a resposta registrada, tanto pela API quanto pelas ferramentas MCP e pelo runtime nativo do agente. Operações distintas continuam podendo criar compromissos distintos. Contribuição de @lucasa15 (#1735).

- **O aviso ao cliente e o título na Central saem no idioma da organização quando a IA passa a conversa** Quando a IA passava a conversa para a equipe, o cliente recebia o aviso sempre
  em português ("Esse caso é melhor resolvido por uma pessoa…"), mesmo numa
  organização que atende em espanhol — e o aviso na Central aparecia com o título
  em português. Agora os dois saem no idioma da organização: há frases próprias
  em espanhol, e os demais idiomas seguem em português, como antes. Se o idioma
  da organização não puder ser lido, o aviso sai mesmo assim, em português.

  Contribuição de @jmpo (#1725).

- **Com "responder em várias mensagens curtas" ligado, cada parágrafo vira uma bolha, na ordem certa** A opção do agente "Responder em várias mensagens curtas (como uma pessoa
  digita)" dizia ao modelo para preferir várias mensagens a um texto único, e o
  modelo mandava duas ou três de uma vez — que podiam chegar ao cliente fora de
  ordem (a lista de dados de entrega embaralhada, por exemplo). Agora o agente
  escreve uma resposta só e o sistema manda cada parágrafo como uma bolha, na
  ordem e no ritmo de quem digita, como a tela já prometia; resposta curta, de
  uma ideia só, continua saindo numa bolha só, em vez de virar saudação, resposta
  e pergunta em três mensagens. O tamanho máximo por bolha passa a valer só para
  o parágrafo que sozinho é longo demais: antes, parágrafos curtos eram juntados
  até esse tamanho, e com o padrão quase nenhuma resposta era dividida, enquanto
  com um valor baixo o resumo do pedido era cortado no meio de uma linha.
  O teto de mensagens por turno (`MAX_SENDS_PER_TURN`, padrão 3) vale também para
  as bolhas: o que passar dele segue junto na última, sem perder texto e na ordem.

  Contribuição de @jmpo (#1724).

- **O candidato ao golden set sai do disco e vira linha sem texto de cliente** Os candidatos de curadoria que o matcher de skills e o classificador de etapa gravavam em
  `lib/agent-engine/golden-candidates/` deixam de existir como arquivo: agora são linhas em
  `golden_candidates`, com o rótulo (skill + motivo, ou os dois estágios da divergência) e os
  ponteiros do lead e do job — sem texto de cliente. Em desenvolvimento a pasta ficava dentro
  do repositório, e em produção o JSON ia para o disco do contêiner, onde nenhuma tela lia,
  se perdia a cada atualização de imagem e ficava fora da cascata de anonimização. A linha
  nova é alcançada pela retenção (`fn_expurgar_candidatos_do_golden`, 90 dias, piso 30, no
  cron `data-retention`); quem quiser ler a conversa abre a ficha pelo ponteiro. Nada muda na
  operação de quem já roda o sistema.

  Contribuição de @webtecnica (#1720, issue #1695).

- **Candidato a golden set não grava o texto do cliente como ele chegou** Os arquivos de curadoria que o matcher de skills e o classificador de etapa gravam em
  `lib/agent-engine/golden-candidates/` levavam a mensagem do cliente como ela chegou — CPF,
  telefone e e-mail junto. A mensagem agora passa pelo mesmo redator da telemetria antes de
  tocar o disco, e a pasta saiu do git: as duas portas por onde um `git add -A` publicava
  conversa de cliente. Os candidatos que já estavam versionados foram removidos. Nada muda na
  operação de quem já roda o sistema.

  Contribuição de @hiro-nikaitou (#1708).

- **Quando a conta de IA fica sem saldo, as respostas esperam a recarga em vez de se perder** Quando a conta do provedor de IA fica sem crédito, as respostas aos clientes
  não são mais descartadas em dois minutos: ficam esperando e saem sozinhas
  assim que o saldo é recarregado, por até 6 horas. Nesse intervalo aparece um
  único aviso na Central dizendo que a IA está sem saldo e o que fazer; ele se
  fecha sozinho quando a primeira resposta sai. Se alguém da equipe respondeu o
  cliente enquanto a IA esperava, ela não repete a resposta. Na tela de
  Execuções, essa recusa passa a aparecer como limite de uso ou saldo, e não
  como erro desconhecido.

  Contribuição de @jmpo (#1730).

- **Mover um negócio para a etapa em que ele já está não é mais barrado por campos obrigatórios** Em funil que exige campos para entrar numa etapa, mover um negócio para a etapa em que ele
  JÁ está — pelo assistente de IA ou por uma automação — era recusado com a frase dos campos
  obrigatórios, mesmo sem nada mudar de etapa: o que muda ali é a posição dentro da coluna. A
  tela já tratava esse gesto como reordenação; agora o caminho do MCP e o das automações
  tratam igual. A mudança de etapa de verdade continua exigindo os campos.

  Contribuição de @hiro-nikaitou (#1714).

- **A previsão em Métricas mostra o valor certo em moeda sem centavos** No painel "Previsão" de Métricas, o valor ponderado e o bruto de cada mês — e os
  dos negócios sem data ou sem chance definida — apareciam cem vezes maiores em
  moeda sem centavos, como o guarani (₲125.000 saía "Gs. 12.500.000"). Agora o
  painel escreve o valor do mesmo jeito que o quadro do funil ("Gs. 125.000").
  Em real, dólar e demais moedas com centavos nada muda.

  Diagnóstico de @jmpo (#1727).

- **O quadro do funil cabe na tela, e o total da etapa em moeda sem centavos soma certo** Com uma etapa cheia de negócios, a barra para andar para o lado só aparecia no
  fim da coluna mais comprida, e o nome da etapa sumia do alto no caminho. Agora o
  quadro ocupa a altura da tela: a barra lateral fica sempre à vista no pé, e o
  nome e o total de cada etapa ficam presos em cima enquanto os cards rolam.

  O total no topo de cada etapa aparecia cem vezes maior em moeda sem centavos,
  como o guarani (dois pedidos de ₲125.000 somavam "Gs. 25.000.000"). Ele passa a
  somar certo, e o card, o total e o detalhe do negócio escrevem o valor do mesmo
  jeito, na convenção da moeda ("Gs. 125.000").
  A linha "ponderado" das etapas com chance calibrada passa a somar do mesmo
  jeito que o total, sem sair cem vezes maior nessas moedas.

  Contribuição de @jmpo (#1727).

- **O seletor de modelo do atendente não oferece mais modelo de busca, e o fim do onboarding só diz que o atendente está no ar quando ele está** **Quatro correções de tela achadas numa jornada real de dono de clínica.** A lista de modelos do atendente (IA › Agentes › Modelo) deixa de oferecer o modelo de busca do material (Text Embedding), que não conversa: agora só aparecem modelos que usam as ferramentas do CRM, a mesma regra que o sistema já usava para escolher o modelo sozinho. Um agente novo passa a nascer no provedor de IA que a organização já usa, em vez de sempre em Anthropic.

  O diálogo de publicar uma versão fala português: diz a empresa pelo nome, conta os caracteres a mais ou a menos do prompt e explica que a versão anterior continua no histórico; na primeira publicação, diz que é a primeira. E a última página do onboarding pergunta ao banco se há atendente publicado: quem pulou o passo da IA ou deixou o atendente em rascunho vê "Quase lá!" e o que falta, em vez de "Tudo pronto! Seu funcionário já está de pé".

  Não há ação para quem opera a VPS: nenhum dado é reescrito.

  Contribuição de @webtecnica (#1718, #1694).

## [1.52.0] — 2026-09-26

### Adicionado

- **Configure a captura Google e o envio de leads qualificados** Conversões permite configurar o WhatsApp de destino dos cliques Google, preservando gclid, gbraid e wbraid. Um administrador pode escolher uma etapa de qualificação e uma ação Google distinta da compra. Qualificação não envia valor monetário, não é repetida ao voltar à etapa e tem diagnóstico e reprocessamento próprios. As conexões existentes continuam funcionando e a nova regra começa desligada. Contribuição de @gustavorodcruz96 (#1566).

- **Acompanhe e reprocesse conversões de anúncios pelo CRM** A tela de Conversões permite verificar ou tentar novamente uma venda pendente. Novas conexões do Google podem usar a Data Manager API, com acompanhamento do processamento; conexões existentes continuam disponíveis. Recibos inválidos e rejeições deixam de aparecer como sucesso, e eventos de teste da Meta ficam separados das vendas reais. Contribuição de @gustavorodcruz96 (#1566).

- **Instale o rastreio de origem nos botões de WhatsApp do site** Conversões oferece um script para copiar e instalar no site. Ele preserva os identificadores da visita durante a navegação na mesma aba e ajusta os links dos números configurados, incluindo botões adicionados depois. O CRM gera o código curto no clique e associa a mensagem à origem quando o visitante o envia. A instalação é opcional e tem instruções e limites na própria tela. Contribuição de @gustavorodcruz96 (#1566).

- **O instalador pergunta em que idioma ele mesmo fala — português ou español** O `install.sh` estava inteiramente em português, mesmo permitindo escolher espanhol como idioma da aplicação web instalada: um operador hispanohablante precisava entender português para concluir a própria instalação. Agora a primeira pergunta interativa, antes de qualquer outra saída, é o idioma da instalação (Português/Español), e as mensagens do instalador saem nesse idioma; a saída de outros programas, como `docker` e `git`, continua como vem deles. A escolha é gravada em `DESKCOMM_IDIOMA_CLI` no `.env` e, nas reexecuções, o `install.sh` a lê de lá e não pergunta de novo, nem com `--yes`. Quem prefere fixá-la sem perguntar pode rodar com `DESKCOMM_IDIOMA_CLI=es` (ou `pt-BR`) no ambiente. Sem escolha e sem terminal, o instalador fala português, como sempre falou. O espanhol exige bash 4.4 ou superior (o CentOS 7 traz o 4.2): em um bash mais antigo o instalador avisa, em português e em espanhol, e segue em português. Fora do escopo desta passada: `update.sh`, `backup.sh`, `diagnostico.sh` e os demais scripts do kit seguem só em português, mesmo com a chave no `.env`; ficam para uma próxima passada. Contribuição de @JowaniOrantes (#1689).

- **O Jev passa a observar qual agente deve atender, ao lado do seu roteador de intenção** O Jev ganha a terceira tarefa: **Escolher qual agente atende**. Onde há um roteador de intenção ativo (**IA › Roteadores**), a cada mensagem nova do cliente a sua IA de sempre escolhe a intenção — e, com ela, o agente que atende. O Jev responde a mesma pergunta, entre as mesmas intenções, ao mesmo tempo. Enquanto ele só observa, a resposta ao cliente **não espera por ele**: a resposta dele é guardada quando chega.

  A tarefa nasce **só observando**: quem decide continua sendo a sua IA de sempre, e o cartão do Jev, em **IA › Provedores**, mostra quantas vezes os dois levariam o cliente ao **mesmo agente** nos últimos 30 dias — duas intenções que apontam para o mesmo agente contam como concordância. Só depois de comparar, e com um clique de quem administra, dá para deixar o Jev decidir. Decidindo, vale a escolha dele, com o mesmo mínimo de confiança do roteador aplicado à certeza dele, e a sua IA de sempre fica de reserva: ela continua sendo perguntada a cada mensagem, ao mesmo tempo que o Jev (e continua custando), e decide quando ele não responde. A resposta ao cliente espera pelo Jev só o que ele demorar a mais que a sua IA de sempre; a busca da chave dele e a pergunta a ele têm, juntas, um teto de cerca de um segundo e meio. Sem a sua IA de sempre (fora do ar, sem chave, ou devolvendo algo que não é uma resposta), vale o que vale hoje — o agente que já atendia a conversa, ou o "Agente de fallback" do roteador —, nunca só o Jev. Quando o Jev decide e não responde, a sua IA de sempre escolhe no lugar dele, e isso aparece no cartão em "Vezes que a IA de sempre cobriu o Jev" e em **IA › Execuções** — também quando ele nem chega a ser perguntado, por estar sem uma chave que passou no teste ou fora por alguns minutos depois de falhar. O Jev nunca bloqueia, cala ou responde o cliente.

  Na tela do roteador, **"Testar classificação"** passa a mostrar a escolha da sua IA e a do Jev **lado a lado**, com o agente a que cada uma levaria. O teste não entra na comparação do cartão (é uma frase digitada por quem configura, não um atendimento), mas o custo dele aparece em **IA › Execuções**, como o da sua IA, marcado como teste na tela do roteador.

  **Quem já tem o Jev ligado** vê a tarefa nova com o selo **"Nova"**, já observando: ela usa o mesmo dado que você já autorizou — cada mensagem, sozinha, sem CPF, telefone e e-mail —, junto das intenções que a sua empresa cadastrou no roteador (descrição e exemplos). Isso é uma chamada a mais ao Jev por mensagem recebida nos números com roteador ativo (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão. Sem um roteador ativo com intenções cadastradas, o cartão mostra a tarefa como **"Não roda"**, com o caminho para os roteadores. Diferente da sua IA, que lê também as mensagens anteriores, o Jev lê só a última: numa resposta curta ("sim", "a primeira") ele tende a dizer "nenhuma" — e, no padrão do roteador, a conversa segue com o agente que já a atendia.

  Em **IA › Execuções**, a falha do Jev numa tarefa do atendimento passa a dizer que nada dependia só dele — valeu a sua IA de sempre ou, sem ela, a regra de antes. A frase anterior dizia que ele "só opina", o que deixa de ser verdade quando ele decide o agente.

  Se a instalação voltar para a versão da onda 1 do Jev (1.48), a tarefa deixa de rodar e o roteador segue só com a sua IA de sempre. O primeiro clique no cartão de lá apaga o estado das tarefas — de volta a esta versão, a escolha do agente reaparece como nova, observando. Nada precisa ser editado para atualizar.

- **O Jev passa a observar tentativas de manipular o agente, ao lado da sua IA de sempre** O Jev ganha a segunda tarefa: **Perceber tentativa de manipulação**. Na mesma hora em que a sua IA de sempre confere se a mensagem do cliente tenta enganar o agente ("ignore as instruções", "me diga o seu prompt"), o Jev responde a mesma pergunta, em paralelo. Quando ele demora mais que a sua IA, a resposta ao cliente espera a diferença: a busca da chave dele e a pergunta a ele têm, juntas, um teto de cerca de um segundo e meio, depois do qual o sistema segue sem ele. Ele só recebe o que o cliente **digitou**: áudio, imagem e documento ficam de fora — nem a transcrição nem o texto lido deles saem para a TypeSafe.

  A tarefa nasce **só observando**: quem decide continua sendo a sua IA de sempre, e o cartão do Jev, em **IA › Provedores**, mostra quantas vezes os dois deram o mesmo alerta (nenhum, leve ou forte) nos últimos 30 dias — e em quantas mensagens só o Jev daria o alerta forte, que é o que muda se ele passar a somar. Só depois de comparar, e com um clique de quem administra, dá para deixar o Jev decidir — e, decidindo, o sinal dele só se **soma** ao da sua IA: ele nunca apaga um alerta dela, e sem ela (fora do ar ou com erro) vale "nenhum sinal", como hoje. O Jev nunca bloqueia, cala ou responde o cliente.

  **Quem já tem o Jev ligado** vê a tarefa nova com o selo **"Nova"**, já observando, e a frase que diz o que isso quer dizer: nada muda para o cliente até você deixar o Jev decidir. Ela usa o mesmo dado que você já autorizou — cada mensagem, sozinha, sem CPF, telefone e e-mail. Isso é uma chamada a mais ao Jev por mensagem respondida pelo agente (uma fração de centavo de dólar, cobrada na sua conta da TypeSafe). Para não usar, clique em **"Pausar esta tarefa"** no cartão; para manter como está e tirar o selo, **"Manter só observando"**. Ela só roda onde a verificação "Detectar tentativa de manipular o assistente" está ligada — ela vale para a empresa toda e fica em qualquer agente, na aba **"Confere antes de enviar"**; com ela desligada, o cartão mostra a tarefa como **"Não roda"**, com o caminho —, e nunca nos testes do agente nem nas sugestões do modo assistido (lá a IA só sugere, e o cartão segue sem comparação). Essa verificação vem **ligada** para quem nunca mexeu nela, e a aba "Confere antes de enviar" dizia "Desligada" nesse caso, embora ela rodasse; agora a tela diz o que acontece.

  O primeiro número do cartão passa a se chamar **"Respostas do Jev"**: com mais de uma tarefa, cada mensagem do cliente rende uma resposta por tarefa.

  As observações ficam numa tabela própria, sem o texto das mensagens, e são apagadas depois de **90 dias** pela limpeza diária. Para mudar o prazo, use `JEV_OBSERVACOES_RETENTION_DAYS` no `.env` (mínimo de 30 dias). Nada precisa ser editado para atualizar.

  Se a instalação voltar para a versão anterior, a tarefa deixa de rodar lá e o estado dela fica guardado. Voltando para a versão da onda 1 do Jev (1.48), o primeiro clique no cartão de lá apaga o estado das tarefas — de volta a esta versão, a manipulação reaparece como nova, observando. E a 1.48 não sabe pausar só o clima: se você o pausou aqui com "Pausar esta tarefa", lá ele volta a medir enquanto o Jev estiver ligado. Para parar de vez numa volta à 1.48, use "Desligar" no cartão.

- **A integração que repete o pedido não cria dois textos sugeridos** Quando a integração que cria o texto sugerido repete o pedido — timeout, rede, retentativa do
  ERP —, a criação do texto sugerido pela API agora aceita o cabeçalho `Idempotency-Key`, como os
  outros POSTs de criação do produto: a mesma chave devolve a MESMA resposta gravada, sem criar um
  segundo rascunho, e a mesma chave com conteúdo diferente responde 409. Sem o cabeçalho, nada muda
  para quem já integra.

  Contribuição de @hiro-nikaitou (#1704).

- **A conversa pode abrir com um texto sugerido por outro sistema, pronto para revisar** Quem integra o CRM com outro sistema (ERP, formulário, automação) precisa mandar
  uma mensagem que **só pode sair de uma pessoa**: a cobrança vencida, o documento
  que falta, o formulário a reenviar. Até aqui havia duas saídas, e as duas ruins —
  enviar por token (a conversa mostrava "Sistema", sem dizer que pessoa decidiu) ou
  copiar e colar o texto à mão.

  Agora o texto fica guardado no servidor: a integração cria um rascunho pela API
  ou pela ferramenta de criar rascunho do servidor MCP, e recebe o link da conversa.

  Ao abrir o link, a caixa de entrada já mostra o texto no campo de resposta, com o
  aviso "Texto sugerido por {origem}. Revise antes de enviar." — e nada sai sem o
  clique de quem atende. Quando a mensagem sai, o rascunho é marcado como usado,
  com quem o usou.

  O rascunho vale 24 horas, é de uso único e é da mesma empresa: um token de uma
  organização não cria rascunho na conversa de outra. Se o link vencer, já tiver
  sido usado ou apontar para outra conversa, a conversa abre normalmente, sem o
  texto e com o aviso dizendo por quê.

  Quem opera não precisa fazer nada: a capacidade vem da atualização, e o envio
  continua sendo decisão de gente, do jeito que já era.

  Contribuição de @webtecnica (#1684).

### Alterado

- **A Central de avisos mostra os mais graves primeiro** Na aba Abertos, os avisos críticos vêm antes dos de atenção, e estes antes dos informativos; entre avisos da mesma gravidade, o mais recente vem primeiro. Antes, a lista era só por data, e um aviso crítico antigo podia ficar embaixo dos informativos de hoje — ou fora da tela, passados 50 avisos. A aba Resolvidos continua por data. Uma frase no topo da lista explica a ordem. Nada a fazer na atualização.

- **Em espanhol, os erros da API deixam de ter anglicismos e passam a tratar por "tú"** As mensagens de erro da API em espanhol perderam anglicismos soltos ("Agent no encontrado" virou "Agente no encontrado"; "credential", "runs" e "sync" ganharam tradução), passaram a tratar por "tú", inclusive nas telas de roteiros e skills, e "router" virou "enrutador"; "pipeline" e "stage" nas mensagens de erro viraram "embudo" e "etapa", os termos que o resto do produto já usa. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Contribuição de @JowaniOrantes (#1691).

- **O cartão do Jev passa a mostrar cada tarefa com o seu próprio estado** Em **IA › Provedores**, com o Jev ligado, o cartão agora lista as tarefas que ele faz, cada uma com o seu estado ("Só observa" ou "Decide") e o seu botão "Deixar o Jev decidir" — que agora pede confirmação antes de valer, dizendo o que muda para o cliente naquela tarefa e que dá para voltar a só observar quando quiser. Pausar e voltar a só observar seguem com um clique só. O clima (**Medir o clima da conversa**) continua exatamente como estava: quem deixou o Jev decidindo segue decidindo, quem estava só observando segue observando. Nada é reescrito na configuração da empresa.

  O aviso que a Central abre quando o Jev para (chave recusada, crédito esgotado) passa a se chamar **"O Jev parou de funcionar"**. Um aviso que já esteja aberto com o nome antigo ("O Jev parou de medir o clima das conversas") é tratado como o mesmo aviso: é atualizado e se fecha sozinho quando o Jev volta, sem abrir um segundo.

  Se a instalação voltar para a versão anterior, o Jev segue ligado e o clima fica no mesmo "observar/decidir". O primeiro clique no cartão da versão anterior apaga o estado guardado por tarefa, e o clima volta a obedecer só ao "observar/decidir" daquele clique. Duas ressalvas para quem voltar de versão:

  - **Clima desligado sozinho** (com o Jev ligado): a versão anterior não sabe desligar uma tarefa só, e volta a medir o clima no "observar/decidir" de antes. Para ele não medir nada lá, desligue o Jev inteiro antes de voltar.
  - **Aviso aberto com o nome novo**: a versão anterior só reconhece o nome antigo. O aviso "O Jev parou de funcionar" que estiver aberto não se fecha sozinho lá, e uma nova falha abre um segundo aviso com o nome antigo — feche o de nome novo à mão na Central.

### Corrigido

- **O fuso da organização vira o padrão no horário do agente e do atendente, e faltavam textos em espanhol** Ao ligar o horário de funcionamento no gatilho de um agente e ao definir o horário de um atendente, o fuso sugerido era sempre `America/Sao_Paulo`. Agora é o da organização, desde que seja um fuso válido e, no horário do atendente, que esteja entre os fusos oferecidos na lista; caso contrário continua `America/Sao_Paulo`. Em espanhol, apareciam em português os motivos de exclusão de um contato numa campanha ("Sin teléfono en el registro"…) e o resumo do gatilho de um fluxo (Silêncio, "entró en" uma etapa, "no disponible"). Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Contribuição de @JowaniOrantes (#1690).

- **Onboarding com OpenAI não diz mais que uma chave boa falhou no teste de crédito** O teste de crédito do onboarding tratava como falha o 400 que um modelo de raciocínio devolve ao gastar o único token permitido: com a chave boa e com crédito, a tela dizia que o teste não tinha passado, mostrava o erro do provedor em inglês e sugeria falta de crédito. Esse 400 passa a contar como prova bem-sucedida, e quando o teste falha de verdade a tela explica o motivo em português, sem o corpo cru do provedor. Nada muda na publicação do atendente: ela continua exigindo o número de WhatsApp conectado. (#1693)

  Contribuição de @hiro-nikaitou (#1699).

- **O relatório de acesso do titular passa a incluir o que a anonimização apaga** Quem pedia acesso aos próprios dados recebia um relatório que omitia duas coisas que
  o sistema guardava e a anonimização apagava: o texto que outra integração sugeriu para
  enviar à pessoa e as propostas de campo que a IA ouviu na conversa. Nada a fazer na VPS:
  a correção vem com a atualização. Contribuição de @hiro-nikaitou (#1703).

- **Skills antigas deixam de derrubar a tela de habilidades da IA** Instalações atualizadas a partir do formato antigo de skills agora reconciliam os ponteiros automaticamente. A tela continua disponível mesmo quando encontra um registro legado incompleto, e desinstalar uma skill antiga não apaga seu histórico de versões. Contribuição de @423313 (#1705).

- **Teste novo avisa em segundos quando o limite de ferramentas do agente sai da conta** Teste interno, para quem desenvolve: ele confere o limite de ferramentas por agente contra o pacote "Atender" e acusa a mudança em segundos, antes do teste de tela de 20 minutos que era o único a perceber. Nada muda para quem opera a VPS. Contribuição de @realLoganLuo (#1698).

## [1.51.0] — 2026-09-26

### Adicionado

- **O envio de mensagem pela API aceita chave de idempotência e registra o atendente em nome de quem a integração enviou** Integrações que enviam mensagens pelo `POST /api/v1/messages` podem mandar o cabeçalho `Idempotency-Key` (um UUID): uma retentativa com a mesma chave devolve a mesma resposta sem enviar de novo, e a mesma chave com outro conteúdo é recusada. Um token com o novo escopo "Integração pode enviar em nome de um atendente" (marcado na tela de tokens por um administrador) pode informar `on_behalf_of_user_id`; a conversa passa a mostrar "Fulano · via {nome do token}" no lugar de "Sistema". Só atendentes ativos da mesma organização são aceitos. Nada muda para quem não usa esses campos, e não há ação para quem opera a VPS: a coluna nova chega pela atualização normal.

  Contribuição de @webtecnica (#1676).

- **As respostas prontas chegam à integração com as variáveis do próprio integrador** Um sistema de fora que usa as respostas prontas da equipe — para montar um texto, ou para um procedimento interno apontar "use o modelo X" — agora tem o que faltava nas três pontas. A lista das respostas prontas passou a devolver só as compartilhadas com a equipe: um token de integração lia também os rascunhos pessoais que cada atendente escreveu para si, e isso acabou. O preenchimento segue a mesma regra: pedir um rascunho pessoal de outra pessoa pelo id responde que ele não existe, e o agente de IA passa a usar só as respostas compartilhadas. Cada resposta traz agora a lista das variáveis que o texto usa, e quem preenche pode mandar os valores que só o sistema de fora sabe — o link do formulário, o valor em aberto, o número do protocolo (`valores: { link_formulario: "…" }`). Variável fora do formato, variável que vem do contato ou do negócio, ou variável que o modelo não usa é recusada dizendo o nome dela, em vez de sair em branco no meio do texto. E o endereço `/app/templates?modelo=<id>` abre aquele modelo direto, para o link que a integração devolve cair na tela certa — na edição para quem pode editá-lo, e na lista, com o modelo à vista, para quem não pode.

  Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1673).

### Alterado

- **Em "Cadastro", a tela avisa quando a troca de modo ainda não chegou ao cadastro direto do Supabase** Trocar o modo em /admin/cadastro valia na hora para as regras do CRM, mas o cadastro direto do Supabase continuava como estava: no kit de servidor único ele só acompanha no install e no update.sh, e com Supabase separado ele nunca acompanha sozinho. Agora /admin/cadastro confere o que o servidor de login do Supabase está aplicando e avisa quando isso difere do modo gravado. No servidor único, o aviso traz o comando para aplicar já (bash hostgator-setup-kit/update.sh). Com Supabase separado, ele diz o que mudar no painel (Authentication → Sign In / Up → Allow new users to sign up) ou no DISABLE_SIGNUP de um GoTrue próprio. Se não der para perguntar ao GoTrue, não há aviso, e nada é corrigido sozinho: a tela só avisa.

  Contribuição de @webtecnica (#1675), a partir da issue #1668.

- **Envio fora da janela de 24 horas é recusado na hora e a falha de entrega vira gatilho** Quem integra por token em canal oficial passa a receber `422 janela_fechada` ao mandar texto livre com a janela de 24 horas fechada, em vez de `201` seguido de recusa silenciosa da plataforma (código 131047). A resposta traz `use: "template"`, `ultima_mensagem_do_cliente` e `codigo_plataforma`; nada é gravado como enviado. Modelo aprovado, canais sem janela (QR) e quem digita na tela continuam iguais.

  A falha de entrega passa a ser visível de fora: a recusa que chega pelo webhook de status e a falha de pré-voo do próprio envio emitem o gatilho `message.failed` uma vez por falha, com `message_id`, `conversation_id`, `contact`, `sent_via` e `erro { codigo, titulo }`. A mensagem que fica presa em "enviando" e é marcada como falha depois de 5 minutos emite o mesmo formato, com `erro.codigo = send_timeout`. Quem precisar ser avisado cria uma regra de automação com ação de webhook sobre esse gatilho.

  A mudança de resposta vale para quem envia texto livre fora da janela: de `201` para `422`. É a correção do defeito, e a troca é usar modelo aprovado — o mesmo caminho que a tela já sugere.

  Contribuição de @webtecnica (#1677).

- **Logo acima de 512 KB passa a ser recortado e reduzido no navegador em vez de recusado** Em Configurações › Marca, um logo acima de 512 KB não é mais recusado de cara: antes do envio, o próprio navegador recorta a margem totalmente transparente em volta do logo e, se ainda não couber, reduz a largura para 800, 640 ou 512 px, mantendo a proporção e a transparência do PNG. Só quando nem assim cabe a tela mostra a recusa, sem enviar o arquivo. O limite de 512 KB continua o mesmo, e o servidor segue conferindo tamanho e tipo.

  Contribuição de @webtecnica (#1671), a partir do relato de @spoliagency na #1655.

### Corrigido

- **Aba ativa da Inbox visível em colunas estreitas** Na Inbox, a faixa de abas mantém o sublinhado compacto. Ao trocar de aba ou redimensionar a coluna, a visão ativa fica centralizada sempre que possível. Setas discretas indicam abas fora da área visível e avançam para a aba vizinha sem cobrir os nomes.

  Contribuição de @raphaelmartins (#1663).

- **A Agenda lembra o tipo de compromisso escolhido depois de recarregar a página** Escolher o tipo de compromisso na grade da Agenda morria no recarregamento da página: a tela voltava ao primeiro tipo em ordem alfabética e, quando ele não tinha jornada publicada, mostrava "a jornada de atendimento ainda não foi publicada" para quem estava olhando outro tipo. A escolha passa a ficar no endereço da página, como já acontece com a conversa aberta na Inbox — o link aberto em outra aba chega com o mesmo tipo selecionado, e fechar o detalhe de um compromisso não apaga mais a escolha. Quem não escolhe nada continua vendo o primeiro tipo, como sempre. Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1669).

- **No modo assistido, o pedido para parar e o pedido de falar com uma pessoa passam a valer na hora** Com o agente no modo assistido, quando o contato pede para parar de receber mensagens, o atendimento automático agora é silenciado na hora e os follow-ups agendados são cancelados, sem esperar a aprovação de um rascunho. Quando o contato pede para falar com uma pessoa (ou usa a palavra-chave de passagem configurada no agente), abre-se o item de atendimento humano na Central em vez de só um rascunho. Nesses dois casos o contato recebe o mesmo aviso curto de sistema que já recebia no modo automático; nenhuma resposta escrita pela IA sai sem aprovação. O follow-up de um agente assistido, que antes sumia sem aviso, passa a virar rascunho para aprovação.

  Contribuição de @webtecnica (#1667).

- **O controle Confidence threshold sai do editor de agente — ele não controlava nada** Na aba RAG do editor de agente havia um campo "Confidence threshold (0–1)" que prometia passar a conversa para uma pessoa quando a resposta ficasse abaixo do limiar. Ele gravava o valor, mostrava "salvo" e não mudava nada: o único trecho do produto que lia esse número era um bloco do motor antigo que não roda mais desde 07/09. Quem editava um agente de voz mexia num botão que não controlava nada. O campo saiu da tela e o número saiu do formulário; o motor antigo, se algum dia voltar, segue com o limiar que ele já usava quando o campo estava vazio. Nada muda na operação de quem usa o produto hoje.

  Contribuição de @webtecnica (#1670).

- **Corrige convites filtrados por identificação SMTP local em instalações Docker** Corrige uma falha em que o servidor de e-mail aceitava os convites, mas podia filtrá-los depois porque o CRM se identificava como localhost. O envio SMTP passa a usar o domínio já configurado na instalação, sem exigir ajustes manuais no contêiner. A falha foi observada na hospedagem de e-mail HostGator; a correção se aplica ao transporte SMTP em geral.

  Contribuição de @vitorlacerdadigital (#1666).

- **A conexão do dono do banco não entra mais no processo do CRM** Quem declara `SUPABASE_DB_ADMIN_URL` no `.env` (o caso de quem usa Supabase próprio e deixa a atualização rodar sozinha pelo cron) tinha essa conexão, a do dono do banco, entregue também aos contêineres `app`, `worker` e `voice-agent`, porque o compose passa o `.env` inteiro a eles. Nenhum código do CRM a usava, mas ela ficava ao alcance do processo que atende requisição. Agora esses serviços a recebem vazia, e ela continua no `.env` só para o kit (`install.sh`, `update.sh`, backup), que roda no servidor, fora dos contêineres.

  Nada muda na operação: não é preciso editar o `.env` nem rodar nada, e a atualização aplica a mudança sozinha.

  Contribuição de @hiro-nikaitou (#1680).

- **Entrar com Google numa instalação sem o Google ligado mostra o aviso na tela de login, em vez de uma página de erro fora do CRM** Numa instalação sem o provedor Google ligado, clicar em Entrar com Google no login ou no cadastro levava a pessoa para uma página de erro técnica do servidor de autenticação, fora do CRM e sem caminho de volta. Agora o CRM confere antes se o Google está ligado e, se não estiver, a pessoa continua na tela e vê o aviso de que o Google não está habilitado nesta instalação, com o caminho do e-mail e senha. Se a conferência falhar, o botão segue funcionando como antes.

  Contribuição de @webtecnica (#1664).

- **O agente com o provedor personalizado passa a publicar** Quem cadastrou um provedor personalizado compatível com OpenAI (um Ollama exposto, um LiteLLM, um proxy próprio), escolheu o modelo no assistente e clicou em Publicar recebia "Falha ao publicar: model_not_found", mesmo com a credencial validada. Agora a publicação confere o modelo na lista que o próprio endpoint devolveu no teste de conexão: se o modelo está lá, o agente publica; se não está, a recusa continua. Para Anthropic, OpenAI, Google, OpenRouter, DeepSeek e Requesty nada muda.

  Contribuição de @fillipe-felix (#1679).

- **Em "Cadastro apenas por convite", ninguém mais cria conta direto pelo Supabase** Com "Cadastro apenas por convite" ligado, o CRM recusava cadastro sem convite, mas o Supabase continuava aceitando conta nova criada direto pela chave pública do navegador. Agora a atualização fecha também essa porta no Supabase desta VPS (instalação de servidor único), e quem recebeu convite continua criando a conta normalmente. Quem usa o Supabase na nuvem ou em outro servidor pode desligar "Allow new users to sign up" no painel do Supabase, e o convite segue funcionando. Se trocar o modo em /admin/cadastro, rode a atualização para o Supabase desta VPS acompanhar. Relato de @spoliagency na issue #1653.

  Contribuição de @webtecnica (#1665).

- **Entrar com Google entra no CRM direto, em vez de voltar para a tela de login com a sessão já criada** Quem entrava com Google terminava na tela de login, como se o login tivesse falhado — mesmo com a sessão já criada: abrindo o CRM de novo, a pessoa estava logada. A volta do Google passou a entregar uma página do próprio CRM antes de seguir para a tela pedida, o que faz o navegador tratar a navegação seguinte como sendo do próprio site e enviar o cookie de sessão. Os cookies de sessão continuam restritos como estavam, e nenhuma configuração precisa ser mexida. Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1674).

## [1.50.0] — 2026-09-25

### Adicionado

- **Data de nascimento na ficha do contato e no agente** A data de nascimento agora entra pela tela e pela conversa: o diálogo "Editar contato" ganhou o campo "Data de nascimento", a ficha do contato passou a mostrá-la, e o agente de IA consegue propor a data ouvida na conversa pelo mesmo fluxo de aprovação humana que já existe para nome, e-mail e telefone — nada é gravado sem alguém confirmar. Com a data no cadastro, a rotina de aniversários encontra quem parabenizar sem depender de digitação manual. Crédito: @webtecnica (#1650).

- **A tela de credenciais ganha o provedor personalizado compatível com OpenAI** Quem roteia a própria IA por um endpoint próprio — OmniRouter, 9Router, FreellmAPI, LiteLLM hospedado, proxy corporativo — agora encontra a opção **"Provedor personalizado (compatível com OpenAI)"** em **IA › Credenciais**, junto dos provedores de sempre. Dá para informar a base URL e a chave, escolher o modelo no assistente e publicar: o agente conversa por aquele endpoint do mesmo jeito que conversa pelos outros.

  O endereço fica guardado na própria credencial, cifrada como todas as outras — na tela só aparecem os quatro últimos caracteres da chave, e o endereço nunca é impresso em log. Cadastro, teste, validação e o turno do agente leem a mesma escolha.

  Antes de salvar, a tela testa a conexão (`GET {base}/models`, 10 segundos): acertou, mostra a confirmação e quantos modelos o endpoint devolveu; errou, não grava nada e mostra o erro no campo. Depois de gravada, a validação em segundo plano repete a mesma chamada sobre a linha salva.

  O endereço precisa ser público e, em produção, `https://`: como é escolhido por uma empresa, ele passa pela mesma régua dos webhooks e é recusado quando aponta para a rede interna do servidor (localhost, IP privado, metadados de nuvem, serviços do compose) ou quando redireciona. A régua vale no teste, na validação e em cada chamada do agente.

  Nada muda para quem já usa Anthropic, OpenAI, Google ou OpenRouter: a opção nova nasce disponível, não ligada.

  Contribuição de @webtecnica (#1651).

### Alterado

- **Cada organização passa a ter um teto de 50 tokens de API ativos** A emissão de tokens de API (Configurações › API Tokens) passa a parar em 50 tokens ativos por organização, e a trava fica no banco, então vale para a tela, para chamadas diretas e para os tokens temporários que o agente de IA usa em cada atendimento. Tokens revogados ou vencidos não contam: revogar um antigo e emitir um novo sempre funciona, e quem já tem mais de 50 hoje não perde nenhum, só não emite outro até revogar. Ao bater no teto, a tela mostra o limite e como liberar espaço, em vez de um erro interno. Isso fecha a brecha em que emitir mais tokens multiplicava o limite de uso da API. Crédito: @webtecnica (#1658).

### Corrigido

- **O botão "Anonimizar contato" da ficha passa a apagar tudo o que o pedido formal de LGPD apaga** Anonimizar um contato pelo botão da ficha agora usa a mesma redação completa do pedido formal de LGPD: além do contato, das conversas e das mensagens, passam a ser redigidos os pedidos e as vendas (valores e datas continuam, só sai o dado pessoal), as chamadas de voz, a prospecção, os casos do agente e seus avisos, as demandas, as passagens de atendimento, e o consentimento, a origem e as etiquetas do contato. O nome do contato passa a ficar como "Cliente Anonimizado #…", o mesmo rótulo do pedido formal. Contatos anonimizados antes desta versão não são reprocessados. Crédito: @webtecnica (#1659).

- **O Testar do agente consulta o catálogo e o acervo de conhecimento** Na aba Teste do agente, as capacidades "Procurar produto na loja" e "Consultar o que a empresa já sabe" eram recusadas com "Esta consulta precisa de um contato real autorizado". Quem perguntava preço, agenda ou disponibilidade recebia "vou confirmar e já te retorno", como se o catálogo estivesse vazio, embora o mesmo agente respondesse certo no WhatsApp. Agora o Teste faz essas duas consultas como o atendimento real, só leitura. Consultas sobre um contato ou lead continuam exigindo um contato real.

## [1.49.0] — 2026-09-25

### Adicionado

- **A base de conhecimento só reprepara o material que mudou, e ganha o botão "Preparar tudo de novo"** No acervo de conhecimento (IA › Conhecimento), o botão "Preparar tudo de novo" coloca todos os materiais na fila de uma vez: primeiro o que ainda não está pronto, depois o resto. O material cujo conteúdo não mudou desde a última preparação é pulado, sem gastar a chave de IA, e continua marcado como pronto. Um cartão novo mostra quantos materiais estão prontos, quantos ainda estão sendo preparados e quantos falharam. Nos roteiros de atendimento, a resposta que o cliente dá a uma pergunta já encerrada por falta de resposta agora é gravada, em vez de se perder. E o operador de IA passa a receber o identificador real do negócio do contato, em vez de inventar um. A atualização acrescenta uma coluna ao banco (migration 0409) e não pede nenhuma ação.

  Contribuição de @vgamkt (#1130).

- **No canal oficial com coexistência, as respostas dadas pelo app WhatsApp Business aparecem na conversa** Quem usa o mesmo número no app WhatsApp Business e na API oficial (coexistência) passa a ver no CRM as mensagens que a equipe envia pelo celular. Elas entram na conversa como resposta de uma pessoa fora do CRM, e o agente de IA pausa naquela conversa para não responder por cima, como já acontecia no canal por QR. Para ativar, marque o campo `smb_message_echoes` nos webhooks do app na Meta; a aba API Oficial (Meta) já o lista entre os campos a assinar. Quem não usa coexistência não precisa fazer nada.

  Contribuição de @tratham-oficial (#1633).

- **O Testar do agente consegue consultar o banco de dados conectado** Na aba Teste do agente, as capacidades "Ver as tabelas do banco conectado" e "Buscar dados no banco conectado" eram sempre recusadas com "Esta consulta precisa de um contato real autorizado", e o agente respondia "vou confirmar e te retorno", o que parecia erro de configuração da conexão. Agora o Teste executa as duas consultas como o atendimento real: só leitura, com os mesmos limites de linhas, filtros e tamanho da conexão, e só quando o módulo de banco externo está ligado e há conexão ativa.

  Contribuição de @webtecnica (#1636), a partir do relato de @caicoia (#1608).

- **Ligar e desligar o agente pelo celular (#on/#off)** O atendente pode pausar e devolver o atendimento automático de uma conversa digitando `#off` e `#on` no próprio WhatsApp do celular vinculado à organização. Vale por conversa, só quando a mensagem inteira é o comando, e a pausa dura até alguém mandar `#on` ou apertar "devolver ao automático" na tela. O comando é apagado do WhatsApp do cliente logo depois de aplicado, para não aparecer como fala do atendimento. O recurso se liga por agente, no cartão novo **"Comandos pelo celular"** da tela do agente. Com ele ligado, responder o cliente direto pelo celular também pausa a IA até o `#on`. Desligado, que é o padrão, nada muda: `#on` e `#off` são texto comum e a pausa por resposta no celular continua acabando sozinha em 60 minutos. A atualização não pede nenhuma ação.

  Contribuição de @vgamkt (#1130).

- **Link direto para cada conversa da Inbox** Ao abrir uma conversa, o endereço da Inbox passa a incluir o identificador dela. O atendente pode copiar esse link para a equipe; quem tiver acesso à conversa abre o mesmo atendimento, mesmo que ele esteja fora do filtro atual.

  Contribuição de @raphaelmartins (#1629).

- **A Requesty entra como empresa de inteligência artificial do atendente** A Requesty agora aparece na lista de empresas de IA, junto de Anthropic, OpenAI, Google, OpenRouter e DeepSeek. Dá para cadastrar a chave em "IA › Credenciais" ou no passo de treinar durante a instalação, escolher o modelo na tela do assistente e publicar. O agente atende pela Requesty do mesmo jeito que atende pelas outras, com ferramentas (cria o lead, move o card) e com a mesma conferência de chave ao cadastrar.

  Como a OpenRouter, a Requesty é um roteador: uma chave só dá acesso a modelos de vários fabricantes, com ids no formato `fabricante/modelo` (por exemplo `openai/gpt-4o-mini`). Quem precisa manter o tráfego na Europa aponta o endpoint próprio do painel para `https://router.eu.requesty.ai/v1`.

  O catálogo já vem com cinco modelos (GPT-4o mini, GPT-4.1 mini, Gemini 2.5 Flash, Claude Haiku 4.5 e Claude Sonnet 4.5), e a tela escolhe o mais barato que dá conta quando você deixa em branco. Nada muda nas instalações que já usam outro provedor: a opção nasce disponível, não ligada.

  Contribuição de @Thibaultjaigu (#1638).

### Corrigido

- **Alterar um ajuste do agente de IA pela API não apaga mais os outros ajustes** Uma alteração pela API (`PATCH /api/v1/ai/agents/:id`) que mandava só parte dos ajustes do agente, como a temperatura ou a quantidade de trechos da base de conhecimento, gravava os valores padrão por cima de todos os ajustes que não vieram na alteração. Mudar só a busca na base, por exemplo, voltava a temperatura para o padrão. Agora só muda o que foi enviado, e o resto fica como estava. O cartão novo de comandos pelo celular grava por esse mesmo caminho, e por isso já nasce sem o defeito.

- **A atualização para quando o banco não recebe a versão nova, em vez de dizer que deu certo** Quando a atualização do banco terminava com um erro que tentar de novo não resolve (o caso comum é a conexão do `.env` não ser a dona do banco: `permission denied` ou `must be owner`), o `update.sh` avisava no meio da saída e seguia: trocava o app pela versão nova por cima de um banco pela metade e terminava com sucesso. Na atualização automática ninguém via o aviso. Agora a atualização para nesse ponto, depois de conferir as regras de isolamento. O app segue na versão anterior, a tela registra a rodada como falha e o log diz o que fazer: num Supabase próprio, declarar `SUPABASE_DB_ADMIN_URL` no `.env` e repetir com `bash hostgator-setup-kit/update.sh --to <versão> --force`. Quem tem a conexão dona do banco não vê diferença. Disputa com o banco ocupado continua sendo repetida e aceita como antes.

  Contribuição de @hiro-nikaitou (#1640).

- **O backup diário do banco usa a conexão do dono, e não sai mais incompleto** O `scripts/backup-db.sh` (o backup que a documentação manda pôr no cron) agora usa a conexão do dono do banco (`SUPABASE_DB_ADMIN_URL`) quando ela existe, com a conexão do app como reserva — a mesma ordem que o backup do kit já seguia. Antes, numa instalação com role de app menor, o dump salvava só o que essa role enxergava e terminava sem erro. Quem tem só `SUPABASE_DB_URL` não precisa fazer nada: o backup continua igual. Contribuição de @hiro-nikaitou (#1637).

- **O primeiro nome do contato passa a sair nas automações de WhatsApp e nos modelos montados pela integração** Um modelo com a variável `{{primeiro_nome}}` saía com o espaço vazio ("Olá, !") quando era enviado por uma automação de WhatsApp ou montado pela ferramenta de integração `crm_render_message_template`, embora saísse certo quando inserido na conversa. Agora vale a mesma regra da conversa e das campanhas: a primeira palavra do nome do contato. Sem nome cadastrado, a variável continua listada como lacuna para quem montou o modelo.

  Contribuição de @hiro-nikaitou (#1635), a partir do relato de @franceschini-lucas (#1616).

- **O agente espera a foto ficar legível quando o cliente manda a foto e depois escreve** Quando o cliente mandava uma foto (um comprovante, por exemplo) e logo depois escrevia a pergunta em outra mensagem, o turno do agente saía pela mensagem de texto sem esperar a leitura da foto, e o agente pedia ao cliente que descrevesse uma imagem que o sistema terminava de ler segundos depois. Agora a espera olha a conversa inteira: se há mídia recebida ainda sendo lida, o turno aguarda até o mesmo teto de antes, contado a partir da hora em que a mídia chegou. Mídia que o sistema não vai ler (vídeo com leitura desligada, arquivo que não chegou ao storage) não segura a resposta.

  Contribuição de @deskcommopp4s-cmd (#1594).

## [1.48.0] — 2026-09-24

### Adicionado

- **Ligar para o contato direto da conversa** O botão Chamar aparece no cabeçalho da Inbox quando há um contato com telefone e a chamada de voz da organização está pareada. Assim, o atendente inicia a ligação sem sair da conversa. Crédito: @raphaelmartins.

- **O Jev percebe na hora quando o cliente se irrita — desligado até você ligar** IA › Provedores ganhou o cartão "Jev — decisões rápidas". O Jev é um serviço da TypeSafe AI
  que não conversa com o cliente: ele lê cada mensagem que o cliente manda e diz, geralmente em
  menos de um segundo, se o cliente está irritado. É o sinal que o sistema já usa para passar a conversa a uma pessoa
  da equipe. Cada mensagem medida custa uma fração de centavo de dólar, cobrada na sua conta da
  TypeSafe AI.

  Nada muda na sua instalação enquanto você não ligar. Para usar, clique em "Pegar a chave na
  TypeSafe", cole a chave pelo próprio cartão, espere o teste da chave passar e clique em "Ligar
  o Jev". Na primeira vez, quem administra a empresa confirma que concorda com o envio de cada
  mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, nos
  Estados Unidos. Antes de sair, o sistema apaga CPF, telefone e e-mail do texto. Só cadastrar
  a chave não manda nenhuma mensagem de cliente para fora (o sistema só usa a chave para
  testá-la na TypeSafe), e excluir a chave desliga o Jev.

  Se a empresa já tem a IA de sempre, o Jev começa só observando: ela continua decidindo, e o
  cartão mostra em quantas mensagens os dois chegaram à mesma conclusão. Ligado, o cartão mostra
  também quantos clientes irritados o Jev percebeu na semana. Depois de clicar em
  "Deixar o Jev decidir", ele mede primeiro, e a IA de sempre só entra quando ele não responde.
  Numa empresa sem a IA de sempre, o Jev mede sozinho. Se ele falhar, o clima fica sem medida
  até ele voltar.

  As medições aparecem em IA › Execuções, no filtro "Só o Jev", cada uma dizendo se o Jev
  decidiu ou só observou. Quando uma falha pede
  providência (chave recusada, crédito acabado), um aviso na Central diz o que fazer. A política
  de privacidade da instalação passa a citar a TypeSafe AI como fornecedor opcional.

- **Catálogo visual por categorias e cards no modal de ferramentas** O modal de ferramentas agora exibe todas as telas do sistema organizadas em cards visuais agrupados por categoria (Atendimento, CRM, Agente de IA, Canais, Análise e Organização), com pílulas para filtro rápido e busca instantânea. Crédito: @saraivabr.

- **Quem administra pode desfazer o descadastro de um contato** Quando um cliente pede para sair ("parar de me mandar", "sair da lista"), o contato fica bloqueado e nada automático volta a escrever para ele: campanha, follow-up, lembrete e IA param. Até aqui o bloqueio não tinha volta, nem para quem mudou de ideia nem para quem caiu num falso positivo. Agora quem tem papel de administrador vê o botão **Desbloquear** na tela do contato bloqueado. A ação pede confirmação e fica registrada na auditoria (`contact.unblocked`), ao lado do registro do pedido original, que continua lá. Desbloquear devolve o direito de enviar, mas não retoma follow-up nem campanha cancelados, e um novo pedido de descadastro do cliente volta a bloquear o contato.

  Contribuição de @deskcommopp4s-cmd (#1604).

- **Editar e apagar mensagens enviadas pela Inbox** O atendente pode editar uma mensagem de texto própria recente ou apagar uma mensagem enviada para todos diretamente na Inbox quando o canal usa WAHA. O CRM confirma a ação no WhatsApp antes de atualizar o histórico e registra quem a executou.

  As ações ficam no menu da própria mensagem. Após apagar um envio, a Inbox mantém o texto original visível apenas no histórico do CRM, junto do aviso de exclusão.

  Um gestor também pode ocultar uma mensagem recebida na tela do CRM e restaurá-la depois. Essa ação não apaga a mensagem do WhatsApp do cliente nem o registro interno, e fica identificada na conversa.

  Contribuição de @raphaelmartins.

- **Roteiros de atendimento podem ser ligados, com editor, lista e respostas na ficha do cliente** Quem administra o servidor pode ligar "Fluxos de atendimento" no painel de administração do servidor, em Comportamento. Ligado, aparece em IA › Fluxos de atendimento a lista de roteiros e o editor: palavras-gatilho no Início, Perguntas (texto, número, data, sim ou não, lista, CPF com dígito conferido), Skill e Fim — a paleta mostra só essas caixas. O que o cliente respondeu aparece na ficha do contato e no painel lateral da conversa, montado a partir dos campos, e a fila de acompanhamentos ganha o filtro "Coletando respostas do roteiro". Desligado, nenhuma dessas telas aparece e nada muda para quem não usa. O relatório de dados pessoais entregue ao titular (LGPD) passa a listar os campos personalizados do contato, onde os roteiros guardam as respostas.

  Trabalho de @vgamkt, recortado do PR #1130 (terceira de quatro partes).

- **Atualizar lead e marcar/remarcar/cancelar compromisso por integração externa** `PATCH /api/v1/leads/[id]` e `POST/PATCH/DELETE /api/v1/agenda/agendamentos`
  passam a aceitar `Authorization: Bearer dsk_...` (com o escopo `mcp:write`)
  além da sessão do navegador — o mesmo padrão que `/api/v1/messages` e
  `/api/v1/contacts` já usavam. Serve qualquer integração de servidor que precise
  atualizar um negócio ou marcar um compromisso sem navegador (ex.: monitoramento
  de andamento processual via n8n). Na agenda, a chave precisa do mesmo papel
  que as ferramentas de agenda do agente de IA exigem: ao criar a chave em
  Configurações › API Tokens, marque "Tratar o token como gerente" — a chave
  comum (atendente) recebe `403` ao marcar, remarcar ou cancelar, pela API e
  pelo MCP igualmente. Por chave, vale o mesmo teto de escrita do
  envio de mensagens: acima dele a resposta é `429` com `Retry-After`. Nada muda
  para quem usa a tela.

  Contribuição de @nsbastosconsultoria (#1578).

- **Levar um negócio para outro funil pela tela do Kanban** O menu de ações do card, no Kanban, ganha **Levar para outro funil**. Escolha
  o funil de destino e o negócio é recriado lá (na primeira etapa aberta) —
  enquanto o card de origem encerra como perdido, com o motivo "Levado para
  outro funil", e o histórico da troca fica registrado na linha do tempo dos
  dois lados. A rota que faz a troca já existia; faltava a tela.

  Numa instalação com um funil só, a janela explica que é preciso criar outro
  funil antes, em vez de abrir uma lista vazia.

  Contribuição de @nsbastosconsultoria (#1578).

- **A localização que o cliente manda chega com o ponto no mapa** No WhatsApp oficial intermediado, a localização compartilhada pelo cliente
  chegava só como «📍 Location», sem dizer onde era. Agora a ingestão busca as
  coordenadas e grava a mensagem como localização: na conversa aparece um cartão
  que abre o ponto no mapa, e o assistente recebe o link — o pino passa a valer
  como endereço de entrega. Se a busca falhar, a mensagem entra como antes.

  Contribuição de @jmpo (#1584).

- **Escolha um logo para cada tema da marca** A tela de marca aceita uma imagem opcional para o tema escuro, exibida sem moldura branca. O logo atual continua no tema claro e conserva a proteção de contraste no escuro quando não há uma segunda imagem. Instalação e organizações mantêm suas próprias marcas; remover uma arte não apaga a outra. Crédito: @vitorlacerdadigital.

- **Dá para regular o raciocínio dos modelos da OpenAI com OPENAI_REASONING_EFFORT** Os modelos de raciocínio da OpenAI (gpt-5.x, gpt-6) pensam antes de responder, e no atendimento pelo WhatsApp isso vira espera: medido com `gpt-6-luna`, o rascunho levava de 9 a 27 s, com uns 700 tokens de raciocínio para uma resposta de 40, e às vezes o modelo nem chamava a ferramenta de envio. Com `OPENAI_REASONING_EFFORT=none` no `.env`, a mesma chamada caiu de uns 5 s para uns 2 s e chamou a ferramenta todas as vezes. Valores aceitos: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; vazio mantém o padrão do modelo. Vale só para o provedor OpenAI direto e só para modelos que raciocinam (`o*`, `gpt-5*`, `gpt-6*`, fora as variantes `-chat`); os demais seguem sem o campo. Grafia errada impede o worker de subir e o log diz qual variável corrigir. Contribuição de @rogercampel (#1598).

### Alterado

- **A suíte de testes do kit ignora as chaves de IA do terminal de quem a roda** Quem roda a suíte com uma chave de IA exportada no terminal deixa de ver uma falha falsa no caso que instala sem chave. Não há ação para quem opera a VPS. Contribuição de @webtecnica (#1599).

- **A construção das imagens não reinstala as dependências só porque o número da versão mudou** As quatro imagens declaravam o número da versão antes das etapas mais demoradas da construção, e isso fazia o Docker refazer essas etapas em toda versão nova: no worker e no agente de voz, a instalação inteira das dependências; no app e no scheduler, a instalação dos pacotes do sistema. Agora o número entra no fim, e essas etapas são reaproveitadas de uma versão para a outra. Nada muda no que a imagem contém nem no que quem opera precisa fazer. Contribuição de @bonito-system (#1569).

- **Abrir uma conversa no Inbox ancora no final de forma instantânea em vez de rolar suave (#1590)** Ao abrir uma conversa, o operador via a tela rolar animada (`smooth`) desde o topo até a mensagem mais recente, o que causava atraso visual e sensação de lentidão em conversas com histórico longo. A primeira ancoragem agora acontece de forma instantânea (`auto`), mantendo o comportamento de rolagem suave apenas para novas mensagens que chegam após o carregamento inicial.

  Contribuição de @webtecnica (#1617).

### Corrigido

- **A tela de tipos de agendamento não diz mais "nenhum tipo" quando a leitura falhou** Quando a consulta dos tipos de agendamento falhava (por exemplo, num banco em que faltava uma coluna), a tela mostrava "Nenhum tipo de agendamento ainda", mesmo com tipos ativos cadastrados, e quem tentava criar um deles recebia um erro de duplicidade sem explicação. Agora a falha de leitura aparece como falha, com a mensagem do banco e a orientação de recarregar ou avisar quem cuida da instalação. Crédito: @bonito-system.

- **O agente de IA não responde duas vezes à mesma mensagem do cliente** Quando o cliente mandava uma mensagem enquanto o agente ainda terminava a resposta anterior, o turno seguinte já respondia à mensagem nova, e a mensagem nova, que tinha ganhado o próprio turno, era respondida de novo cerca de um minuto depois. O cliente recebia duas respostas quase iguais. Agora o agente confere, antes de responder, se outro turno já leu e respondeu à última mensagem do cliente, e nesse caso não responde de novo. Continua respondendo normalmente quando o turno anterior não chegou a ver a mensagem ou não enviou nada. Crédito: @Gervanno.

- **A atualização instala a última versão publicada, nunca uma etiqueta criada à mão** O `update.sh` e o aviso de versão nova da tela escolhiam a maior etiqueta de versão do repositório. Uma etiqueta criada à mão, sem release publicada, já existiu (a v1.20.0) e teria levado toda instalação a atualizar para um código que ninguém lançou. Agora o kit pergunta ao GitHub qual é a última release estável publicada. Se a consulta não responder, ele diz que não sabe, em vez de escolher uma etiqueta; para instalar uma versão específica continua valendo `--to vX.Y.Z`. Crédito: @bonito-system.

- **O aviso de mensagem retida na conversa mostra o que vale agora e de qual cidade é o horário** O aviso de "mensagem retida" na conversa continuava na tela depois de a mensagem ter saído, e o "fora do horário de envio" seguia aparecendo com o horário já aberto. Agora o aviso some quando uma resposta já saiu depois da retenção e quando o horário de envio está aberto, porque o próximo atendimento já vai reavaliar. O horário também passa a dizer de qual cidade é ("7h–22h, horário de Manaus"), para quem está em outro fuso não ler um horário que não é o seu. Crédito: @bonito-system.

- **Ao ligar um pacote de capacidades que não cabe, o aviso aparece no próprio pacote** Na configuração do agente, ligar um pacote que passaria do limite de capacidades era recusado
  com um aviso no topo do seletor. Com a tela rolada até um pacote lá de baixo (como "Passar para
  um humano"), o aviso ficava fora da vista: o interruptor não mudava e parecia que o clique não
  funcionava. Agora o aviso aparece dentro do cartão do pacote clicado, rola até ficar visível e é
  anunciado por leitor de tela.

  Contribuição de @resdasilva (#1622).

- **O backup só dá o banco como salvo depois de conferir que o arquivo pode ser lido** O backup do banco agora confere o arquivo inteiro antes de dizer que terminou. Se a gravação falhar no meio ou o arquivo sair ilegível, o backup falha e o arquivo é apagado para ninguém confiar nele, e a atualização não segue sem um backup válido. Antes, quando a gravação falhava no meio, o backup acusava a falha, mas o arquivo cortado ficava na pasta de backups junto dos bons. Contribuição de @bonito-system (#1589).

- **Teste novo registra a evidência quando a página chega duplicada** Teste interno, para quem desenvolve: se a página terminar de carregar com uma cópia de si mesma pendurada no fim, o teste guarda o estado e os erros do navegador e reprova. Nada muda para quem opera a VPS. Contribuição de @webtecnica (#1600).

- **O texto digitado na busca de telas mantém contraste nos temas claro e escuro** O campo de busca da paleta agora usa a cor de texto do tema. Isso evita que o texto digitado herde uma cor com pouco contraste, inclusive em instalações com marca própria.

  Contribuição de @raphaelmartins (#1624).

- **A busca de telas (⌘K) fica legível no item destacado, e o "X" dos diálogos se anuncia "Fechar"** Na busca de telas (⌘K ou Ctrl+K), o item destacado mostrava o grupo e a descrição em cinza
  sobre o fundo verde, quase invisíveis. Agora eles aparecem em cor clara e legível, e a
  descrição quebra em até duas linhas em vez de ser cortada no meio.

  O botão "X" que fecha diálogos e painéis laterais era anunciado como "Close", em inglês, para
  quem usa leitor de tela. Agora é anunciado como "Fechar" (em espanhol, "Cerrar").

- **O teste que vigia a escrita na tabela de organizações fecha dois pontos cegos** Teste interno, para quem desenvolve: ele passa a reconhecer funções exportadas de outras formas e o cliente declarado em escopo local. Nada muda para quem opera a VPS. Contribuição de @webtecnica (#1557).

- **A tela Execuções deixa de poder mostrar a chave do provedor de IA numa mensagem de erro** Quando um provedor de IA recusava uma chamada e repetia a chave de acesso no texto do
  erro, a tela IA › Execuções podia mostrar essa chave inteira. O filtro que deveria
  trocá-la por `[CHAVE]` existia, mas nunca funcionou: um caractere invisível no lugar
  errado fazia ele não reconhecer chave nenhuma (Anthropic, OpenAI, Google, OpenRouter,
  nem o cabeçalho de autorização).

  Agora a chave aparece como `[CHAVE]` nas falhas novas. As mensagens que já estavam
  gravadas não são reescritas; se você suspeita que alguma chave apareceu ali, gere uma
  nova no painel do provedor e troque em IA › Credenciais.

- **O clima da conversa passa a ser medido quando a chave de IA foi cadastrada pela tela** O sistema lê o clima de cada mensagem do cliente e chama uma pessoa da equipe quando ele
  se irrita. Esse medidor só funcionava quando a chave de IA estava no arquivo de
  configuração da instalação. Se a chave foi cadastrada pela tela (IA › Credenciais), ele
  não media nada, sem aviso nenhum. O `install.sh` permite pular a chave e cadastrar
  depois pela tela.

  Agora ele usa a chave cadastrada pela tela. Com a Anthropic ou a OpenRouter, a partir
  desta versão o clima passa a ser medido, a conversa com cliente irritado passa para uma
  pessoa, e cada medição aparece em IA › Execuções e entra no gasto de IA do mês.

  Com a OpenAI, o Google ou a DeepSeek, sem um modelo escolhido em IA › Provedores › "Medir
  o clima da conversa", o clima passa a ser medido pelo modelo padrão da empresa — o mesmo
  que o painel já dizia estar valendo ali —, com a chave cadastrada pela tela ou com a do
  arquivo de configuração. Esse modelo costuma ser mais caro que o de classificação; para
  gastar menos, escolha um modelo menor nesse mesmo lugar.

- **Quem sai da empresa devolve as conversas abertas para a fila** Ao remover alguém da organização, as conversas abertas que estavam com essa pessoa continuavam presas a ela, com a IA calada e fora da vista dos outros atendentes, até alguém intervir à mão. Agora elas voltam sozinhas para a fila, a IA volta a atender (menos nas conversas que a própria IA passou para uma pessoa) e a linha do tempo registra a liberação. Contribuição de @webtecnica (#1619).

- **A documentação interna ensina a ler as falhas de carregamento dos testes** Só para quem desenvolve; nada muda para quem opera uma instalação. Contribuição de @webtecnica (#1572).

- **Funil com algumas centenas de negócios volta a abrir** O quadro de um funil com cerca de 400 negócios ou mais parava de carregar. O servidor buscava os dados dos cards (score, próxima ação, contato, conversa) passando todos os ids numa consulta só, e a resposta do banco trazia um cabeçalho maior que o limite do Node — a busca falhava como "fetch failed" e o quadro não abria. Agora essas consultas saem em lotes de 100 ids, e o tamanho do funil não derruba mais o quadro.

- **A junção de fichas de contato herda a identidade social do contato que sai** Quando duas fichas de contato são juntadas, a identidade social (Instagram e outras redes conectadas) do contato que sai agora passa para o vencedor que não tem uma — com a mesma guarda de unicidade dos demais campos herdados e sem sobrescrever a identidade que o vencedor já tinha. Sem isso, a próxima mensagem daquela pessoa por rede social não encontrava a ficha viva e abria uma nova, refazendo a duplicata que a fusão acabou de desfazer. Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1596).

- **A caixa de abas da Inbox volta a ser barata em instalação grande — a RLS de contacts não é mais reavaliada por conversa** Abrir a Inbox e trocar de aba ficava de 1,8 a 2,2 s por contagem numa instalação com 528 conversas, porque a função que decide quem manda na conversa relia a política de isolamento de contatos duas vezes para cada conversa da lista. A partir desta versão ela roda com privilégio próprio sobre uma linha que já passou pela política da própria conversa, e devolve exatamente o mesmo texto de antes — as abas mostram as mesmas contagens. A mudança é só de desempenho no banco: nenhuma ação para quem opera, e a instalação recebe o conserto sozinha na próxima atualização.

  Contribuição de @webtecnica (#1602), a partir da medição de @rogercampel (#1571).

- **Teste novo garante que a configuração de e-mail (SMTP) da instalação só é lida pelo servidor** O teste confere que a tabela, e a senha guardada nela, ficam fora do alcance do navegador, como já acontecia com as configurações irmãs. Nada muda para quem opera a VPS. Contribuição de @webtecnica (#1574).

- **O assistente consegue gravar o pedido no negócio do cliente que está atendendo** Ao fechar um pedido, o assistente chamava a atualização do negócio com o id do contato em vez do id do negócio, e a gravação era recusada: o pedido confirmado ficava sem valor e sem os dados de entrega. Quando o id recebido é o do contato da conversa em curso e ele tem um único negócio aberto, a gravação agora vai para esse negócio. Com dois negócios abertos, nada muda: a escolha continua sendo de quem opera.

  Contribuição de @jmpo (#1583).

- **O negócio só se liga a contato e responsável da própria empresa** Um negócio só pode apontar para um contato da mesma empresa e ter como responsável um atendente ativo dela. A regra agora vale no banco, para todo caminho que grava negócios: tela, agente, token de servidor, automação, importação, webhook de entrada, prospecção, cópia para outro funil e acesso direto à API do banco. Contato de fora recebe "Contato não encontrado", sem dizer se ele existe em outro lugar. Responsável de fora, desligado ou só leitor é recusado. Reenviar o responsável que o negócio já tem continua funcionando, mesmo que ele tenha sido desligado.

  Na atualização, negócios que já apontavam para um contato de outra empresa, ou para um responsável que nunca foi membro dela, perdem esse vínculo, e a linha do tempo de cada um registra o porquê. Negócios de quem foi desligado continuam com essa pessoa como responsável. Mover um negócio de funil não falha mais quando o responsável saiu da empresa: a cópia nasce sem responsável e a linha do tempo explica.

- **A descrição de imagem usa o modelo escolhido para visão mesmo quando o provedor padrão da empresa está sem chave** Quem escolheu um modelo só para ler imagens, mas não tinha chave no provedor padrão da empresa, via a leitura da imagem falhar. Agora o modelo escolhido para imagens é usado primeiro, e o padrão da empresa só entra quando não há escolha. Crédito: @webtecnica (#1618). Relato: @rogercampel.

- **Quem escolheu outra IA na instalação deixa de pedir a ela um modelo da Anthropic** Ao escolher na instalação uma IA diferente da Anthropic (a OpenAI, por exemplo), o
  sistema trocava o provedor da empresa mas deixava gravado o modelo padrão da Anthropic.
  O que usa o modelo padrão da empresa — a medição do clima da conversa, entre outros —
  pedia à OpenAI um modelo que ela não tem, e falhava.

  Agora a instalação grava o provedor junto com um modelo dele. Nas instalações que já
  estão com a combinação errada, a medição do clima passa a usar um modelo do provedor
  escolhido (o marcado como padrão, quando há), sem que você precise mexer em nada. Se você
  já escolheu o modelo padrão em IA › Provedores, a sua escolha continua valendo.

- **O negócio que nasce de uma mensagem vem na moeda da organização** O negócio aberto automaticamente quando um cliente escreve nascia sempre em real (BRL), qualquer que fosse a moeda da organização. Numa empresa em guarani, o valor do pedido gravado depois saía para a plataforma de anúncio como se fosse em real. Agora ele nasce na moeda da organização, e os negócios ainda sem valor que tinham nascido em real são alinhados na atualização.

  Contribuição de @jmpo (#1583).

- **A Central não acusa promessa sem responsável quando o assistente já pediu ajuda à equipe** Quando o assistente respondia «dejame confirmar con el equipo» e abria um caso para uma pessoa, a Central mostrava, minutos depois, o aviso «o assistente prometeu algo e ninguém ficou responsável» para a mesma pergunta. O caso esperando uma pessoa agora conta como responsável. E esse aviso passa a ser escrito no idioma da organização, em vez de sempre em português.

  Contribuição de @jmpo (#1583).

- **O rascunho de resposta chega sem esperar um resumo da conversa que ninguém usa** No modo assistido, depois de escrever o rascunho o agente ainda pedia ao modelo um resumo da conversa (o checkpoint) e só entregava o rascunho quando esse resumo terminava. Nesse modo o resumo não é gravado nem lido por ninguém, e a espera era a maior parte do tempo: medido em produção, a resposta ficou pronta às 12:32:40 e o rascunho só apareceu às 12:32:56 — 16 dos 28 segundos depois de "Sugerir resposta". Agora o rascunho sai assim que a resposta fica pronta. O teste do agente (a tela de prévia) continua mostrando o resumo, e o aviso de "o agente não propôs uma resposta" continua valendo.

  Contribuição de @rogercampel (#1605).

- **Os candidatos da prospecção nativa agora têm prazo, e é o cron quem apaga** Nome, telefone e endereço de pessoas pesquisadas pela prospecção ficavam guardados para sempre. Agora o apagador diário (`data-retention`) remove o que passou de **365 dias** (mínimo de 90), contando da criação para quem nunca foi contatado e da última tentativa para quem já recebeu mensagem. Quem pediu para não ser contatado continua registrado, para que uma nova importação não traga a pessoa de volta. Nada a fazer na VPS; o prazo muda com `PROSPECCAO_RETENTION_DAYS` no `.env`.

  Contribuição de @webtecnica (#1577).

- **O aviso de que o automático volta em instantes não empurra mais os botões da conversa para baixo** Quando aparecia o aviso "Automático volta em instantes" (ou outro aviso de que o atendimento automático está pausado), ele ficava na mesma linha do nome do contato. O cabeçalho da conversa ficava mais largo e a barra de botões inteira descia para a linha de baixo. Agora o aviso fica logo abaixo dos botões, e todos os botões de quem atende continuam visíveis; quando a tela é estreita, eles passam para uma segunda linha em vez de sumir. Contribuição de @raphaelmartins (#1625).

- **O agente usa o modelo do número da conversa, não o de outro canal com o mesmo nome** Quando a organização tem o WhatsApp oficial da Meta e um canal parceiro com um modelo de mensagem de mesmo nome e idioma, o agente de IA podia montar e conferir o texto do modelo do outro número antes de enviar. Agora ele usa a mesma regra do envio pela tela: a definição do próprio número e, no canal oficial, a da conta desse número. Crédito: @bonito-system.

- **Retorno de OAuth de redes sociais preserva a sessão em SameSite=Strict** O retorno da autorização OAuth de canais sociais agora passa por `/auth/social-return`, um documento intermediário sem efeitos que realiza uma navegação interna same-origin para `/app/connections?aba=sociais`. Isso garante que navegadores enviem os cookies de sessão de volta mesmo sob a política `SameSite=Strict`, evitando redirecionamentos indesejados para a tela de login. Conexões pendentes antigas também são recuperadas de forma transparente no proxy. O aviso de autorização concluída ou não concluída na aba Redes sociais continua aparecendo na volta: a página intermediária passa adiante só esse sinal, sem repetir nenhum dado recebido do provedor.

  Contribuição de @saraivabr (#1579).

- **A documentação do token de servidor descreve o formato que o sistema de fato emite** Só documentação (`dsk_` e o prefixo que a tela mostra); nenhum token muda e não há ação para quem opera a VPS. Contribuição de @webtecnica (#1601).

- **Mensagem de WhatsApp que chega com o banco indisponível não se perde mais** Se o banco de dados demorava ou ficava fora por um instante (reinício, backup, sobrecarga) no momento em que um cliente mandava mensagem, ela era descartada em silêncio: não aparecia no Inbox e a IA não respondia. Agora o CRM pede ao WhatsApp que reenvie a mensagem, e o que ainda assim não entrar é reprocessado automaticamente a cada minuto, por até cerca de 20 minutos. Se mesmo assim a mensagem não puder ser gravada, um aviso aparece na Central pedindo para conferir as conversas no celular do número. Crédito: @Gervanno.

- **O worker de respostas automáticas usa a chave da instalação quando a conta não tem chave** Numa instalação cujo provedor registrado na organização não tem chave no `.env` (o `anthropic` que o banco semeia em toda organização nova, por exemplo, enquanto o instalador coletou só `OPENAI_API_KEY`), o worker que responde sozinho pulava a mensagem do cliente com `ai_gateway_key_missing` mesmo com a chave da instalação ali — enquanto o ensaio do agente e o "Sugerir resposta" respondiam. Esse degrau agora resolve o id do modelo pelo provedor do próprio modelo no catálogo, e os três caminhos passam a concordar; id que o catálogo não conhece continua sem resposta, sem chamar o endpoint de outro provedor. Não há ação para quem opera a VPS.

  Contribuição de @webtecnica (#1597).

## [1.47.0] — 2026-09-24

### Adicionado

- **Ajuste opcional para a conversa ficar com quem atendeu** Em **Configurações › Distribuição de atendimento** há uma opção nova, **A conversa fica com quem atendeu**, que vem desligada. Com ela ligada, quem responde pelo Inbox a uma conversa sem responsável passa a ser o responsável, e o agente de IA fica calado nessa conversa até alguém devolvê-la. E quando o cliente escreve de novo numa conversa já encerrada, ela volta direto para o último atendente, sem passar pela distribuição, desde que essa pessoa ainda faça parte da equipe. Desligada, nada muda: responder cala a IA só por alguns minutos, e a conversa encerrada volta para a fila. Ideia de @gustavorodcruz96 (#1527).

- **Base dos roteiros de atendimento, desligada por padrão** O banco e o motor dos roteiros de atendimento — a IA conduzindo perguntas durante a conversa, uma por vez — chegam à instalação como módulo opcional desligado. Nada muda para quem opera: não há tela nova, e com a chave desligada o atendimento da IA não consulta roteiro nenhum. A atualização acrescenta ao banco um estado novo de acompanhamento, uma coluna no roteador de intenção e duas proteções: anonimizar um contato encerra o roteiro dele, e um roteiro nunca ocupa a vaga do acompanhamento automático do contato.

  Trabalho de @vgamkt, recortado do PR #1130 (primeira de quatro partes).

### Corrigido

- **Na visão Mês da Agenda, os dias do mês vizinho mostram os compromissos deles** A visão Mês desenha seis semanas: os últimos dias do mês anterior na primeira linha e os primeiros do mês seguinte nas últimas. Os compromissos desses dias não eram buscados, então a célula aparecia vazia mesmo com consulta marcada ou horário ocupado na agenda do Google. Agora a busca cobre exatamente os dias que a grade desenha.

- **Roteiros de atendimento conferem na mensagem o que gravam, encerram quando um humano assume e expiram** Consertos dos roteiros de atendimento (módulo opcional, ainda desligado e sem tela). Antes de gravar uma resposta, a IA confere que ela está escrita no que o cliente mandou — inclusive nas mensagens seguidas de uma rajada. Uma opção da lista que ele não citou, a cilindrada da moto lida como ano, uma data diferente da que ele escreveu ou um "sim" a uma pergunta que ainda não foi feita não entram mais. O CPF confere o dígito verificador. Áudio sem transcrição e figurinha não contam mais como "não respondeu". O roteiro encerra quando uma pessoa assume a conversa ou o cliente pede para parar, e expira depois de 72 horas sem resposta. Os roteiros saíram da lista de fluxos de Follow-ups (na fila de acompanhamentos eles aparecem como "Coletando respostas do roteiro"), e o módulo só poderá ser ligado quando a tela dele existir.

  Trabalho de @vgamkt, recortado do PR #1130 (segunda de quatro partes).

- **No Inbox, a resposta enviada não some mais e o texto seguinte não é apagado** Numa conversa com histórico carregado, a resposta recém-enviada podia aparecer e sumir: ela entrava no pedaço mais antigo da conversa, não no mais recente. Agora ela aparece no fim da conversa e é trocada pela mensagem confirmada sem duplicar; se o envio falha, só ela sai da tela. Quem já tinha começado a digitar a próxima resposta enquanto a anterior era enviada também perdia esse texto quando a anterior era confirmada, e agora ele fica. E a conferência periódica que recupera mensagens perdidas pelo Inbox voltou a rodar: ela recomeçava a contagem a cada atualização da tela e, com a tela mudando, nunca chegava a rodar. Contribuição de @gustavorodcruz96 (#1527).

## [1.46.0] — 2026-09-24

### Adicionado

- **Quando o telefone da conversa cai, dá para continuar o atendimento por outro número** No Inbox, o botão **Transferir** ganhou duas abas: **Atendente**, como antes, e **Número**. Na aba Número você escolhe outro número de WhatsApp da empresa e clica **Continuar por este número**: o sistema abre a conversa do mesmo cliente nesse número e já a mostra na tela. Se a conversa lá estiver livre, você fica como responsável e o atendimento automático daquele número não entra no meio; se ela já estiver com alguém, a tela diz com quem. Números desconectados aparecem na lista, mas não podem ser escolhidos. Quando o número da conversa aberta não está conectado e existe outro conectado, aparece acima do campo de digitar a faixa **Responder por outro número**, que leva direto para essa escolha. Antes não havia como responder: a conversa ficava presa ao número que caiu. O histórico antigo continua na conversa do número original. Crédito: @rafaelbatistazz.

- **Variável META_WEBHOOK_BASE_URL para separar a URL pública dos webhooks da Meta** Adiciona a variável opcional `META_WEBHOOK_BASE_URL`, permitindo configurar uma URL pública dedicada para o callback dos webhooks da Meta (WhatsApp Cloud API / canais oficiais), separada de `NEXT_PUBLIC_APP_URL`. Mantém compatibilidade total com instalações existentes por fallback automático.

  Contribuição de @webtecnica (#1554).

- **O link da imagem do modelo se salva na aba Templates, sem enviar nada** Em **Conexões › Templates da Meta**, cada modelo com imagem, vídeo ou documento no cabeçalho ganha um campo para o link público do arquivo e o botão **Salvar link**. Antes a única forma de salvar esse link era enviar o modelo numa conversa com a janela de 24 horas fechada — ou seja, era preciso disparar para um cliente só para deixar o modelo pronto. Agora o link fica salvo direto no modelo, e quando você escolhe esse modelo numa conversa o campo do link já vem preenchido. Apagar o campo e clicar em **Remover link** esquece o link. Salvar é do administrador, como sincronizar. Crédito: @rafaelbatistazz.

### Corrigido

- **Extratores de atribuição deixam de gravar o id do anúncio como clique de origem** Quando uma mensagem com `referral` de anúncio chegava sem `ctwa_clid`, os extratores de atribuição (API oficial e WAHA) utilizavam o id do anúncio (`source_id`) como fallback para `sourceId` (`ad_source_id`), fazendo com que o envio de conversões reportasse o identificador do anúncio à plataforma como se fosse o identificador do clique. Agora os extratores gravam `sourceId` exclusivamente quando o clique (`ctwa_clid` / `ctwaClid`) estiver presente, mantendo o id do anúncio estritamente em `adId` (`ad_id`).

  Contribuição de @webtecnica (#1552).

- **Na Agenda, o botão Confirmar volta a ser alcançável em janelas baixas** Em telas largas com pouca altura (por exemplo 1280×500 ou 1024×560), o formulário de "Novo agendamento" cortava a lista de horários e o botão Confirmar sem barra de rolagem: os campos acima do calendário ocupavam quase toda a altura e o painel ficava sem espaço. Agora o formulário inteiro rola, o painel de marcar mantém a altura do próprio conteúdo e a lista de horários continua com a sua rolagem própria.

- **O agente deixa de dizer que "vai ver os horários" sem consultar a agenda** O agente com ferramenta de agenda já era impedido de responder "vou verificar os horários" ou "estou confirmando a disponibilidade" sem ter consultado a agenda de verdade naquele turno. Uma forma parecida escapava: "Vou chamar a responsável pra ver os horários." A mensagem saía e o turno terminava sem consulta nenhuma: a promessa de olhar os horários ficava só na promessa. Agora essa forma também é barrada, e o agente é orientado a consultar a agenda e responder com os horários reais. A regra nova é estreita de propósito: frases em que quem vai ver é o cliente ("pra você ver a agenda do evento"), "nada a ver com o seu agendamento" e "vamos ver: o horário de funcionamento é…" continuam saindo normalmente. Não há nada a configurar.

  Contribuição de @gyanu2507 (#972); relato de @spoliagency (#970).

- **Ação de automação assign_owner passa a ajustar owner_kind e limpar owner_agent_id** A ação de automação `assign_owner` atualizava `owner_user_id` diretamente no `crm_leads` sem ajustar `owner_kind` nem limpar `owner_agent_id`, violando a constraint `crm_leads_owner_kind_coherence` em leads previamente atribuídos a agentes de IA ou gerando incoerência em leads com dono sem tipo. Agora a ação roteia a atribuição por `resolveOwnerPatch`, garantindo a coerência do trio `owner_user_id`, `owner_kind` e `owner_agent_id`.

  Contribuição de @webtecnica (#1549).

- **A atualização para de refazer no banco o que já estava pronto** Toda atualização reaplica o esquema do banco inteiro com o sistema no ar. Alguns trechos dele desfaziam e refaziam, a cada atualização, coisas que já estavam no formato final: a tabela de compromissos da agenda era regravada inteira, uma coluna da tabela de membros da equipe era criada e apagada, e duas proteções da agenda e do follow-up eram reconstruídas. Enquanto isso acontecia, quem usava a agenda ou fazia login podia ficar esperando, e cada passada consumia de novo recursos do banco.

  Agora esses trechos conferem o banco antes e só agem quando ele ainda não chegou ao formato final. O resultado final é o mesmo de antes; a atualização só deixa de repetir esse trabalho. Nada precisa ser feito por quem opera a instalação.

- **Rodar a atualização de novo remove o aviso de manutenção que ficou preso** Se uma atualização era interrompida depois de pôr no ar o aviso de manutenção, o aviso ficava de pé e o CRM respondia 503 para todo mundo (site, rotinas e webhooks do WhatsApp); rodar o `update.sh` de novo dizia "Nada a atualizar" e saía sem tocar nele. Agora essa mesma saída remove o aviso preso, avisa quem está operando e diz como concluir a atualização interrompida. Medido numa VPS real, onde o CRM ficou 6h30 fora do ar por isso.

  Contribuição de @gideony (#1524).

- **O aviso de "sem chave de IA" no onboarding deixa de dizer "chave de da Anthropic"** Quem instala sem chave de IA e cria o primeiro atendente vê um aviso explicando que ele ficou
  como rascunho. A frase juntava duas preposições e saía "Não achei chave de da Anthropic
  (Claude)" — e, em espanhol, "No encontré ninguna clave de de la Anthropic". Agora sai "Não
  achei chave da Anthropic (Claude)". Nenhum comportamento muda: é só o texto do aviso.

- **crm_find_free_slots tolera dia e dias_a_frente juntos priorizando dia** A ferramenta MCP `crm_find_free_slots` não recusa mais chamadas com `periodo_ambiguo` quando o modelo de IA preenche `dia` e `dias_a_frente` simultaneamente, priorizando o campo mais específico (`dia`) e documentando a precedência no schema da ferramenta.

  Contribuição de @webtecnica (#1555).

- **Atualizar a instalação não duplica mais as demandas do Radar** Cada atualização da VPS criava uma segunda demanda para toda conversa nova que já tinha a sua, e o Radar passava a mostrar o dobro de demandas abertas sem próximo passo (o índice de atrito também contava em dobro). A atualização agora só cria demanda para conversa que não tem nenhuma, e a duplicata que as atualizações anteriores deixaram é apagada sozinha na próxima atualização. Só sai a cópia que ninguém tocou: demanda com próximo passo, responsável, lead ou caso fica como está, e a cópia que já virou o atendimento em curso da conversa também fica, para não interromper acompanhamento nenhum. Depois de atualizar, a contagem do Radar pode cair, e o número novo é o correto.

- **O "digitando…" aparece no WhatsApp do cliente enquanto a IA prepara a resposta** O indicador de "digitando…" praticamente nunca aparecia quando o agente de IA respondia: ele só era acionado se sobrasse tempo de espera depois que a IA terminava de pensar, e quase nunca sobrava. Agora ele acende no começo do atendimento de cada mensagem, cobrindo os segundos em que o cliente espera a resposta. Crédito: @rafaelbatistazz.

- **Extensão removida deixa de aparecer como instalada no painel do dono do servidor** Remover uma extensão marca a instalação como removida, mas a linha continua no banco. A tela `/admin/extensoes` lia todas as linhas, então uma extensão já removida seguia listada como instalada, junto com a contagem de empresas dela. Agora a tela ignora as instalações removidas, do mesmo jeito que o restante do sistema de extensões já fazia.

- **As fotos do produto não passam mais do limite de mensagens por resposta** Quando a descrição de um produto era longa demais para ir como legenda da foto, o texto saía numa mensagem à parte e as fotos vinham depois sem contar essa mensagem. Com o limite de 3 mensagens por resposta, um produto com 3 fotos chegava ao cliente em 4 mensagens, acima do ritmo que protege o número de bloqueio. Agora o limite é conferido antes de cada foto, já contando o texto. Crédito: @bonito-system.

- **Freio de envio por token aplicado antes de abrir conversa e teto por organização** Ao iniciar conversa e envio por token (`crm_start_conversation_and_send`), o freio de ritmo e teto diário do número passa a ser checado antes de registrar a abertura da conversa no banco, impedindo conversas vazias residuais quando o envio for retido por limite de taxa (429). Além disso, a rota `/api/v1/messages` agora respeita um teto global por organização além do teto por token individual.

  Contribuição de @webtecnica (#1556).

- **Textos longos sem espaços no Inbox não estouram mais a largura da tela** No Inbox, mensagens com sequências longas e contínuas de caracteres sem espaço (como códigos Pix copia-e-cola de 150+ caracteres) estufavam a bolha de mensagem para além da coluna de conversa, desalinhando o layout e ocultando os botões de ação do topo. A coluna da conversa, o scroller e a bolha ganharam contenção de largura mínima, e o texto ganhou quebra forçada (`wrap-anywhere`): o layout fica íntegro no desktop (medido em 1024 e 1280 px).

  Contribuição de @webtecnica (#1508); relato de @tec7alex (#1451).

- **O modelo de mensagem volta a sair pelo WhatsApp oficial da Meta** Desde a 1.45.0, todo envio de modelo aprovado por um número conectado ao WhatsApp oficial da Meta falhava com "template_missing", e a conferência dos valores do modelo deixava de acontecer. Como o modelo é o único jeito de voltar a falar com um cliente depois de 24 horas sem resposta, essas conversas ficavam sem saída. Agora o envio acha o modelo que a sincronização da Meta trouxe, e quem usa também um canal parceiro com um modelo de mesmo nome continua com cada número usando a própria definição. Crédito: @bonito-system.

- **Importar uma skill recusa, já na leitura do pacote, nome que o Storage não aceita** O pacote de skill vira chave de objeto no Storage (`{organização}/{nome}/{versão}/{caminho}`), e o
  Storage tem alfabeto próprio para nome de arquivo. Um zip com `assets/ícone.png` — ou uma skill
  chamada `Relatório de vendas` — passava pela conferência do pacote e só quebrava adiante, na hora de
  subir o arquivo, com um erro que não ensinava o que fazer. Agora a recusa acontece na leitura do
  zip, antes de qualquer envio, e a mensagem diz qual nome está fora do alfabeto e o que usar no
  lugar. Quem envia pacote com letras sem acento, números, ponto, hífen, sublinhado ou espaço não vê
  diferença nenhuma.

  Contribuição de @webtecnica (#1346), no passo que a #686 pedia.

- **Validação de credenciais OpenRouter passa a aceitar gateways compatíveis sem rota /key** Quando `OPENROUTER_BASE_URL` aponta para um gateway próprio OpenAI-compatível (LiteLLM, vLLM, proxy interno), a validação de credenciais em IA › Credenciais falhava com `provider_status_404` porque a rota `/key` é exclusiva do OpenRouter oficial. O validador agora detecta a ausência de `/key` em bases customizadas e valida a autenticidade e catálogo via `GET /models`, permitindo validar e publicar agentes contra gateways privados.

  Contribuição de @webtecnica (#1376).

- **O painel "Como está indo" do papel Operador passa a contar só o agente aberto** Na página de um agente, a aba de operação mostrava os números do papel Operador somando todos os agentes da organização. Com dois ou mais agentes, o painel de um mandava marcar capacidades nele por causa de conversas de outro, e um agente parado não aparecia enquanto outro trabalhasse. Agora cada agente vê só as conversas dele.

  Os números passam a contar a partir desta versão: as execuções registradas antes dela não diziam qual agente atendeu, então o painel de cada agente começa do zero e se preenche com as próximas conversas (a janela é de 30 dias).

- **Evento do WhatsApp que chega num formato inesperado fica guardado e marcado como recusado** Quando o WhatsApp manda um evento num formato que o CRM não reconhece, o CRM recusa o evento e guarda uma cópia dele para quem for investigar. Isso tinha três falhas. No endereço de recebimento próprio de cada número, um campo que esse endereço nem usa podia fazer o evento ser recusado antes de a cópia ser guardada, e ela se perdia. Quando a cópia era guardada, ficava marcada como "recebida", igual a um evento que deu certo, e depois ninguém conseguia separar um do outro. E um evento malformado, que qualquer pessoa pode mandar antes de o CRM conferir a assinatura, aparecia no registro do servidor como erro.

  Agora a cópia é guardada nesses casos, a recusa fica marcada como erro junto com os nomes dos campos que vieram diferentes (nunca o conteúdo, que é dado do cliente), e a recusa que acontece antes da assinatura aparece no registro como aviso. Mensagens no formato normal seguem entrando exatamente como antes.

- **Etapa criada pela tela gera slug com hífen e normaliza busca em agendamento e handoff** A geração de slug de etapa na interface (`lib/leads/stage-editing.ts`) utilizava sublinhado (`_`), enquanto os módulos de movimentação automática por agendamento (`lib/leads/appointment-stage-move.ts`) e de handoff (`lib/leads/handoff-stage-move.ts`) procuravam slugs padronizados com hífen (`agendamento-solicitado` e `chamar-humano`). Agora o gerador produz slugs com hífens e os consumidores passam a buscar também etapas legadas com sublinhado como fallback, garantindo compatibilidade total sem quebras. Funis novos também passam a nascer com slug de hífen, porque usam o mesmo gerador; slugs já gravados não mudam.

  Contribuição de @webtecnica (#1548); relato de @franceschini-lucas (#1542).

- **Transcrição aceita base URL com ou sem /v1 e sem duplicar caminho** Ao configurar uma URL base customizada para transcrição de áudio (ex.: Groq ou Whisper próprio, como sugerido no `.env.example`), o provedor de transcrição concatenava `/v1/audio/transcriptions` sem normalizar o sufixo `/v1` ou barras finais, resultando em `/v1/v1/audio/transcriptions` e gerando erro 404. O provedor agora normaliza a base removendo barras finais e o sufixo `/v1`, suportando tanto URLs com quanto sem `/v1`.

  Contribuição de @webtecnica (#1550).

- **e2e do Trunk SIP garante dígito no sufixo e remove host na varredura de chave crua** A spec `tests/e2e/trunk-sip-config.spec.ts` passa a garantir um dígito no sufixo aleatório derivado de `Date.now().toString(36)` e a limpar ocorrências de `host` em `corpoSemOBloco`, evitando que nomes de host gerados casem com o padrão de chave de tradução crua (`a.b.c`).

  Contribuição de @webtecnica (#1553).

- **Atualização de modelo pelo Zernio passa a filtrar pela conexão correspondente** A sincronização de status de modelo vinda de webhook do Zernio (`lib/channels/zernio/avisos.ts`) atualizava o espelho local (`meta_templates`) filtrando apenas por organização e nome. Em organizações com mais de uma conexão espelhando modelos de mesmo nome (ou conexões com múltiplos idiomas), o estado recebido do Zernio podia sobrescrever a linha de outro canal. Agora a atualização filtra por `channel_session_id` e idioma, isolando as conexões.

  Contribuição de @webtecnica (#1551).

## [1.45.0] — 2026-09-23

### Adicionado

- **O produto do catálogo ganha foto, e o atendente de IA manda a foto junto** Na tela Produtos, cada produto passa a ter até 5 fotos (JPG ou PNG, até 5 MB
  cada): quem gerencia sobe, troca a ordem e remove pelo botão "Fotos" da linha,
  e a primeira foto vira a capa que aparece na lista. Quando o atendente de IA
  apresenta um produto que tem foto, ele manda a foto junto, com o texto como
  legenda — pelo mesmo caminho das outras mensagens, então opt-out, LGPD e o
  ritmo anti-banimento continuam valendo. Se a foto não puder ser enviada, o
  texto sai sozinho. As fotos ficam num espaço privado do armazenamento, e a
  atualização cria esse espaço sozinha: não há nada para configurar.

  Ideia de @vgamkt, a partir do #1130.

### Alterado

- **O botão "Atualizar agora" não fica mais atrás do histórico de versões** Na tela Configurações › Atualização, quando há várias versões acumuladas, o
  botão "Atualizar agora" ficava depois da lista "O que muda" — quem só queria
  clicar precisava rolar por todo o histórico primeiro. O botão subiu para
  antes dessa lista; os avisos que pesam na decisão de atualizar (instalação em
  versão de desenvolvimento, "Requer atenção" e o de histórico incompleto, que
  avisa quando a lista pode não alcançar a versão instalada) continuam
  aparecendo antes dele.

  Contribuição de @allisonwilliancandido (#1500).

### Corrigido

- **Anonimizar um contato pela ficha passa a apagar também o que ele escreveu nas conversas** Anonimizar um contato pelo botão da ficha trocava o nome e os dados da ficha,
  mas o que a pessoa tinha escrito nas conversas continuava guardado, assim como
  o resumo que a inteligência artificial faz de cada atendimento e as fotos e
  arquivos que ela enviou. Agora a anonimização, por qualquer caminho, apaga o
  texto das mensagens, a prévia da última mensagem, o resumo da inteligência
  artificial e manda apagar os arquivos enviados. Contatos que já tinham sido
  anonimizados antes são corrigidos na própria atualização. Os resumos da
  inteligência artificial também passam a constar do relatório de dados que o
  titular pode pedir. Não há ação para quem opera a VPS.

- **Origem de anúncios do WhatsApp conectado por QR** Contatos que chegam por anúncios Clique para WhatsApp agora recebem a origem do anúncio quando o WAHA NOWEB entrega `externalAdReply`. Antes, o CRM procurava apenas `externalAdReplyInfo` e deixava o contato como WhatsApp sem atribuição. A forma anterior continua aceita, e posts orgânicos continuam fora da atribuição paga. Crédito: @ozzure.

- **O preço dos modelos OpenAI nas duas tabelas do schema passa a bater com a fonte** Quem atendia com gpt-5.6-sol via a tela um preço e a conta somava outro: o catálogo (ai_models) e a tabela de orçamento (ai_pricing) seguiam com 500/3000 centavos por milhão, a versão não promocional, enquanto o código que grava o custo em llm_calls cobrava 400/2000 — preço promocional medido na fonte oficial em 23/09/2026, validade declarada pela própria página até 21/11/2026. As duas tabelas agora mudam juntas, a notes da linha grava fonte e data da medição, e entram na tabela os três ids OpenAI que o código já cobrava e a tabela não conhecia (gpt-4o, gpt-4o-mini, gpt-4o-2024-05-13). Não há ação para quem opera a VPS: a correção chega na próxima atualização.

  Contribuição de @webtecnica (#1498).

- **O roteador em "Automático" passa a usar a inteligência artificial que a empresa escolheu** Quem deixava o modelo do roteador em "Automático" numa empresa que usa só a
  OpenAI via toda conversa cair no agente reserva: o roteador pedia um modelo da
  Anthropic ao provedor errado, e a identificação da intenção falhava sempre.
  Agora "Automático" usa o que está escolhido para a empresa (no painel de
  provedores ou no padrão da organização). Em empresas que usam a Anthropic, o
  "Automático" também passa a seguir esse padrão, em vez de um modelo fixo. Quem
  escolheu um modelo específico na tela do roteador não é afetado. Não há ação
  para quem opera a VPS.

## [1.44.0] — 2026-09-23

### Adicionado

- **Editar o texto de uma skill pela tela, com histórico de versões e restauração** Em **IA › Skills**, cada skill instalada ganha o botão **Editar**. Nele dá para mudar a descrição, as palavras-chave que ativam a skill e o procedimento que o agente segue. Cada vez que você salva, nasce uma versão nova, e a anterior fica guardada. No mesmo lugar aparece o histórico de versões, e **Restaurar** volta para qualquer uma delas na hora, sem reiniciar nada. Antes, a única forma de mudar o texto de uma skill era enviar um .zip de novo.

  Uma skill que veio de um pacote com arquivos continua mudando só pelo pacote: a tela avisa e não deixa salvar, porque a versão nova perderia os arquivos.

  O agente também deixa de "esquecer" uma skill quando o cliente responde só a escolha, como "a de 2025": para decidir que skill usar, ele passa a olhar as últimas mensagens do cliente, e não só a mais recente.

  Nada para fazer. Quem edita e restaura é o gerente ou o administrador.

  Construído a partir do trabalho de @vgamkt no #1130.

- **Canal Datafy ganha a aba Modelos — criar e sincronizar modelos aprovados pela tela** Quem ligou o canal Datafy (`DATAFY_ENABLED=true`) passa a ver, na aba dele em **Conexões**, a sub-aba **Modelos**. Nela dá para **sincronizar** os modelos aprovados da conta e **criar** um modelo novo, que entra na fila de revisão da plataforma. O formulário é o mesmo do outro provedor parceiro: cabeçalho, corpo, rodapé, botões e exemplos.

  Era o que faltava para atender **fora da janela de 24 horas**. Dentro da janela, texto livre passa. Fora dela, a Meta só aceita modelo aprovado, e até aqui este canal não tinha nenhum para oferecer.

  - **O modelo sai pelo número do Datafy**, com a credencial dele, e nunca pelo número da Meta.
  - **O resultado da revisão chega sozinho**: quando a plataforma aprova ou recusa, o aviso dela atualiza o modelo na lista, sem precisar clicar em Sincronizar.
  - **Na conversa com a janela fechada**, o seletor oferece os modelos aprovados deste número e pede os valores de cada `{{1}}`.
  - Sincronizar e criar é do **administrador**. Quem atende só consulta a lista.

  Nada para fazer: quem não liga o canal não vê nada de novo. Editar e apagar um modelo ainda não estão na tela: isso continua sendo feito pelo painel do provedor.

  Trabalho de @vgamkt, recortado do PR #1130.

### Corrigido

- **A contabilidade de custo e o teto de gastos passam a registrar chamadas dos modelos OpenAI** Organizações que configuram agentes de atendimento usando modelos OpenAI (como gpt-4o e gpt-4o-mini) tinham o custo registrado como nulo em llm_calls, fazendo a tela Uso e orçamento marcar zero e impedindo que o teto mensal de gastos disparasse. Os modelos OpenAI suportados no catálogo foram adicionados à tabela de preços versionada.

  Contribuição de @webtecnica (#1486).

- **Mensagens enviadas pela API ou pelo MCP respeitam o ritmo do número de WhatsApp** Quem enviava mensagens com token de API (`POST /api/v1/messages` com `Authorization: Bearer`) ou pelas ferramentas de envio do MCP passava direto para o WhatsApp. Não havia intervalo entre uma mensagem e outra, o limite diário e o aquecimento do número eram ignorados, e esses envios nem entravam na contagem do dia. Um script ou um agente externo em laço podia disparar centenas de mensagens seguidas pelo mesmo número, que é o padrão que leva o WhatsApp a banir o número.

  Agora esses envios esperam o intervalo mínimo do número, como o agente do CRM já esperava, e entram na contagem diária. Quando o número atinge o limite do dia, a API responde `429 rate_limited`, informa o motivo e o horário de liberação (`libera_em`) e envia o cabeçalho `Retry-After`. A rota REST por token também passa a ter o mesmo teto de chamadas por minuto que o MCP já tinha.

  O envio feito pela tela, por um atendente, não muda. O canal oficial da Meta também não, porque não corre risco de banimento. O operador não precisa fazer nada, mas uma integração que dispara em massa pela API passa a receber `429` e precisa esperar o `Retry-After`.

  Contribuição de @bossprt (#1487).

- **O agente de IA consegue gravar um aprendizado na memória da empresa** A ferramenta que deixa o agente de IA anotar um aprendizado para toda a operação (**IA › Ensinar o agente › Memória**) falhava em toda chamada: o banco recusava a anotação porque não conhecia a origem "agente". Nada chegava a ser gravado.

  Agora a anotação entra, marcada como **"anotado pelo agente"** na lista de aprendizados, separada do que alguém da equipe escreveu à mão e do que o sistema aprendeu sozinho. A atualização só amplia a regra do banco; nenhum aprendizado existente muda. Nada para fazer.

  Diagnóstico de @vgamkt (#1130).

- **A criação e a sincronização de modelos do parceiro passam a exigir papel de administrador** Na tela de modelos do canal intermediado, criar e sincronizar modelos de mensagem passa a exigir o papel de administrador, como já acontece com os modelos do canal oficial. Ver a lista continua disponível a quem atende, porque o seletor do inbox usa a mesma lista. O pedido de criação agora é validado antes de chegar à plataforma, e o registro de auditoria passa a indicar quem criou o modelo.

## [1.43.0] — 2026-09-23

### Adicionado

- **O agente de IA passa a consultar o banco de dados externo que a empresa conectou** O banco externo (**Organização › Dados e acesso › Dados externos**) deixa de ser
  só uma tela: o agente que atende no WhatsApp agora pode ler dele para responder
  com o dado real (pedido, assinatura, saldo) em vez de estimar. São duas
  capacidades novas no pacote **"Organizar a operação"**:
  **"Ver as tabelas do banco conectado"** e **"Buscar dados no banco conectado"**.

  - **Nada muda sozinho.** Nenhum agente existente ganha as duas: é preciso ligá-las
    na tela do agente. Sem conexão cadastrada, elas não abrem rede nenhuma.
  - **Somente leitura**, dentro dos limites que o administrador configurou na
    conexão (linhas, filtros e tamanho da resposta).
  - **O log não guarda o que o cliente buscou.** A auditoria registra a tabela e o
    campo consultados, nunca o valor do filtro (CPF, telefone, nome).
  - **Busca sem resultado volta vazia.** O agente nunca recebe linhas de outras
    pessoas quando o filtro não casa.

  Trabalho de @vgamkt, recortado do PR #1130.

- **Cadastro com aprovação — a empresa nova espera o dono da instalação** A tela **Admin › Cadastro** ganhou uma segunda chave, **Cadastro com aprovação**.
  Com ela ligada, quem cria conta sem convite confirma o e-mail normalmente, mas a
  empresa não nasce na hora: a pessoa envia o pedido com o nome da empresa, e ele
  aparece nessa mesma tela para você aprovar ou recusar. Aprovar cria a empresa e
  torna quem pediu administrador dela.

  Serve a quem hospeda várias empresas numa instalação e quer decidir quem entra
  sem precisar convidar um a um.

  - A chave nasce **desligada**. Quem não ligar não vê diferença nenhuma.
  - Quem chega com **convite** continua entrando direto na empresa que convidou.
  - Nenhuma lista de empresas aparece para visitantes: entrar numa empresa que já
    existe continua sendo pelo convite.
  - O e-mail só vale confirmado pelo link que o próprio sistema de login envia.

  Contribuição de @betoarts (#714).

- **Campanhas — falar com uma lista de contatos, no ritmo do número** O CRM passa a ter **Campanhas**: você escolhe um recorte dos contatos que já tem, escreve uma mensagem, confere quantas pessoas aquilo pega — e só então dispara. A tela fica em CRM › Ver tudo em CRM › Campanhas.

  O ritmo é o ponto. Uma campanha manda **uma mensagem por vez, pelo número escolhido**, respeitando o intervalo, a janela de horário e o teto diário que aquele número já tem configurado em Conexões › Proteção de envio. Se quiser ir ainda mais devagar nesta campanha específica, dá para apertar o intervalo, a janela e o teto — mas só para menos: campanha nenhuma consegue furar o limite do número. Quem dispara em rajada queima o número, e número queimado não volta em dias, volta em semanas.

  Antes de gravar a lista, a prévia mostra **quantos entram e quantos ficam de fora, com o motivo de cada um**: quem pediu para não receber, quem não tem telefone, quem tem o mesmo telefone de outro cadastro, quem já está em outra campanha ainda não concluída. Depois de preparada, a lista é congelada — mexer numa etiqueta não muda mais quem vai receber aquele envio, e o número que você conferiu é o número que sai.

  Quem pediu para parar não recebe, e isso é conferido **duas vezes**: quando a lista é montada e de novo no instante de cada envio. Entre uma coisa e outra podem passar horas, e honrar o pedido com um dia de atraso é o mesmo que não honrar.

  A campanha também exige que você declare **com base em quê** está falando com aquelas pessoas — consentimento ou interesse legítimo. No segundo caso, a referência da avaliação (LIA) é obrigatória: é ela que permite responder a quem perguntar por que recebeu a mensagem.

  Você acompanha pela tela: quantas saíram, chegaram, foram lidas e **responderam**, mais quem ficou de fora e por quê. Pode pausar e retomar a qualquer momento; cancelar é definitivo, e quem ainda não recebeu não recebe mais. Antes de iniciar, dá para mandar um **teste** para um contato à sua escolha, pelo mesmo número e com o mesmo texto do envio real.

  Nada muda para quem não usar: nenhuma campanha existe até alguém criar a primeira, e nenhum arquivo de configuração precisa ser editado. Organização suspensa não dispara campanha.

  Crédito: @lussandro.

- **WhatsApp oficial pelo Datafy, um canal opcional que vem desligado** Dá para conectar um número oficial do WhatsApp pelo **Datafy**, parceiro
  homologado pela Meta. A empresa cola só o token de acesso. O sistema descobre
  sozinho o número e a conta, confere o token antes de gravar e passa a enviar e
  receber mensagens por esse número.

  **O canal vem desligado, e quem não o liga não vê nada.** Não aparece aba, a
  rota de conexão não responde e o webhook recusa entregas. Para ligar, ponha
  `DATAFY_ENABLED=true` no `.env` e reinicie o app. Depois cada empresa conecta o
  próprio número em **Conexões**, na aba que passa a aparecer.

  - **Dois passos na tela.** Primeiro o token, e com ele o CRM já envia. Depois,
    no painel do provedor, cole a URL de webhook que a tela mostra e ative a
    assinatura. Por fim, cole no CRM o segredo que o painel mostrar. Sem esse
    segredo o CRM envia, mas recusa tudo o que chega, e a tela avisa isso.
  - **Credencial guardada cifrada**, por empresa. Ela não volta à tela depois de
    gravada.
  - **Mesmas regras do WhatsApp oficial:** janela de 24 horas e custo por
    mensagem. Por enquanto, este canal ainda não gerencia os modelos aprovados, e
    por isso não envia modelo fora da janela. O atendimento dentro da janela
    funciona normalmente. Imagem e áudio recebidos do cliente também ficam para a
    próxima versão.

  Trabalho de @vgamkt, recortado do PR #1130.

- **Mensagem automática quando o cliente volta a escrever** Em **IA → Follow-ups**, o gatilho **Cliente voltou** dispara só quando alguém
  escreve depois de ficar um tempo sem falar — não enquanto some (isso continua
  sendo Silêncio). Você escolhe o tempo (número + minutos, horas ou dias; o
  padrão é 1 dia, o teto é 90 dias) e, se quiser, filtra por etiquetas.

  A primeira mensagem do fluxo nasce como texto fixo: o agente de IA **não**
  responde por cima. O dossiê do acompanhamento mostra que começou porque o
  cliente voltou.

  Contribuição de @IanCouto (#1424, entrou pelo #1453).

- **Duplicar e renomear um fluxo de follow-up** Em **IA → Follow-ups**, cada fluxo agora tem **Duplicar** e **Renomear**. A
  cópia nasce como rascunho com o mesmo desenho e o mesmo gatilho — não publica
  sozinha e não passa a mandar mensagem. O nome interno também muda pelo lápis
  ao lado do título no construtor.

  Contribuição de @IanCouto (#1424, entrou pelo #1453).

- **Follow-up quando um negócio nasce** Em **IA → Follow-ups**, o gatilho **Lead criado** inscreve o contato quando um
  negócio nasce — pela primeira mensagem que abre o card, por formulário ou pelo
  cadastro manual. Negócios importados por planilha não entram, para a
  importação não virar um disparo em massa. A entrada na fila leva poucos minutos.

  Um fluxo publicado com esse gatilho também passa a valer para o lead que nasce
  de uma conversa. Se você já tem uma automação em Webhooks no evento «quando
  entrar um contato novo», ela passa a rodar nesse caso também.

  Contribuição de @IanCouto (recorte do #1471, entrou pelo #1479).

- **Um segundo jeito de instalar, com o banco (Supabase) dentro da própria VPS** O kit ganhou um modo de instalação **opcional** em que ele mesmo instala e opera o
  Supabase **na VPS do cliente**, ao lado do CRM. Não é preciso abrir conta no
  Supabase nem colar chave nenhuma: o instalador pergunta só o domínio. Na VPS, dentro
  da pasta do repositório clonado:

  ```bash
  bash ubuntu-production-installer.sh --domain crm.suaempresa.com.br
  ```

  O que vale saber antes de escolher este modo:

  - **Memória:** o banco passa a rodar na mesma máquina. O mínimo continua sendo uma
    VPS de 4 GB (a mesma régua do instalador comum), mas o **recomendado são 8 GB**.
  - **Backup:** o `backup.sh` passa a guardar também os **arquivos anexados** (fotos e
    documentos), que nesse modo moram no disco da VPS, e o `restore.sh` os devolve
    junto com o banco. Se os anexos não puderem ser salvos, o backup falha em vez de
    dizer "concluído".
  - **E-mail de acesso:** "esqueci a senha" e a confirmação de cadastro saem pelo
    **SMTP que você configura no CRM** (tela `/admin/email`). Sem SMTP, esses e-mails
    não são enviados, e o instalador avisa isso no fim. Depois de configurar o SMTP,
    rode `bash hostgator-setup-kit/update.sh` para o login passar a usá-lo.
  - **Atualização:** o `update.sh` também leva o Supabase desta VPS até a versão que o
    kit fixa, sem apagar dados.
  - **Mais de uma instalação na mesma VPS:** o banco ganha nomes próprios, e uma
    segunda cópia do CRM na mesma máquina é recusada em vez de mexer no banco da
    primeira.

  Quem já instalou com o Supabase na nuvem (ou num Supabase próprio) **não é afetado**:
  nada muda no comportamento do instalador comum, do backup ou da atualização.

  Contribuição de @betoarts (recorte do #714, entrou pelo #1464).

- **Um comando sobe o DeskcommCRM inteiro na sua própria máquina** Até aqui, rodar o DeskcommCRM fora de um servidor exigia montar tudo à mão: banco, autenticação, WhatsApp e fila, cada um com a sua configuração. O instalador da VPS não serve para isso, porque ele assume domínio próprio e proxy na frente.

  Agora existe um caminho local: `./ubuntu-local-installer.sh` prepara a máquina, sobe o banco com a estrutura oficial do produto, gera as chaves, levanta a aplicação, o worker, o WhatsApp e a fila, e cria o usuário administrador — imprimindo no fim o endereço e a senha. Depois disso, `pnpm local:up`, `local:status`, `local:logs` e `local:down` cuidam do dia a dia. O passo a passo está em `docs/SETUP.md`.

  A senha do administrador e a chave do WhatsApp nascem diferentes em cada instalação, e o painel de
  diagnóstico do WhatsApp só atende a própria máquina — de outro computador da rede, só a aplicação responde.

  Para quem opera uma VPS nada muda: é ferramenta de quem desenvolve ou avalia o produto na própria máquina, e nenhum arquivo da instalação em servidor foi tocado.

  Contribuição de @betoarts (#714).

### Alterado

- **O banco de dados externo vira módulo opcional da instalação, desligado por padrão** A tela **Dados externos** (conectar o banco de outro sistema para o agente consultar) aparecia para todas as empresas da instalação. Agora ela é um **módulo opcional**: quem administra o servidor liga ou desliga em **Modo administrador › Comportamento › Módulos opcionais › Banco de dados externo**, sem mexer no arquivo de ambiente.

  Desligado, o módulo não existe para ninguém: a porta some do menu, do hub de Configurações e da busca, a tela e as rotas dele respondem "não encontrado", e as ferramentas de consulta ao banco externo não são oferecidas ao agente. Ligado, tudo funciona como antes.

  **Quem já usava não perde nada na atualização:** se a instalação tinha pelo menos uma conexão de banco externo cadastrada, o módulo já nasce **ligado**. Nas outras, a atualização grava a chave como **desligado** — e nada muda para quem nunca cadastrou conexão. Isso acontece uma vez só: dali em diante, nenhuma atualização muda a chave, e só a tela de admin liga ou desliga (uma conexão criada depois por uma empresa não liga o módulo para as outras).

  Decisão do dono no doc 37 (18/09), completando o #1372.

- **Follow-up de texto fixo dispara sem agente de IA** Em **IA → Follow-ups**, um fluxo publicado que só envia texto fixo, template ou
  espera com tempo marcado passa a disparar sozinho — sem ligar um agente de IA
  e sem chave de modelo. Antes, o gatilho automático (silêncio, cliente voltou,
  etapa, caso) exigia um agente publicado mesmo quando o fluxo não usava o
  modelo. Fluxo com classificação, espera inteligente ou mensagem gerada por IA
  continua precisando do agente.

  Contribuição de @IanCouto (#1424, entrou pelo #1453).

### Corrigido

- **A planilha de produtos trata IP15 e ip15 como o mesmo código** Na importação de produtos por planilha, um código que só difere de outro nas maiúsculas e minúsculas ("IP15" e "ip15") passa a ser tratado como o mesmo código em todo o caminho. Antes, a planilha recusava a segunda grafia quando as duas vinham no mesmo arquivo, mas aceitava "ip15" quando "IP15" já estava no catálogo, e criava um segundo produto. Como a busca que o agente usa para responder o cliente não diferencia maiúsculas, esse segundo produto podia fazer o agente citar dois preços para o mesmo item.

  Agora as duas situações são recusadas, com o motivo no resumo da importação. Dentro do mesmo arquivo, a linha repetida diz com qual linha colide e como o código estava escrito lá. Contra o catálogo, a linha diz como o código já está cadastrado; para atualizar esse produto, basta escrever o código igual ao do catálogo. As outras linhas da planilha entram normalmente.

  Nada para fazer. Quem já tem no catálogo dois produtos que só diferem na caixa continua com os dois: a importação não apaga nem junta nada, só deixa de criar novos casos.

  Diagnóstico de @webtecnica na issue #482 e no #1441.

- **O menu de um agente não oferece mais arquivar o agente padrão da organização** Na lista de agentes de IA, o item "Arquivar" do agente padrão da organização aparecia habilitado, mas o sistema recusa arquivar esse agente — e a recusa chegava como o código interno "Falha: cannot_archive_default".

  Agora o item fica desabilitado para o agente padrão, e passar o mouse sobre ele explica o motivo. Se a recusa acontecer mesmo assim (a lista estava aberta quando outro administrador tornou aquele agente o padrão), o aviso diz em português que o agente padrão não pode ser arquivado. Nada para fazer.

  Contribuição de @betoarts (recorte do #714).

- **A atualização da VPS faz o backup de segurança que ela promete antes de mexer no banco** Toda atualização anuncia o passo "Backup de segurança (antes de mexer no banco)" — e o backup não acontecia. O script procurava o `backup.sh` a partir do diretório de onde o comando foi digitado, não de onde ele próprio está: chamado de `/root`, por exemplo, ele não achava o arquivo, e a atualização parava ali (ou, no modo assistido, seguia depois de avisar que o backup havia falhado).

  Agora o caminho do backup é resolvido antes de o script entrar na pasta do projeto, como o próprio script já mandava fazer. Atualizando de qualquer diretório, o backup roda de verdade e a mensagem de "backup feito" corresponde ao que aconteceu. Quem opera a VPS não precisa fazer nada.

  Contribuição de @webtecnica (#1476).

- **O backup das sessões do WhatsApp passa a levar a pasta do servidor e para de gravar arquivo vazio como se fosse backup** Na 1.42.0 o `backup.sh` passou a usar o volume real das sessões do WhatsApp, mas dois casos ainda saíam errados. Quem guarda as sessões numa pasta do próprio servidor (montagem do tipo bind, por exemplo `- /srv/waha:/app/.sessions`) continuava recebendo um `waha-*.tgz` vazio, porque o Docker só informa o nome da montagem quando ela é um volume nomeado; agora é a pasta do servidor que vai para o backup. E um arquivo vazio deixou de ser anunciado como `✓ sessões WhatsApp salvas`: se a montagem não tem sessão gravada, nenhum `waha-*.tgz` é criado e o passo avisa, em amarelo, que o pareamento do WhatsApp não entrou no backup. O banco é salvo normalmente e a atualização segue.

  Contribuição de @webtecnica (#1474), construído sobre o #1429 de @matheuspedro360.

- **As confirmações de fechar/arquivar conversa e de segurança usam o mesmo diálogo do resto do CRM** Fechar ou arquivar uma conversa no Inbox (pelo botão ou pelo atalho "e"), e
  desligar a verificação em duas etapas, gerar novos códigos de recuperação ou
  sair de todos os dispositivos em Configurações › Segurança, pediam
  confirmação pela caixinha crua do navegador. Ela ignorava a cor e o tema da
  instalação, sempre aparecia em português — mesmo para quem usa o CRM em
  espanhol — e ficava bloqueada dentro de um iframe. Agora usam o mesmo diálogo
  do resto do produto, no idioma e na aparência de cada organização.

  Contribuição de @allisonwilliancandido.

- **As rotinas agendadas conferem a senha interna sem vazar pistas pelo tempo de resposta** As rotinas agendadas do sistema (as rotas em `/api/v1/cron/`) conferiam a senha interna (`INTERNAL_CRON_SECRET` ou `INTERNAL_SECRET`) comparando letra por letra e parando na primeira diferença. Medindo o tempo de resposta, quem tentasse de fora conseguia descobrir aos poucos quantas letras tinha acertado. Agora as 30 rotas conferem a senha pelo mesmo portão, que leva o mesmo tempo com senha certa ou errada, e um teste impede que uma rota nova volte a comparar à mão.

  As rotas que só aceitavam o cabeçalho `Authorization: Bearer <senha>` passam a aceitar também `x-cron-secret: <senha>`, como as demais já faziam. Quem chama as rotinas continua funcionando do mesmo jeito: o operador não precisa fazer nada.

  Contribuição de @FabioMundoDigital (#1431).

- **O follow-up não dispara o fluxo inteiro numa só resposta** Num menu de follow-up (1/2/3), uma resposta que não casava o ramo fazia o
  fluxo reenviar o menu e, no mesmo instante, as mensagens seguintes e o
  aviso de “não respondeu”. Agora só avança o passo daquela resposta; a
  próxima pergunta espera o cliente de novo.

  Contribuição de @IanCouto (#1424, entrou pelo #1453).

- **A resposta do follow-up sai depois que o lead responde** Num fluxo de follow-up que espera a resposta do cliente (menu 1/2/3), a
  primeira mensagem saía e a seguinte ficava parada depois do "1". O
  acompanhamento volta a avançar e enviar a mensagem do ramo escolhido.

  Contribuição de @IanCouto (#1424, entrou pelo #1453).

- **O MCP passa a ter teto de chamadas por token, por organização e para escrita** O endereço que as ferramentas de IA usam para conversar com o sistema (`/api/mcp`) não limitava quantas vezes um token válido chamava as ferramentas. Um agente externo em laço podia disparar mensagens de WhatsApp sem parar, e o WhatsApp restringe e bane o número por volume.

  Agora cada token pode fazer até 60 chamadas por minuto, a organização inteira até 600 por minuto (somando todos os tokens dela) e cada token até 30 chamadas por minuto nas ferramentas que alteram dados, como a que envia mensagem. Passando do teto, a chamada é recusada antes de a ferramenta rodar, a resposta diz quando tentar de novo e a recusa fica registrada no log de auditoria. A IA do próprio sistema não passa por esse teto.

  Se o Redis ficar inalcançável, a contagem passa a ser feita na memória de cada processo do app, e numa instalação com mais de uma cópia do app o teto vale por cópia.

  Contribuição de @Alencaf (#1446).

- **O agente responde com modelos Google pela OpenRouter e não manda mais mensagem em branco** Quem usa a OpenRouter com um modelo que não é da OpenAI, como o `google/gemini-2.5-flash-lite`, via o agente falhar com "Invalid JSON response": o CRM chamava na OpenRouter um endereço que ela não atende para todo modelo. Agora o agente, o botão "Teste", os recursos de IA com a chave da organização e os com a chave da instalação usam o endereço que a OpenRouter atende para qualquer modelo.

  O agente também deixa de mandar ao cliente uma mensagem em branco quando o modelo escreve só espaços ou quebras de linha: o texto volta ao modelo para ele escrever a resposta de verdade.

  Nada para fazer.

  Diagnóstico e conserto de @vgamkt no #1130.

- **O botão Publicar do agente de IA acende depois de salvar o rascunho** Na tela do agente de IA, quem editava as instruções, salvava o rascunho e ia publicar encontrava o botão **Publicar** apagado, com a dica "Salve o rascunho antes de publicar". Salvar de novo não resolvia, e a versão nova ficava sem ir ao ar por esta tela. Agora a tela compara o que de fato seria gravado: campos que o servidor completa sozinho e a ordem em que o banco devolve as configurações não contam mais como alteração pendente. Contribuição de @Sandersono (#1473).

- **Duas bibliotecas internas sobem de versão para fechar avisos de segurança** O aviso automático de segurança do repositório apontou quatro problemas em bibliotecas que o sistema usa por dentro. Três são da `hono` (que atende chamadas HTTP internas): um pedido malformado podia fazer o serviço consumir memória sem limite, um endereço com fragmento podia confundir cache e proxy, e uma função de exportação ainda escrevia fora da pasta de destino. O quarto é da `js-yaml`, usada só no desenvolvimento do projeto, que podia gastar processador à toa.

  As duas subiram para as versões que corrigem tudo isso (`hono` 4.13.8 e `js-yaml` 4.3.2). Nenhuma tela, nenhuma configuração e nenhum comando mudam: quem opera uma VPS só precisa atualizar como de costume.

## [1.42.0] — 2026-09-22

### Adicionado

- **A página com botão de WhatsApp passa a dizer de qual anúncio veio cada lead** Quem manda tráfego pago para uma página com botão de WhatsApp perdia a origem no
  caminho: o link `wa.me` abre o aplicativo no aparelho da pessoa, o servidor nunca
  vê aquele clique, e a conversa entrava sem campanha, sem conjunto e sem anúncio.

  Em **Configurações › Conversões** nasce a seção "Endereço de captura". Escolha
  para qual WhatsApp mandar e o texto que a pessoa vai enviar, e a tela devolve um
  endereço pronto para colar no botão da sua página, no lugar do `wa.me`. A partir
  daí o próprio CRM guarda a origem do clique, gera um código curto de seis
  caracteres e abre o WhatsApp com esse código no texto — o visitante continua
  vendo só o botão de sempre, e a ficha do contato passa a mostrar campanha,
  conjunto, anúncio e posicionamento.

  Nada para fazer em quem já usa o marcador longo `[dk1:]` na página: ele continua
  valendo, sem prazo. E nada muda para quem não configurar o endereço — a seção
  nasce desligada até ser preenchida e salva.

  Uma recusa de propósito, para o dinheiro não ir para o lugar errado: o número
  precisa vir com código do país. `11 99999-9999` não é salvo, e o campo pede o
  formato internacional, porque um celular brasileiro escrito sem o `55` é
  indistinguível de um número dos Estados Unidos — e um endereço de captura
  apontado para o país errado não quebra nada, só faz o telefone parar de tocar.

  Contribuição de @rafaelbatistazz (#1405, #1409).

- **Entrar com o Google, sem senha, nas telas de entrar e de criar conta** Quem usa Google Workspace já não precisa criar mais uma senha para começar:
  as telas de entrar e de criar conta ganharam o botão **Entrar com Google**. Ele
  funciona nos dois sentidos — entra quem já tem conta e cria a conta quem não
  tem —, sem tela intermediária e sem pedir confirmação por e-mail.

  Alguns cuidados que valem para quem opera:

  - Quem chega por um **convite** continua entrando na empresa que convidou, pelo
    Google também. Sem isso, a pessoa convidada ganharia uma empresa própria e um
    assistente de boas-vindas que não é dela.
  - Numa instalação de **cadastro apenas por convite**, o Google continua barrado
    para quem não tem convite — e continua liberado para quem já usa o sistema.
  - Quem tem **verificação em duas etapas** cadastrada continua sendo obrigado a
    confirmar o código. Seria fácil deixar a porta mais nova mais fraca que a
    antiga.
  - Para ligar o botão de verdade, o provedor Google precisa estar habilitado no
    projeto Supabase da instalação (Authentication → Providers). Com ele
    desligado, a tela diz exatamente isso, em vez de um erro genérico.

  Contribuição de @webtecnica (#1401).

- **O euro passa a aparecer na lista de moedas** Quem opera em Portugal não encontrava a própria moeda em Configurações › Organização: a lista ia do kwanza ao dólar, sem o euro. Agora o euro aparece, e o catálogo e o total de cada etapa do funil o escrevem como em Portugal, `249,90 €`. O cartão e a ficha do negócio e o painel da conversa ainda escrevem o euro na convenção brasileira (`€ 249,90`). Os negócios que chegam pelo formulário de captação, pela importação de planilha ou pelo agente de IA passam a nascer na moeda da empresa. Antes, nasciam em real. A trava que impede o agente de prometer preço abaixo da tabela também passa a reconhecer valores em euro, inclusive com o milhar separado por espaço (`1 497,00 €`). O padrão de quem ainda não escolheu continua sendo o real. Crédito: @maclevison.

- **O Modo administrador mostra as extensões do servidor** Quem administra a instalação ganha **Modo administrador › Extensões**: de onde
  vêm as extensões deste servidor (o catálogo admitido, a revisão e quando foi
  aceito), quais estão instaladas e em quantas empresas cada uma está ligada.

  Antes isso só existia dentro do menu de uma empresa, embora o catálogo seja do
  servidor inteiro. Instalar e configurar continua na tela da empresa, e a tela
  nova leva até lá.

- **A ficha do contato mostra o nome da campanha que trouxe o cliente** Quem chega pelo botão de WhatsApp de um anúncio aparecia na ficha com o número
  do anúncio — `120210000000000` —, que não responde pergunta nenhuma. Agora a
  ficha mostra o nome da campanha, do conjunto e do anúncio, do jeito que estão
  escritos na conta de anúncios: "Black Friday · Mulheres 25-34 · Vídeo depoimento
  v3".

  Os nomes são perguntados à plataforma quando a ficha é aberta, e ficam guardados
  por sete dias — um anúncio que traz muitos contatos é perguntado uma vez, não
  uma vez por contato. Se a conta de anúncios não responder, a ficha continua
  mostrando o que já sabia, sem apagar nada.

  Nada para fazer: quem já tem a conta de anúncios conectada passa a ver os nomes
  na próxima ficha que abrir.

  Contribuição de @rafaelbatistazz (#1387 e #1389).

- **O menu lateral da instalação passa a ser escolhido pela empresa** Até aqui cada **pessoa** escolhia as próprias áreas do menu, convite a convite. A instalação inteira não tinha uma escolha: para uma empresa mostrar o mesmo recorte a todo mundo, era preciso repetir a escolha em cada vínculo — e o convite seguinte reabria tudo.

  Agora a empresa também escolhe: **Configurações → Empresa → Menu lateral**, para quem administra a organização. A pessoa que entra depois já nasce dentro do recorte da empresa, e quem escolhe o próprio menu só consegue escolher **menos** do que a empresa liberou, nunca mais.

  **Para quem não mexer em nada, a instalação continua exatamente como está** — a coluna nasce com o preset completo, e a leitura resolve empresa ∩ vínculo ∩ papel. As áreas essenciais continuam sempre visíveis, e isto é apresentação: não altera permissão, RLS, API nem o que cada papel alcança. Desmarcar uma área aqui apenas a esconde do menu; link, aviso e busca seguem abrindo o que o papel autoriza.

  Não exige ação de quem opera a instalação: a coluna entra pela atualização, sem backfill e sem tocar dado existente.

  Contribuição de @webtecnica (#1359).

- **Dados da conexão para integrar outro sistema (endpoint e IDs) + onde obter o token** Depois de conectar um número, a tela de **Conexões** ganhou o painel
  **"Para integrar"**: endpoint/base da API e os identificadores da conexão
  (`phone_number_id`, `waba_id` / conta), com um botão para copiar tudo de uma vez.

  É o que faltava para plugar **outro sistema** no mesmo número sem caçar dado no
  painel do provedor nem reler a documentação:

  - **O token NÃO é exibido de volta.** Nada de credencial volta do servidor
    depois de gravada — em vez disso, um ícone de ajuda (ao passar o mouse) diz
    **onde obtê-la** no painel de cada provedor.
  - **Aviso de webhook.** Um número tem um único endereço de webhook; para dois
    CRMs atenderem ao mesmo tempo, um precisa reencaminhar as mensagens ao outro.
  - **Canal por QR (celular):** a credencial é interna desta instalação e não
    serve para fora — para outro CRM usar o mesmo número, ele conecta por uma
    sessão própria (novo QR). O painel explica isso e alerta sobre resposta
    duplicada se os dois tiverem atendimento automático.

  Trabalho de @vgamkt, recortado do PR #1130.

- **Remarcar um compromisso já avisado agora corrige o cliente sozinho** Quando o cliente já tinha recebido o aviso do compromisso e alguém mudava o horário, **nada era enviado**. O cliente ficava com a data antiga e aparecia no dia errado — e não havia como corrigir pelo sistema: o botão de enviar ficava desabilitado depois do primeiro envio.

  Agora a correção sai sozinha, e ela **diz que mudou**: "O horário da sua reunião mudou. Agora é…". Mandar a mesma frase duas vezes, com datas diferentes e sem explicação, faria a pessoa não saber qual vale.

  Três cuidados para isso não virar mensagem demais:

  - **só corrige quem já recebeu** — quem ainda está na fila vai sair com o horário novo de qualquer forma;
  - **só quando o horário muda** — mudar o título ou a descrição não manda nada ao cliente;
  - **espera dois minutos antes de sair**, e arrastar o compromisso de novo dentro desse tempo substitui a correção anterior em vez de somar outra mensagem.

  Compromisso cancelado não recebe correção: avisar cancelamento é outra coisa, e mandar "o horário mudou" de algo que não existe mais é pior que o silêncio.

  Contribuição de @paulolimajr77 (#803).

### Alterado

- **A Agenda passa a seguir o fuso da empresa, para todo mundo** A semana que a Agenda abre agora vem do fuso cadastrado em
  **Configurações › Empresa**.
  Vale igual para quem acessa de outro estado ou país: cinco pessoas da mesma
  empresa veem a mesma semana.

  Antes, cada tela recalculava pelo relógio do computador de quem abria, e isso
  divergia do servidor. Quem é de cada compromisso continua sendo mostrado pelo
  filtro e pela cor de sempre.

- **A janela que junta as mensagens de uma rajada ganha módulo e teste próprios** Nada muda para quem opera: as mensagens seguidas de um mesmo contato continuam virando um turno só
  do agente. O trecho que decide isso saiu de dentro do drain para um módulo com teste próprio, e o
  teste prende o comportamento de hoje — inclusive a exclusão do job em espera que evita o cliente
  ficar sem resposta quando a sessão antiga morre. Contribuição de @webtecnica (#1394), a partir da ideia e da medição de @Teowfb (#849).

- **Em espanhol, a comanda passa a se chamar "orden de servicio"** Em espanhol, "comanda" é a nota de pedido de um restaurante, e não era isso que a tela mostrava: é a conta de um atendimento, com serviços, comissão e cobrança. Agora Comandas, Faturamento e as frases que a mencionam dizem "orden de servicio". A única frase que ainda dizia "Configuración › Financiero" passa a dizer "Finanzas", como o menu. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **A lista de números marca qual deles é o canal oficial** Em Conexões, o número conectado pela API oficial da Meta agora aparece com a
  etiqueta "API oficial" ao lado do nome. Antes não havia nada na tela
  distinguindo-o dos números pareados por código QR, e as duas conexões funcionam
  de jeitos diferentes: a oficial não tem QR para reescanear nem aparelho para
  deslogar, e as mensagens dela seguem as regras de modelo aprovado.

  A lista continua mostrando TODOS os números da organização, inclusive o oficial:
  nada foi escondido nem filtrado. A etiqueta é informação, e o estado da conexão
  (Conectado, Caiu, …) segue no badge de sempre, ao lado dela.

  Contribuição de @webtecnica (#1442).

- **O serviço de envio de e-mail passa a ficar todo na tela E-mail** A chave do serviço externo (Resend) e o endereço do remetente saíram de
  **Credenciais** e agora ficam em **E-mail**, junto do servidor próprio: é um
  assunto só, e estava dividido em duas telas.

  O que já estava configurado continua valendo — é o mesmo campo, no mesmo lugar
  do banco. Credenciais mostra o caminho para quem procurar onde ficava antes.

### Corrigido

- **O filtro de etiqueta do atendimento para de fechar sozinho** Ao abrir o filtro "Filtrar por tag" na tela de atendimento, a lista de
  etiquetas às vezes se fechava sozinha uma fração de segundo depois de aparecer,
  e o clique na etiqueta não pegava — era preciso abrir de novo, às vezes mais de
  uma vez.

  O filtro agora continua na tela enquanto a lista de etiquetas é recarregada, em
  vez de sumir e voltar. Quem ainda não criou nenhuma etiqueta segue sem o filtro,
  como antes.

- **O contador de não lidas acompanha a leitura da conversa** Abrir uma conversa não lida tirava o negrito dela, mas o número no topo continuava contando essa conversa: quem atende via 3 na aba Não lidas com uma delas já aberta na tela, e a conta só batia depois de recarregar a página. O aviso de "os números mudaram" saía para a lista e para a conversa aberta, e nunca para a contagem — que é uma família de consultas à parte, uma por filtro de tela, e por isso não é alcançada por nenhum desses dois avisos. Agora a leitura derruba o número na hora, e o mesmo vale para qualquer filtro que esteja na tela, não só o que estava aberto quando o defeito foi relatado.

  Contribuição de @webtecnica (#1440).

- **O aviso de changelog cheio passa a chegar a quem corta a release** O changelog que o seu servidor recebe antes de atualizar tem um limite de tamanho, e quem escreve
  uma contribuição não tinha como saber que esse limite havia estourado — a verificação reprovava a
  contribuição dele por causa das notas acumuladas por outras pessoas. Agora o alerta vai para quem
  publica as versões, que é quem pode resolver, e chega antes de o limite estourar. Nada muda na sua
  instalação: o changelog que você lê antes de atualizar continua igual.

- **Backup do WhatsApp passa a usar o volume real de sessões** Os comandos de backup e restauração agora identificam o volume físico montado no WAHA, evitando gerar arquivos vazios quando o nome do projeto é prefixado pelo Docker Compose. Backups das sessões feitos antes desta versão podem ter saído vazios: depois de atualizar, rode um backup novo.

  Contribuição de @matheuspedro360 (#1429).

- **Mensagem de rede social não vai mais para a ficha que foi juntada a outra** Quando duas fichas de contato eram juntadas e a que saía da lista tinha vindo do Instagram (ou de outra rede social conectada), a mensagem seguinte daquela pessoa continuava sendo gravada na ficha que saiu da lista, que ninguém mais abre. Agora o canal social procura só entre as fichas ativas, como o WhatsApp e as chamadas de voz já faziam.

  Um limite que continua: a junção ainda não leva a identidade da rede social para a ficha que fica. Por isso, depois de juntar duas fichas assim, a próxima mensagem social daquela pessoa pode abrir uma ficha nova, em vez de cair na ficha que ficou.

  Contribuição de @Alencaf (#1444).

- **O classificador de intenção do roteador para de trocar de agente no meio de um fluxo por causa de resposta curta** Com um agente "grudado" (sticky) na conversa — por exemplo, o de Agendamento,
  no meio de uma coleta de dados —, uma resposta curta e ambígua do lead
  ("Primeira", "sim", "essa mesma") podia ser reclassificada para outra
  intenção com confiança suficiente pra trocar de agente, porque o
  classificador via só aquela mensagem isolada, sem a pergunta que ela
  respondia. O atendimento saía do fluxo de agendamento no meio da conversa,
  sem avisar ninguém.

  O classificador agora recebe também as últimas mensagens da conversa (não o
  histórico inteiro) só pra desambiguar respostas curtas — continua rodando a
  cada turno, com o mesmo custo por chamada de antes. Quem não usa o roteador
  por intenção não é afetado.

  Trabalho de @marcelovolei15, recortado do PR #1450.

- **A conversa não trava mais quando a resposta não veio da sua base de conhecimento** Quando o agente respondia sem consultar nenhum material da base — uma saudação, um
  agradecimento, qualquer assunto fora do que você indexou —, o sistema entendia isso como
  "o agente está inseguro", segurava a resposta sem enviar e passava a conversa para a fila
  humana. O cliente ficava sem resposta esperando alguém assumir.

  Agora a falta de consulta à base é tratada como o que é: ausência de medição, não nota
  baixa. O agente continua chamando uma pessoa quando escreve que não tem certeza, e
  continua chamando quando o material encontrado é fraco.

- **A importação de contatos reconhece cabeçalho em espanhol** A tela de importação de contatos, em espanhol, promete reconhecer as colunas "nombre, teléfono, email, cpf, nacimiento, tags", mas um CSV com cabeçalho "nombre;teléfono" falhava com "cabeçalho sem coluna de telefone nem e-mail". Agora o cabeçalho é reconhecido também em espanhol (nombre, apodo, correo, teléfono, móvil, fecha de nacimiento, cumpleaños…), com acento, maiúsculas e espaços como o Excel escreve. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **O espanhol da interface passa a soar como espanhol, e não como português traduzido** O espanhol do produto seguia a sintaxe do português e trazia palavras que em espanhol significam outra coisa: "demanda" (que é ação judicial), "retorno" e "agendamiento". Agora a demanda é "caso", o agendamento é "cita", o retorno prometido pela IA é "seguimiento" e a pessoa da equipe que atende é "asesor", para não se confundir com o "agente" de IA. A ação "Faturar" passa a "Cerrar y cobrar", porque em espanhol do México "facturar" costuma significar emitir uma nota fiscal. Revisamos as 6.899 frases da tela: cerca de 1.580 foram reescritas em frases mais curtas e diretas, e a Agenda, o Radar de risco e o Financeiro leem-se como texto escrito em espanhol. Também traduzimos as descrições de cinco destinos do menu (entre eles "Dados externos" em Configurações) que apareciam em português. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **O tipo de conta e a descrição do Financeiro passam a aparecer em espanhol** Em Configurações › Financeiro, quem usa o produto em espanhol via o tipo de cada conta (Caixa, Banco, Outra) em português, e a descrição do Financeiro no menu também ficava em português. Agora as duas aparecem em espanhol (Caja, Banco, Otra). Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **A importação de leads por planilha reconhece cabeçalho em espanhol** Em espanhol, uma planilha de leads com cabeçalho "Nombre, Teléfono, Correo…" não era reconhecida: o nome e o telefone caíam em "Colunas que não reconheci", e sem nome do negócio nem do contato a importação era recusada. Agora o importador entende também o cabeçalho em espanhol (nombre, contacto, teléfono, móvil, correo, descripción, precio, origen…), com acento e caixa como o Excel escreve. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **A importação do catálogo por planilha reconhece cabeçalho em espanhol** Em espanhol, uma planilha de produtos com cabeçalho "Producto, Precio, Costo, Cantidad" não era reconhecida: sem uma coluna de nome e outra de preço que o importador entendesse, o arquivo era recusado na primeira tela do catálogo. Agora ele entende também o cabeçalho em espanhol (nombre, producto, descripción, precio, precio de venta, costo, coste, cantidad, existencias, stock…), com acento e caixa como o Excel escreve. Para quem usa em português nada muda, e não exige ação de quem opera a instalação. Crédito: @JowaniOrantes.

- **O link de captura do Google Ads deixa de pôr um "[ref:]" vazio na mensagem do lead** Quando alguém abria o endereço de captura do Google Ads sem o identificador do
  clique (um teste, um link compartilhado, uma visita que não veio do anúncio), o
  WhatsApp abria com o texto configurado terminando em `[ref:]`, um colchete vazio
  que o lead enviava junto e que aparecia na conversa sem significar nada.

  Agora esse caminho tira o marcador inteiro do texto: a pessoa envia só a
  mensagem, e a conversa entra normalmente, sem origem de anúncio, como já
  acontecia. O caminho com o identificador do clique não muda.

  Contribuição de @rafaelbatistazz (#1405).

- **O MCP passa a contar token inválido e a barrar quem insiste** O endereço que as ferramentas de IA usam para conversar com o sistema (`/api/mcp`) recusava token inválido sem contar a recusa. Cada recusa custava uma consulta ao banco e ninguém era barrado: dava para varrer tokens sem limite e de graça, e um token já revogado podia ser martelado de vários endereços ao mesmo tempo sem que nada reagisse.

  Agora a recusa conta em dois lugares: por origem (30 recusas em 5 minutos) e pelo próprio valor apresentado (5 recusas em 5 minutos — a chave é o resumo do valor, nunca o valor em si). Estourado o teto, a resposta é `429`. Token válido em uso não entra na conta, e falha do banco — que é problema nosso, não de quem chamou — não tranca ninguém.

  Contribuição de @webtecnica (#1447).

- **O modelo enviado fora da janela de 24 horas agora pede os valores que ele exige** Quando a janela de 24 horas fechava e você escolhia um modelo aprovado com imagem no
  cabeçalho, ou com campos como {{1}} no texto, o envio saía sem esses valores. O WhatsApp
  recusava a mensagem, mas a tela mostrava "Modelo enviado", e o cliente nunca recebia nada.

  Agora o painel mostra um campo para cada valor que o modelo exige, como o link da imagem
  do cabeçalho, e só libera o botão com todos preenchidos. Se o envio falhar mesmo assim, o
  aviso passa a ser de erro e diz o motivo.

  O link da mídia também pode ficar salvo no modelo: marque "Salvar este link no modelo" e
  ele vem preenchido nos próximos envios. Crédito: @rafaelbatistazz.

- **Conectar o Google funciona quando você abre a instalação por localhost** Quem instala o DeskcommCRM no próprio computador e abre o sistema por `http://localhost:3000` não conseguia terminar a conexão com o Google Agenda: o endereço de retorno oferecido era sempre o que ficou gravado na instalação (o IP da máquina na rede, por exemplo), e o Google compara esse endereço letra por letra. A conexão voltava para outro endereço e nunca se completava.

  Agora, **quando e só quando** o navegador abre o sistema por `localhost` (ou `127.0.0.1`), o endereço de retorno acompanha — e é o mesmo que a tela mostra para você colar no painel do Google. Qualquer outro endereço continua perdendo para o endereço oficial da instalação, então nada muda para quem roda em servidor com domínio próprio.

  Contribuição de @betoarts (#714).

- **Alterar uma opção do agente preserva as outras configurações** Editar uma opção de uma versão em rascunho agora preserva ferramentas, limites e configurações de
  follow-up que não foram alteradas. Contribuição de @lucasa15 (#1375).

- **A troca de senha permite conferir os dois campos antes de salvar** A tela de recuperação mantém a confirmação da nova senha e ganha controles independentes para mostrar ou ocultar o conteúdo dos dois campos. Ela também mostra a força da senha, exige letra, número e símbolo e identifica os campos para o gerenciador de senhas do navegador oferecer o salvamento depois da troca.

  Contribuição de @matheuspedro360 (#1430).

- **Credencial de IA que falha na revalidação deixa de exibir a lista de modelos antiga** Ao testar de novo uma credencial de IA, se o provedor recusasse a chave o sistema registrava o erro mas mantinha a lista de modelos da validação anterior. Na tela, a credencial aparecia com a mensagem de falha e, logo abaixo, a contagem de modelos de antes — parecendo pronta para uso quando já não era.

  Agora a lista é zerada junto com o resultado da validação: quem olha vê o erro e nenhum modelo disponível, que é o estado real. Uma revalidação bem-sucedida continua gravando os modelos que o provedor devolveu.

  Contribuição de @betoarts (#714).

- **A suíte deixa de depender do proxy de modelo de quem a roda** Nada muda para quem usa o CRM: a correção é na suíte de testes.

  Quem contribui com um proxy de modelo configurado no shell (LiteLLM, um gateway
  da empresa, qualquer roteador local) via `tests/unit/gateway-destino-por-caminho`
  reprovar na própria máquina enquanto passava no CI — o teste afirma para onde a
  requisição vai, e os SDKs da Anthropic e da OpenAI leem `ANTHROPIC_BASE_URL` do
  ambiente por conta própria, apontando o destino para `localhost`.

  O teste passa a isolar essas variáveis, e a devolvê-las depois.

  Contribuição de @lussandro (#1427).

## [1.41.0] — 2026-09-20

### Adicionado

- **A agenda da equipe vira uma opção: Atendentes podem (ou não) mexer na agenda dos colegas** Até aqui, qualquer Atendente cancelava e remarcava o compromisso de qualquer
  colega — a agenda era uma só para todo mundo. Agora isso é uma escolha da
  organização, em **Configurações › Tipos de agendamento**:

  - **Ligada (o padrão, e o de quem já instalou):** tudo como sempre foi. Qualquer
    Atendente mexe na agenda de qualquer colega, e ninguém vê mudança nenhuma
    depois de atualizar.
  - **Desligada:** o Atendente mexe só no compromisso de que é o responsável.
    Gerente e Administrador continuam mexendo em tudo.

  Não há ação para quem opera a VPS, e a escolha vale igual nos dois lugares onde
  a regra é aplicada: no banco (a alteração e o cancelamento) e na rota que a tela
  usa. Desligar hoje e religar amanhã volta tudo ao que era, sem atualização.

- **Crie o agente conversando com a IA dentro da campanha** Descreva a oferta e o objetivo em uma conversa. A IA pergunta o que falta e prepara um resumo com abordagem, qualificação, conexão e funil; você pode pedir ajustes antes de confirmar a criação e publicação. As permissões comerciais são preparadas automaticamente e alterações de continuidade do canal pedem uma escolha explícita. O agente fica selecionado ao terminar; o início das abordagens continua separado. Solicitações repetidas recuperam a criação anterior e erros conservam os campos preenchidos. Crédito: @saraivabr.

- **Ajustes determinísticos de estilo antes do envio** A organização agora pode ligar ajustes de estilo aplicados às mensagens escritas pela IA antes das verificações de envio. O primeiro item troca travessões longos de forma determinística, sem depender do prompt e sem alterar mensagens humanas ou templates. Crédito: @joaopaulomirandamatias.

- **Dá para cadastrar contas, formas de pagamento e plano de contas** Uma tela nova em Configurações › Financeiro, com três listas:

  **Contas** — onde o dinheiro fica (caixa, banco). O valor que você informa é o
  saldo de partida; o saldo que aparece nos relatórios é sempre somado dos
  lançamentos, nunca um número guardado que pode divergir.

  **Formas de pagamento** — como o cliente paga. Cada forma aponta para a conta em
  que aquele dinheiro entra. Uma forma sem conta definida aparece marcada, porque
  ela não vai conseguir fechar uma venda.

  **Plano de contas** — como cada lançamento é classificado, e se é entrada ou
  saída. Escolher entre as duas é obrigatório: um plano de contas em que tudo é a
  mesma coisa não classifica nada.

  Nada disso movimenta dinheiro — é a base que as telas de venda vão usar.

  Quem só tem acesso de leitura vê a tela; alterar é de gerente para cima. Crédito: @423313 (#819).

- **A comanda, e o que ela move quando você fecha** Chega a base de venda: comanda com itens, comissão por quem atendeu, lançamento
  no financeiro e ponto de fidelidade.

  Fechar uma comanda faz cinco coisas de uma vez, e ou todas acontecem ou nenhuma:
  marca a venda, gera a comissão de cada item, lança a entrada na conta que a
  forma de pagamento indica, dá o ponto de fidelidade e conclui o agendamento
  ligado a ela.

  Algumas escolhas que você vai notar no uso:

  O saldo de uma conta e o saldo de pontos de um cliente **nunca ficam guardados**:
  são sempre somados dos lançamentos. É o que garante que o relatório
  e o extrato contem a mesma história depois de um estorno.

  **Estornar não apaga nada.** Entra um lançamento contrário, ligado ao original, e
  os dois ficam. A comissão vira "estornada" em vez de sumir, e o ponto de
  fidelidade volta como um movimento negativo.

  **A comissão é decidida na entrada do item**, e não quando a comanda fecha.
  Mudar a regra amanhã não mexe no que já foi combinado ontem.

  Um lançamento já pago não muda mais de valor, conta ou data — o caminho é o
  estorno.

  E faturar **não desfaz** um agendamento que já tinha sido cancelado ou marcado
  como falta. Crédito: @423313 (#819).

- **A comanda ganhou as rotas que faltavam** As tabelas da comanda e as funções que movem dinheiro já existiam, e nada as
  chamava: o módulo estava inteiro no banco, sem porta.

  Agora `/api/v1/financeiro/comandas` abre, lista, recebe item, dá desconto,
  cancela, finaliza e estorna. A comissão de cada item é resolvida na entrada, com
  a precedência combinada (pessoa e serviço vence pessoa, que vence serviço), e
  fica congelada na linha: mudar a regra amanhã não mexe no que já foi feito.

  A tela do balcão ainda não existe; por enquanto o caminho é a API. Crédito: @423313 (#819).

- **Compromisso presencial ou por telefone também pode ser mandado ao cliente** Até agora, mandar os dados do compromisso para o cliente pelo CRM só existia quando o compromisso era uma reunião no Google Meet. Numa visita, numa ligação ou num atendimento no balcão, a seção nem aparecia na tela: quem marcava tinha de avisar o cliente por fora, à mão, sem registro no histórico.

  Agora ela aparece para qualquer tipo de compromisso, e o texto que chega ao cliente fala do que existe — data, hora e fuso —, **sem prometer um link que não há**.

  Onde o compromisso É uma reunião online, nada mudou: o link continua tendo de estar pronto antes de sair. Mandar uma reunião sem como entrar nela é pior que não mandar.

  Contribuição de @paulolimajr77 (#803).

- **Conecte um banco de dados de outro sistema e explore-o de dentro do CRM** Quando o seu outro sistema escreve num PostgreSQL — um segundo CRM, um ERP, a
  base que a operação usa —, esses dados eram invisíveis aqui dentro. É ali que
  costuma morar o que o cliente pergunta: pedido, assinatura, matrícula, saldo.

  Agora essa base pode ser cadastrada e consultada pelo próprio CRM. O caminho é
  **Organização › Dados e acesso › Dados externos**. Qualquer pessoa da equipe vê
  a lista e explora os dados; só um administrador cadastra, edita ou remove a
  conexão.

  - **Somente leitura, de verdade.** A conexão roda em transação de leitura
    obrigatória, com tempo limite, e só aceita consultas de seleção. Nada que o
    CRM faz altera o banco de origem.
  - **A senha é cifrada** com a mesma chave que o sistema já usa para as chaves de
    IA, e nunca é mostrada de volta — ao editar, o campo de senha nasce vazio.
    Nenhuma variável de ambiente nova, nenhum passo manual de atualização.
  - **Nada de schema fixo.** As tabelas e os campos são lidos na hora, então
    quando o outro sistema muda, a tela já enxerga o novo formato.
  - **Os tetos são seus.** Linhas por consulta, filtros e tamanho de resposta são
    configurados por conexão, dentro de faixas seguras.

  Nada muda para quem não cadastrar nenhuma conexão: sem conexão, o recurso não
  faz nada. Quem instala ou atualiza numa VPS recebe pelo procedimento de sempre
  (`update.sh`) — a mudança de banco entra junto do baseline.

  Trabalho de @vgamkt, recortado do PR #1130.

- **Faturar de uma vez os atendimentos que ficaram sem comanda** Atendimento que aconteceu e ninguém faturou era um buraco silencioso: não
  aparecia em lugar nenhum, e só era descoberto conferindo a agenda contra o
  caixa.

  Em **CRM › Comandas**, a lista "Atendimentos sem comanda" mostra o que já
  aconteceu e não foi cobrado. Marque, escolha a forma de pagamento, fature tudo
  de uma vez. Nada vem marcado: faturar é irreversível.

  Para isso, o serviço ganhou **preço padrão** em Configurações › Agenda. Ele
  também vira o valor sugerido ao lançar item na comanda, e pode ser mudado lá.
  Serviço sem preço aparece na lista com aviso, e não pode ser faturado em lote. Crédito: @423313 (#819).

- **A fidelidade passa a ter saldo e extrato** Os pontos de fidelidade eram gravados na finalização da comanda e não apareciam
  em lugar nenhum: não dava para consultar o saldo de um cliente nem resgatar.

  Agora o saldo aparece ao lado da comanda do cliente, dá para informar quantos
  pontos aquela venda gera na hora de finalizar, e a API devolve saldo e extrato.
  Corrigir um lançamento errado é lançar o contrário, com motivo: o extrato
  explica o saldo inteiro. Crédito: @423313 (#819).

- **O funil mostra telefone, e-mail e links do cliente no card e no painel do negócio** Para saber como falar com o cliente de um negócio, era preciso sair do funil e abrir a ficha do contato. Agora o card mostra o telefone, o e-mail e um botão para cada link cadastrado (Instagram, site, Google Meu Negócio, Facebook, LinkedIn, TikTok, YouTube ou outro), e o painel do negócio ganhou a seção "Contato" com duas abas: "Dados" (telefone com atalho para o WhatsApp, e-mail e um caminho para a ficha completa) e "Links", onde os endereços se preenchem e se salvam ali mesmo. Os links ficam no próprio contato, em campos personalizados, e só endereços http(s) são aceitos — qualquer outro tipo de endereço é recusado. Contato anonimizado a pedido do titular (LGPD) não aparece no card. Não há mudança no banco de dados. Nada para configurar. Crédito: @RafaelBarbosaBR.

- **Lisboa passa a aparecer nas listas de fuso horário** Quem opera em Portugal não encontrava o próprio fuso: o assistente de boas-vindas oferecia Lisboa, mas as listas de Configurações › Organização, do Perfil, da jornada em Equipe › Atendimento e da janela de envio em Conexões › Proteção de envio só tinham cidades da América do Sul, Luanda e UTC. Escolher UTC deixava tudo uma hora fora no verão europeu. Agora "Lisboa (Portugal)" aparece nas quatro. O padrão de quem ainda não escolheu continua São Paulo, e ninguém muda de relógio com a atualização. Crédito: @maclevison.

- **Consulte o enriquecimento da empresa durante a conversa** O painel lateral do Inbox mostra site, segmento, endereço, avaliações, e-mails
  comerciais e redes sociais coletados na prospecção, com data da busca e link da
  fonte. Contatos sem enriquecimento têm estado vazio explícito; falhas permitem
  repetir a leitura. Dados de contatos anonimizados não são apresentados.
  Crédito: @saraivabr.

- **Lançamentos que se repetem todo mês** Aluguel, internet e contador precisavam ser lançados à mão todo mês, e o mês
  esquecido fazia o relatório parecer melhor do que foi.

  Em **Configurações › Financeiro**, a seção "Todo mês" guarda o molde: valor, dia
  e conta. O sistema abre a conta a pagar no dia certo, **sempre como pendente** —
  ele sabe que a conta vence, não sabe se você pagou. Quem escolhe o dia 31 é
  atendido no último dia dos meses mais curtos, em vez de pular fevereiro. Crédito: @423313 (#819).

- **Dá para lançar o que não veio de comanda** O financeiro só registrava o que entrava por comanda fechada. Aluguel, material
  e salário não tinham por onde entrar, e o "Saiu" do relatório era zero para
  sempre.

  Em **Análise › Faturamento**, abaixo dos números do período, agora é possível
  lançar entrada ou saída, dizer em que conta caiu, marcar como já pago ou deixar
  pendente, e quitar depois. Lançamento pago não se apaga: o caminho de desfazer é
  um lançamento contrário. Crédito: @423313 (#819).

- **Responda conversas pelo painel de mensagens em qualquer tela** O botão Mensagens acompanha a navegação com contador de conversas não lidas, busca,
  logos dos canais e atendimento compacto. Minimize sem perder o texto em edição ou
  amplie a conversa no Inbox. Usa os mesmos canais, histórico e permissões existentes.
  Crédito: @saraivabr.

- **Encontre empresas e inicie conversas graduais com IA pelo CRM** Administradores podem pesquisar empresas por segmento e região, enriquecer dados comerciais e preparar campanhas no menu Prospecção. Cada busca possui teto de gasto, e a fila de primeiras abordagens respeita o ritmo configurado, as proteções do canal, intervenções humanas e recusas. As respostas continuam no Inbox e a qualificação aparece conforme a etapa real do funil. A integração opcional usa a chave Apify cifrada da organização; todos os registros ficam no banco do CRM. Crédito: @saraivabr.

- **Conexão nativa de redes sociais no CRM** Conexões ganha Redes sociais: credencial cifrada, escolha do perfil, contas
  vinculadas, autorização e verificação da conexão. Instagram e Facebook podem
  receber mensagens no Inbox e usar o atendimento humano e o motor de IA existente.
  A IA começa pausada. As demais redes ficam identificadas como contas vinculadas,
  sem prometer atendimento não implementado. A integração preserva WhatsApp e
  webhooks externos; não importa histórico nem publica conteúdo automaticamente.

- **Dá para enviar o link da reunião de novo, quando o cliente não recebeu** Antes, um compromisso cujo link já tinha sido enviado mostrava "Link já enviado" e o botão ficava desligado. Se o cliente apagou a conversa, trocou de número ou simplesmente não recebeu, não havia caminho: só mandar o link à mão, por fora do CRM — o que deixa a entrega sem registro e sem histórico.

  Agora o botão vira **"Enviar de novo"**, e pergunta antes de mandar. A pergunta não é formalidade: é ela que substitui a proteção contra clique duplo, que continua valendo para o envio comum.

  E ele só destrava quando o envio já **saiu**. Enquanto a entrega está a caminho, o botão segue mostrando "Envio já autorizado" e desligado — repetir ali não adiantaria nada, só empilharia pedido.

  Contribuição de @paulolimajr77 (#803).

- **Dá para cadastrar regra de comissão** A comissão de cada item saía de regras que **ninguém conseguia cadastrar**.
  Não havia tela nem rota, e na prática todo item entrava com zero.

  Em **Configurações › Financeiro** existe agora a lista "Comissão": escolha a
  pessoa, o serviço, ou os dois, e o percentual. A tela diz qual regra vence
  quando mais de uma serve, porque não é o maior percentual que ganha, e sim a
  mais específica. Crédito: @423313 (#819).

- **O relatório de faturamento, em Análise** Depois que a comanda passou a existir, faltava a pergunta do fim do mês: quanto
  entrou, de que forma, e quanto cada pessoa tem a receber.

  **Análise › Faturamento** responde por período: entradas, saídas, saldo, ticket
  médio, comandas finalizadas e estornadas, o total por forma de pagamento e a
  comissão de cada pessoa. Os números são somados no banco, e não na tela. Crédito: @423313 (#819).

- **O faturamento mostra por serviço e por cliente** O relatório respondia quanto entrou e de que forma. Faltavam as duas perguntas
  que decidem o que fazer na semana seguinte: **qual serviço** sustenta o
  faturamento e **quais clientes** sustentam a casa.

  As duas listas aparecem em Análise › Faturamento, com os dez primeiros de cada.
  Os totais continuam somando tudo: o corte está na lista, nunca no número. Crédito: @423313 (#819).

- **A tela de comandas, em CRM** A comanda existia no banco e nas rotas, e não tinha tela: para lançar um
  atendimento era preciso chamar a API.

  Agora **CRM › Ver tudo em CRM › Comandas** abre a comanda, lança item, mostra o total mudando,
  finaliza escolhendo a forma de pagamento e estorna (com motivo, e só para
  gerente). Quando a forma de pagamento escolhida ainda não tem conta de destino,
  o aviso aparece **antes** de tentar fechar, dizendo onde resolver.

  Ela mora dentro do hub de CRM, e não numa linha nova do menu: o menu inteiro
  precisa caber na tela sem rolar, e grupo escondido abaixo da dobra é grupo que
  ninguem encontra. Pelo atalho de busca (Ctrl+K ou Cmd+K), "comanda" leva direto. Crédito: @423313 (#819).

- **Telefonia por SIP com atendimento por IA, como módulo que você liga quando quiser** O CRM passa a atender e fazer ligações por um tronco SIP, com a IA conduzindo a conversa e a transcrição ficando no histórico do contato. Os números são cadastrados em Conexões › Telefone, cada um apontando para um agente de voz, e as chamadas aparecem em Chamadas, junto das ligações por WhatsApp.

  **O módulo nasce DESLIGADO.** Sem escrever `telefonia` em `COMPOSE_PROFILES` no `.env`, o sistema sobe exatamente como hoje. Para ligar, o `.env.example` traz o passo a passo, e as credenciais do provedor SIP ficam em Configurações › Trunk SIP. Com o módulo ligado, as portas de voz (UDP 5060 e 10000-10200) passam a ser publicadas, porque o provedor do tronco precisa alcançá-las. Crédito: @SnoopyHuman (#677).

- **Conectar WhatsApp por código de pareamento** Conexões e primeiro acesso permitem escolher QR Code ou código de pareamento.
  O administrador informa o telefone completo e digita no celular o código gerado.
  O QR continua disponível como alternativa. A conexão só é concluída quando o
  serviço confirma o aparelho conectado; gerar o código não desconecta sessões ativas.

### Alterado

- **Identifique o canal pelo logo na lista e no cabeçalho da conversa** As conversas mostram o logo do WhatsApp, Instagram ou Messenger junto à identidade
  do contato, mesmo quando há uma única conexão. A identificação usa a rede da
  conexão e preserva a foto do contato e o indicador de atendimento. Crédito: @saraivabr.

### Corrigido

- **A Agenda abre na semana certa, mesmo à noite de sábado** Quem abrisse a Agenda no fim da noite de sábado via, por um instante, a semana seguinte, e só então a tela se corrigia. Agora a semana é calculada no fuso configurado: o da pessoa, em **Configurações › Perfil**, e o da empresa, em **Configurações › Empresa**, quando a pessoa não escolheu nenhum. Fuso inválido abre no padrão em vez de falhar. Nada a fazer na atualização.

- **Arquivar um canal oficial devolve o webhook do número à Meta** Conectar um canal oficial da Meta aponta o webhook daquele número para esta instalação. Ao
  arquivar ou excluir o canal, essa configuração ficava órfã na Meta: o token do caminho do
  webhook era rotacionado e a credencial apagada, e a Meta seguia entregando num endereço que
  responde 404 para sempre — sem erro nenhum do nosso lado, porque a entrega nem chegava aqui.
  Agora o número volta para a URL do app antes de a credencial ser apagada, que é a última
  chance de a chamada ser autenticada. Se a Meta recusar, nada muda para o operador: o
  arquivamento (ou a exclusão) que ele pediu acontece do mesmo jeito e a recusa fica no log e
  na auditoria.

- **Estampar atribuição de anúncio passa a exigir a organização** `fn_estampar_atribuicao_de_anuncio` grava de qual anúncio um contato veio, e rodava como `security definer` olhando só o id do contato: uma chamada com id de outra organização estampava o anúncio no contato alheio, por um caminho que a RLS não vê.

  A organização passa a ser parâmetro obrigatório, e o `where` a exige: contato de outra organização casa zero linhas e nada é gravado. A assinatura antiga sai do catálogo na mesma migration — mantida, a chamada velha resolveria nela e a organização nunca chegaria ao filtro.

  Para quem opera nada muda: a migration sobe com o deploy.

  Contribuição de @webtecnica (#1321).

- **O que a equipe escreve sobre um cliente deixa de ficar congelado no registro de auditoria** Três ações do módulo financeiro — alterar e estornar comanda, e lançar pontos de fidelidade — gravavam no registro de auditoria o texto livre que a equipe escreve **sobre a pessoa**: a observação, o motivo do estorno, a justificativa dos pontos.

  Esse registro é a única tabela que ninguém pode alterar nem apagar, por desenho, para servir de prova — e por isso a anonimização não alcança o que ficou escrito ali. Quando um cliente pedia para ser esquecido, a frase sumia da comanda e sobrevivia na auditoria pelo tempo inteiro de retenção.

  Agora a auditoria guarda o que descreve o **ato** — que a observação mudou, que houve motivo e de que tamanho, quantos pontos — e nunca o texto, que segue guardado onde a anonimização chega. Registros gravados antes desta versão continuam como estão: eles não podem ser reescritos, e essa é a razão do conserto.

- **Uma falha nos classificadores auxiliares não cala mais o agente** Antes de responder, o agente consulta dois auxiliares baratos: um chuta em que
  etapa do funil a conversa está, e o outro olha se a mensagem do cliente é uma
  tentativa de manipular o assistente. Os dois são conselheiros — quem decide é o
  modelo do agente, e nenhum dos dois nunca teve poder de barrar um atendimento.

  Mesmo assim, se um deles falhasse, o atendimento inteiro parava: o cliente ficava
  sem resposta. E o caso comum não era o provedor cair — era o modelo desses dois
  pontos, em **Configurações › Provedores de IA**, apontar para algo que não existe
  mais ou para uma chave revogada. O modelo do agente estava de pé, a conversa não
  andava, e nada na tela explicava por quê.

  Agora a falha do conselheiro é só a falha do conselheiro: o agente responde do
  mesmo jeito, apenas sem o palpite de etapa daquele turno. A falha não some — a
  chamada frustrada fica registrada em **Uso de IA**, como qualquer outra.

  Uma coisa segue interrompendo o atendimento de propósito: o teto de gasto do mês.
  Quando é ele que barra a chamada, a conversa continua sendo passada para uma
  pessoa, que é o que já acontecia.

  Trabalho de @betoarts, recortado do #714.

- **A doutrina passa a dizer como ler o arquivo de esquema sem medir a versão errada** Documentação interna, para quem desenvolve: o arquivo que descreve o banco é montado em camadas, e a mesma peça aparece nele várias vezes — vale a última. Quem procurava com uma busca simples podia ler uma versão antiga e concluir o contrário do que o sistema faz.

  A doutrina agora traz as duas formas certas de perguntar, com os comandos. Nada muda para quem opera uma instalação.

- **O build do E2E e o smoke do LLM recusam na primeira linha quando falta o binário** Duas ferramentas internas podiam morrer no meio do trabalho por um motivo que já se sabia na primeira linha: o binário que faz o serviço não estava instalado. O build do E2E anunciava `==> Buildando contra ...` e só então esbarrava na falta do `next`; o smoke do LLM subia `==> subindo pgvector ...` para cair adiante. Nos dois, o que ficava na tela era o anúncio de um passo que não chegou a rodar.

  Agora as duas recusam antes de qualquer trabalho, dizem qual binário falta e mandam rodar `pnpm install`.

  Não muda nada para quem opera uma instalação — é ferramenta de quem desenvolve.

- **A gaveta de funis arquivados confirma a exclusão como o quadro** Excluir de vez um funil arquivado pedia confirmação num cartão solto dentro da própria linha: quem
  usa leitor de tela ouvia a lista atrás da pergunta, porque o foco não saía dali. A gaveta agora abre
  o mesmo painel do quadro — foco preso, papel de diálogo de alerta —, o botão que abre a gaveta diz
  qual lista ele controla, e a recusa da exclusão tem endereço próprio. Crédito: @webtecnica.

- **A imagem do módulo de telefonia voltou a construir** A imagem `deskcomm-voice-agent`, que o módulo opcional de telefonia usa, não
  chegava a ser criada: a receita dela não copiava o diretório `patches/`, e o
  `pnpm install` morria antes de instalar qualquer dependência.

  Nada muda para quem já instalou — a imagem nunca existiu, então ninguém a estava
  baixando. O que isto destrava é a publicação de versões: o passo final da
  publicação confere se as quatro imagens do produto estão ao alcance de qualquer
  VPS, e ele não fechava enquanto uma delas não nascia.

- **A janela de envio do WhatsApp passa a seguir o fuso da empresa** O horário em que o CRM pode mandar mensagem pelo WhatsApp (das 7h às 22h, por padrão) era contado no horário de São Paulo sempre que ninguém tinha escolhido um fuso em Conexões › Proteção de envio, qualquer que fosse o fuso da empresa. Numa empresa em Lisboa, isso virava das 11h às 2h da manhã: a resposta do agente a quem escreveu às 9h esperava até as 11h. Agora, sem fuso escolhido no número, vale o fuso da empresa (Configurações › Organização). Quem escolheu um fuso no número continua com ele, e quem está em São Paulo não percebe diferença. Crédito: @maclevison.

- **Link de conversa quebrado passa a dizer o que aconteceu, em vez de abrir uma tela vazia** Abrir um link de conversa com endereço estragado levava a uma tela que parecia uma conversa de verdade e estava vazia — não dava para distinguir conversa inexistente, conversa sem mensagens e falha.

  Agora a tela diz **"Conversa não encontrada ou fora do seu acesso"**, a mesma mensagem de quando o link aponta para conversa de outra empresa. Nos bastidores, esse link também deixa de virar erro de servidor no registro da instalação: quem administra a VPS para de ver falhas que nunca foram falha de nada. Nada a fazer na atualização.

- **A limpeza das autorizações de agenda usadas volta a rodar** A limpeza diária das autorizações de agenda já usadas e vencidas — a que impede que uma autorização capturada seja reaproveitada — falhava todos os dias sem apagar nada, e a tabela só crescia. A rotina pedia a limpeza por um nome de parâmetro e a função do banco tinha sido criada com outro, então o banco devolvia erro antes de apagar; de quebra, a varredura de anonimizações LGPD interrompidas, que roda logo depois no mesmo trabalho agendado, não chegava a acontecer. Agora os dois lados falam a mesma língua, e a instalação que já existe recebe o conserto na atualização. Ninguém precisa fazer nada.

- **Recusar o envio do link do Meet deixa de virar tentativa repetida** Quando o CRM recusa "Enviar link ao cliente" — porque o compromisso mudou, porque o atendimento daquela conversa mudou, ou porque o Google e o CRM discordam —, a recusa agora chega na hora, com o motivo dela.

  Antes essas três recusas saíam com um código que significa "tente de novo", e o sistema acreditava: repetia o mesmo pedido, três vezes, e só então mostrava "Erro inesperado". Quem operava cronometrou **20 segundos** parado na tela para uma recusa que o banco sabia dizer no primeiro milissegundo. Pior: uma resposta dessas podia ser repetida indefinidamente por baixo, o que já derrubou o sistema inteiro uma vez.

  Agora cada recusa tem a frase que diz **o que fazer** — atualizar a página, escolher a conversa atual, resolver a diferença com o Google — e não é mais repetida sozinha.

  Contribuição de @paulolimajr77 (#803).

- **O painel de chamada para de cobrir a ação do rodapé** Durante uma chamada, o painel de voz fica no canto inferior direito e cobria o
  que estivesse embaixo dele: no funil, o botão "Excluir nó" do painel de
  configuração ficava inclicável enquanto a ligação durava.

  Agora cada peça fixa do rodapé diz quanto ocupa — a distância até o fundo mais a
  altura dela — e a tela desconta isso do conteúdo. A altura vem da medida real do
  painel, então quando ele cresce (o aviso de que o áudio está em outra aba, por
  exemplo) a folga cresce junto.

  Sem chamada em andamento nada muda: a reserva é zero e o rodapé de todas as
  telas continua exatamente o que era. Nenhuma variável nova para configurar e
  nenhum passo na atualização.

  Contribuição de @webtecnica.

- **O erro de envio no inbox para de sair da tela** Quando o provedor recusava uma mensagem, o inbox mostrava o motivo num balão de uma linha só: o texto do provedor é longo, o balão crescia para a direita e o fim da frase ficava fora da tela — em 1280, 1366 e em 1440 px. O operador via "Falhou" e um começo de explicação, sem o resto, que é justamente a parte que diz o que fazer.

  O balão agora quebra em várias linhas dentro de uma largura máxima. A correção foi feita na classe base do balão, e não no ponto que mostrou o defeito: assim vale para todo balão do produto, inclusive os que mostram texto que vem de fora (a mensagem de erro do provedor, que não está no código e não tem tamanho previsto). Nada muda para os balões curtos.

  Contribuição de @webtecnica (#1319).

- **O verificador de banco avisa quando não consegue rodar, em vez de parecer que passou** Uma ferramenta interna de verificação do banco podia terminar **sem ter executado teste nenhum** e ainda assim deixar um registro cheio de marcas de sucesso: ela preparava o banco, aplicava o esquema duas vezes, e só então descobria que faltava a peça que roda os testes — num aviso perdido no meio de centenas de linhas verdes.

  Quem lesse o resultado concluiria que tudo passou. Nada passou: nada rodou.

  Agora ela recusa na primeira linha, diz o que faltou e qual comando usar. Não muda nada para quem opera uma instalação — é ferramenta de quem desenvolve.

## [1.40.0] — 2026-09-19

### Adicionado

- **A configuração do servidor passa a caber na tela, e o painel ganha porta** Quem administra a instalação passa a ter uma tela nova, no **Modo administrador**,
  onde troca o que antes só se mudava entrando no servidor por
  linha de comando e editando o arquivo de instalação: a chave do serviço de
  e-mail, o endereço que aparece como remetente, o e-mail de suporte e o e-mail do
  encarregado de dados. O que se salva ali **vale na hora**, sem reiniciar nada.

  A tela diz de onde cada valor está vindo — definido ali mesmo, herdado do
  arquivo de instalação, ou ainda não configurado. É a primeira pergunta de quem
  vê algo estranho, e até agora ela só se respondia abrindo o servidor.

  Credencial nunca volta para a tela: aparece só o fim dela, o bastante para
  reconhecer qual está guardada. E o que **não** dá para trocar por ali continua
  aparecendo, com o motivo escrito em português e o caminho para mudar — em vez de
  um campo que aceitaria o valor e não faria efeito nenhum.

  O painel de administração também ganhou uma porta no menu do usuário, para quem
  administra a instalação. Antes só se chegava nele digitando o endereço, ou por
  um item chamado "Gerenciar organizações" escondido no seletor de organização.
  Quem não administra a instalação não vê a porta, não abre a tela e não consegue
  salvar — são três barreiras, e a última existe porque um envio direto, sem
  passar pela tela, driblaria as duas primeiras.

- **Follow-up ganha horário próprio por agente** Cada agente pode limitar os follow-ups automáticos a dias e horários próprios, sem reduzir o período em que responde mensagens recebidas. Fora da faixa, o envio fica aguardando a próxima abertura no fuso da organização e ainda passa pelas regras anti-ban do número. Crédito: @joaopaulomirandamatias.

## [1.39.0] — 2026-09-19

### Adicionado

- **Durante a atualização, o sistema mostra um aviso em vez de um erro do navegador** Enquanto a atualização mexe no banco, o CRM precisa ficar parado por alguns segundos — é o que impede que uma regra de isolamento suma no meio do caminho e a tela fique vazia sem explicação.

  Até agora, quem estivesse com o sistema aberto nesse momento via o erro de conexão do próprio navegador: uma tela branca que não diz de quem é o problema nem quanto tempo dura.

  Passa a aparecer uma página dizendo **"Estamos atualizando o sistema"**, com o aviso de que nada do trabalho se perde. Ela **volta sozinha** para a tela de antes quando o sistema sobe — ninguém precisa recarregar nem saber que houve atualização.

  Duas decisões que valem estar escritas:

  - **Se a atualização der errado no banco, o aviso FICA de pé.** O CRM não volta ao ar com regra de isolamento faltando, e nesse caso a página é a única coisa que explica a quem tentar abrir por que o sistema não responde.
  - **A página não leva marca nenhuma.** Ela sobe antes de qualquer coisa poder consultar o banco, que é onde a marca da instalação mora — uma página neutra é a única que não mente sobre de quem é o sistema.

  Nenhum passo manual foi acrescentado: quem opera continua clicando no mesmo botão.

  Trabalho de @paulolimajr77, recortado do #803.

- **O canal que está em modo de teste passa a avisar que a IA não responde ninguém** Um canal de WhatsApp recém-conectado nasce em modo de teste: a IA só responde aos números que você autorizar. Isso continua igual, e é o que evita resposta automática por acidente enquanto você monta a instalação.

  O que muda é o esquecimento. Se o canal ficar três dias ligado, em modo de teste e sem nenhum número autorizado, abre um aviso na Central dizendo que a IA não responde a ninguém nele e o que fazer em Conexões. Antes, o sintoma era o pior possível: as mensagens chegavam no Inbox, tudo parecia funcionar, e a IA simplesmente nunca respondia — quem instalou concluía que o produto estava quebrado, não que faltava um clique.

  O aviso se resolve sozinho quando deixa de ser verdade: o canal ganhou número autorizado, foi aberto ao público ou foi arquivado. Quem já tem os canais configurados não vê aviso nenhum.

  Construído sobre o modo de teste do WhatsApp, de @rafaelcesardev (#599).

- **As etiquetas ganham cor — e o filtro passa a mostrar a mesma cor que a lista** A tela Configurações › Tags passa a deixar você escolher a COR de cada etiqueta, numa paleta de oito tons. A paleta não foi escolhida a olho: cada tom foi medido contra os outros, inclusive para quem tem daltonismo, e o texto de dentro do marcador é escolhido pelo contraste — cor não deixa etiqueta ilegível.

  A cor aparece onde a etiqueta aparece: na lista de conversas, no painel lateral do atendimento, na lista e na ficha do contato, no funil e no filtro de etiqueta das três telas, que agora mostra um ponto da mesma cor antes do nome. Numa fila de duzentas conversas é a cor que faz achar "reclamação" antes de ler o texto — e é ela que denuncia a duplicata de vocabulário ("orçamento" e "orçamento novo" em dois tons do mesmo verde) que o número de uso sozinho não mostra.

  Nada muda para as etiquetas que você não pintar: elas continuam exatamente como estavam. E escolher cor para uma etiqueta que ainda não estava no vocabulário (uma que existe só porque alguém escreveu no contato, por exemplo) passa a trazê-la para o vocabulário curado — é o efeito de decidir como ela deve aparecer.

  A cor também aparece na hora de ESCOLHER a etiqueta: as sugestões dos editores e a ação em massa do funil mostram o ponto da mesma cor. E a tela de Tags ficou à prova de dado torto: se o campo de etiquetas da organização tiver um valor que não é lista, renomear e pintar não derrubam mais a tela — a primeira alteração que você fizer conserta o campo.

  Crédito: @webtecnica.

- **O atendente na DeepSeek pode parar de "pensar" antes de responder** A DeepSeek, por padrão, escreve um raciocínio interno antes de cada resposta — e cobra
  cada palavra dele como texto de saída. Em conversas longas isso pesa: medimos o turno do
  atendente gastando cerca de oito vezes mais saída do que com a OpenAI e demorando mais
  para responder, o que anulava a economia do preço mais barato.

  Agora quem cuida do servidor pode desligar esse raciocínio com
  `DEEPSEEK_THINKING=disabled` no `.env`. Sem configurar nada, tudo segue como está: o
  raciocínio continua ligado. A mudança vale só para a DeepSeek — Anthropic, OpenAI, Google
  e OpenRouter não são afetadas.

  Contribuição de @deskcommopp4s-cmd (#1275).

- **Um comando tira esta instalação do Docker sem encostar no resto do servidor** Tirar o CRM de uma VPS era trabalho manual, e o atalho que todo mundo conhece — `docker system
  prune -a` — é o errado: numa VPS que hospeda mais de uma coisa, ele leva junto containers, volumes
  e imagens de aplicações que ninguém pediu para apagar.

  Agora existe `desinstalar_docker.sh`, na raiz do repositório. Ele descobre o projeto pelo label que
  o Docker Compose grava e remove **apenas** os containers, os volumes e as redes internas deste
  projeto. Ficam intactos: as outras aplicações do mesmo servidor, as imagens, o cache de build, a
  rede externa do proxy reverso, o código, o `.env`, os backups e um Supabase externo.

  Antes de remover qualquer coisa, o script mostra o daemon escolhido, o nome do projeto, o diretório
  da instalação e quantos containers, volumes e redes encontrou — e pede que você digite
  `REMOVER-<nome-do-projeto>` para confirmar. Em rotina automatizada, `--force` pula a pergunta; se a
  instalação usa um `COMPOSE_PROJECT_NAME` personalizado que não está mais no `.env`, `--project-name`
  diz qual é. Quando duas cópias do repositório dividem o mesmo nome de projeto e a outra ainda existe
  no disco, o script para e manda rodar a partir dela, em vez de assumir que os recursos são seus.

  Os volumes incluem as sessões locais do WhatsApp: rode `backup.sh` antes se precisar preservá-las.
  Quem não executar o script não tem nada a fazer — nenhuma variável nova, nenhum passo na
  atualização.

  Trabalho de @betoarts, recortado do #714.

- **Funil arquivado agora tem caminho de volta — dá para ver, tirar do arquivo e excluir** Arquivar um funil era via de mão única: ele sumia da lista de Funis e não havia onde vê-lo de novo, trazê-lo de volta nem excluí-lo. Quem arquivou por engano ficava com um funil invisível, indestrutível, e ainda com o nome dele ocupado — criar outro com o mesmo nome era recusado por um funil que ninguém conseguia enxergar. Agora a tela de Funis tem uma gaveta "Funis arquivados", fechada por padrão e visível para quem gerencia: de lá dá para tirar o funil do arquivo (ele volta para a lista e recebe negócio outra vez) ou excluí-lo de vez. A exclusão continua valendo só para o funil que nunca recebeu negócio, com formulário ou automação apontando para ele; nos outros casos o sistema recusa explicando, e o funil continua arquivado. A lista de funis do dia a dia e os seletores de destino continuam mostrando só os funis vivos. Você não precisa fazer nada.

  A pedido de @rafaelbatistazz, que mediu o defeito na issue #979 e escreveu os testes que definem o conserto (#988).

- **A DeepSeek entra como empresa de inteligência artificial do atendente** A DeepSeek agora aparece na lista de empresas de IA, junto de Anthropic, OpenAI, Google e
  OpenRouter. Dá para cadastrar a chave em "IA › Credenciais" ou no passo de treinar durante a
  instalação, escolher o modelo na tela do assistente e publicar — o agente atende pela DeepSeek
  do mesmo jeito que atende pelas outras, com ferramentas (cria o lead, move o card) e com a
  mesma conferência de chave ao cadastrar.

  A vantagem dela é o custo: além de ser barata por token, a DeepSeek desconta sozinha o trecho
  repetido da conversa (as instruções do assistente que não mudam), sem você configurar nada. Em
  um atendimento com roteiro fixo isso baixa a conta de entrada sem perder qualidade.

  Os modelos disponíveis vêm prontos no catálogo (`DeepSeek Flash`, para volume, e `DeepSeek V4
  Pro`, para conversas que exigem raciocínio) e a tela escolhe o mais barato que dá conta quando
  você deixa em branco. Nada muda nas instalações que já usam outro provedor: a opção nasce
  disponível, não ligada.

  Contribuição de @deskcommopp4s-cmd (#1275).

- **Um sistema externo pode criar empresas no CRM, se o dono da instalação ligar** Nova rota `POST /api/v1/tenants/provision`: um sistema de fora cria uma empresa no CRM, com a pessoa dona e uma chave de API para operá-la (com permissão de atendente), sem passar pela tela de cadastro. Repetir o pedido para a mesma empresa não cria outra: devolve a mesma empresa e uma chave nova, e a anterior deixa de valer. Se o e-mail da pessoa dona já tem conta nesta instalação, o pedido é recusado e nada é criado — quem quer essa pessoa numa empresa a convida pela tela da empresa (decisão do dono, 19/09). E se um pedido falhar no meio (o banco fora do ar por um instante, por exemplo), basta o sistema de fora repetir: ele retoma de onde parou e conclui o cadastro — a empresa criada **e** a pessoa dona com acesso a ela —, em vez de ficar dizendo para sempre que aquele e-mail já tem conta, ou de responder "está tudo certo" sobre uma empresa em que ninguém consegue entrar.

  Ela vem **desligada**. Só existe quando o dono da instalação define `TENANT_PROVISIONING_SECRET` no `.env`, com 32 caracteres ou mais (`openssl rand -hex 32`), e entrega esse segredo ao sistema que vai criar empresas. Sem ele, nada muda e a rota responde como se não existisse.

  Contribuição de @faxamkt (#1008).

### Corrigido

- **Se alguma peça do banco não voltar depois da atualização, você fica sabendo** A atualização pausa alguns serviços enquanto mexe no banco e os devolve no fim. **Numa instalação real, eles não voltaram** — e a atualização mesmo assim disse "concluída com sucesso". O sistema ficou sem ler nem gravar até alguém perceber.

  O motivo de ninguém ter percebido é o de sempre por aqui: a volta era **muda**. Se falhasse, não sobrava rastro nenhum.

  Agora ela confere peça por peça, tenta uma segunda vez, e — se ainda faltar alguma — **avisa em vermelho, dizendo o nome de cada uma** e o comando para subir à mão.

  E o aviso não toca à toa: quando tudo volta, ele fica calado. Alarme que dispara sem motivo ensina quem opera a ignorar o alarme de verdade.

  *(A causa de as peças não terem voltado naquela vez segue desconhecida. O que este ajuste garante é que uma próxima vez não passe despercebida.)*

  Trabalho de @paulolimajr77, recortado do #803.

- **A atualização confere as regras de acesso do banco antes de dizer que deu certo** A atualização mexe nas regras que separam uma empresa da outra dentro do banco. Se uma delas sumisse no caminho, o sistema voltava dizendo "concluída com sucesso" e as telas apareciam **vazias** — sem erro nenhum, indistinguível de "não há nada aqui". Custou um dia inteiro numa instalação real, com o funil vazio.

  Agora a atualização **confere as regras uma a uma** no fim e diz quantas encontrou. Se faltar alguma, ela **não sobe o sistema** e diz exatamente quais faltam: um sistema fora do ar é um problema visível que se resolve em minutos; um sistema no ar sem essas regras não parece problema nenhum.

  Durante a parte do banco, o sistema fica parado por alguns segundos — é isso que impede a regra de sumir.

  Trabalho de @paulolimajr77, recortado do #803.

- **O aviso de manutenção deixa de cegar a própria atualização** O aviso que aparece durante a atualização assumia a porta **inteira** — inclusive a conversa que o próprio atualizador tem com o sistema para dizer em que passo está. Ele recebia a página de volta, em vez de uma resposta, e ficava mudo justamente na janela que precisa narrar.

  Agora o aviso responde a **pessoa** com a página e a **máquina** com uma resposta curta de "indisponível". A tela de atualização volta a contar o andamento.

  Medido na instalação real antes do conserto: 18 KB de página dentro do registro de erro do atualizador, a cada atualização.

  Trabalho de @paulolimajr77, recortado do #803.

- **A conta que mantém o aviso de tempo funcionando ficou escrita ao lado do número** O aviso que a verificação automática dá quando uma parte dela passa do tempo
  previsto depende de uma folga de poucos segundos para conseguir ser escrito
  antes de a rodada ser encerrada. Essa folga existia e estava correta, mas o
  número que a sustenta só existia numa conversa — então quem ajustasse a margem
  no futuro poderia calar o aviso sem perceber.

  Agora a medição está escrita ao lado da constante, com a conta refeita e o
  limite mínimo declarado.

  Para quem opera um servidor, nada muda: isto acontece inteiramente na esteira de
  verificação do projeto, antes de qualquer versão ser publicada.

  Crédito da medição: @webtecnica (#1056).

- **O aviso de versão nova só aparece quando ela está pronta para instalar** A tela oferecia a versão nova **antes de ela estar pronta para instalar**. O aviso saía assim que a versão era publicada, mas o pacote que a VPS precisa baixar leva mais uns minutos para ficar pronto.

  Quem clicava nessa janela via a atualização parar no meio.

  Agora o sistema **pergunta se há o que baixar** antes de oferecer. E se a VPS estiver sem acesso ao registro, ele **continua oferecendo**: deixar de oferecer para sempre, em silêncio, por causa de um problema de rede seria pior.

  Trabalho de @paulolimajr77, recortado do #803.

## [1.38.0] — 2026-09-19

### Adicionado

- **Quando o atendimento automático trava, sua equipe é avisada no WhatsApp** Até agora, quando a inteligência artificial não conseguia resolver sozinha e precisava
  de alguém, isso só aparecia numa tela do sistema. Quem toca uma empresa não fica com o
  sistema aberto o dia todo — fica com o WhatsApp aberto. O cliente ficava esperando do
  outro lado sem que ninguém tivesse sido avisado.

  Agora dá para escolher um número de WhatsApp da equipe para receber esses avisos. Assim
  que o atendimento trava, chega uma mensagem com o tipo do assunto, o primeiro nome do
  cliente, o que ele precisa, por que a inteligência artificial parou, e um link que abre
  direto o atendimento.

  O aviso sai **na hora**, inclusive fora do horário comercial: o horário de envio existe
  para não incomodar o cliente, e sua equipe não é cliente. O sistema continua respeitando
  o intervalo entre mensagens do mesmo número, que é o que protege o número de ser
  bloqueado pelo WhatsApp.

  A mensagem nunca leva telefone, CPF nem o que o cliente escreveu — só o resumo que a
  inteligência artificial fez. E responder àquele número não chega ao cliente: ele é só da
  equipe. Tudo o que chegar nele é ignorado de propósito, e a tela mostra quantas mensagens
  foram ignoradas para que esse silêncio não pareça defeito.

  Você não precisa fazer nada agora: a atualização já traz tudo pronto, e o aviso só começa
  a sair depois que alguém que administra escolher o número e a conexão.

- **O comportamento da instalação ganha tela no Admin** Quatro decisões que valem para a instalação inteira passam a se tomar na tela **Comportamento** (`/admin/sistema`), em vez de editar arquivo de servidor:

  - **Orçamento de IA** — se a IA respeita o teto que cada empresa escolheu, se só avisa quem opera, ou sem proteção.
  - **Assinatura de webhook** — se toda entrega do canal precisa vir assinada com o segredo da sessão. Ligar exige que o servidor do canal assine: sem isso, a entrada de mensagens para.
  - **Divulgação de pagamento** — se a divulgação entra na primeira mensagem ou se o envio sem ela é bloqueado e devolvido ao modelo.
  - **Conferência de promessa** — se cada envio passa por uma conferência de modelo antes de sair.

  O arquivo de ambiente continua valendo como **piso**: uma instalação que nunca abriu esta tela segue exatamente como estava, e o valor de lá só perde para o que for salvo aqui. Nada muda sozinho depois da atualização — nenhuma destas quatro chaves troca de valor sem alguém salvar na tela.

  Quem não é administrador da instalação não vê a tela, e cada salvamento fica registrado na auditoria com autor e hora.

- **Perguntar à IA sobre um caso antes de decidir** Quando o atendimento automático trava, o sistema abre um caso e chama alguém da equipe. Até
  agora essa pessoa só tinha o que a IA escreveu na abertura: um título, um resumo e o que ficou
  faltando. Se ela quisesse entender mais, tinha de sair do caso, abrir a conversa no Inbox e ler
  tudo de novo — ou decidir sem entender.

  Agora dá para **perguntar**, ali mesmo, para a mesma IA que abriu aquele caso: "por que você
  não resolveu sozinha?", "o que o cliente já tentou?", "ele já pediu isso antes?". Ela lê o
  caso, o que a equipe já decidiu, a conversa com o cliente e a memória do atendimento, e
  responde em português. A conversa fica guardada no caso: quem pegar o caso depois vê o que o
  colega já perguntou, e não refaz as mesmas perguntas.

  Três coisas que valem dizer, porque são escolhas e não acaso:

  - **O cliente não vê nada disso.** A IA aqui só lê: não envia mensagem, não muda o caso, não
    move ninguém no funil. Se você pedir uma ação, ela diz qual botão da tela faz aquilo.
  - **Quem não pode ver a conversa no Inbox também não vê nada aqui.** Se a sua equipe trabalha
    com atendimento separado por pessoa, a regra é a mesma nas duas telas.
  - **Qual modelo responde você escolhe**, em IA › Provedores, no ponto "Conversar sobre o caso
    com a equipe". O gasto aparece em Uso de IA como qualquer outra chamada, e o teto mensal que
    você definiu vale aqui também.

  As perguntas e respostas são apagadas junto com o resto quando um cliente pede para ser
  esquecido, e o próprio sistema limpa as antigas depois de um ano (você pode encurtar esse prazo
  no `.env`, com `CASE_CHAT_RETENTION_DAYS`).

  Você não precisa fazer nada: a atualização já traz tudo pronto.

- **Ao marcar um compromisso, dá para informar o endereço e uma observação** Na tela de novo agendamento passam a existir dois campos opcionais: o endereço (onde aquele horário acontece) e a observação (o que a equipe precisa lembrar). Os dois já existiam no banco e iam para o calendário quando preenchidos; só não havia como preenchê-los na hora de marcar. Quem já instalou não precisa fazer nada — depois de atualizar, os campos aparecem no painel.

- **Uma extensão passa a abrir outras telas além de Tarefas** Até agora, o botão de uma extensão instalada só levava a um lugar: a tela de
  Tarefas. Na prática isso deixava todas as extensões iguais por dentro — o que
  mudava de uma para outra era só o texto.

  Agora o pacote pode apontar para seis telas de trabalho: Tarefas, Conversas,
  Funil, Contatos, Agenda e Radar. Um guia de recepção de clínica leva a pessoa
  para as conversas de quem não remarcou; um de e-commerce leva ao funil na hora
  de mover o negócio parado.

  **O que a extensão continua não podendo fazer, e isso é de propósito:** ela não
  escolhe um endereço. Ela pede uma porta pelo nome, de uma lista fechada, e o
  sistema traduz esse nome no destino. Configuração, chaves de API, provedores de
  IA, webhooks e a área de administração ficam fora da lista — uma extensão
  orienta o trabalho, nunca leva alguém para onde a instalação guarda segredo.

  **O que muda na tela de quem administra:** ao instalar, a lista de portas que a
  extensão vai usar aparece antes de você aceitar. E uma versão nova que peça
  portas diferentes das que a sua organização aceitou é **recusada** — ela não
  passa a abrir telas novas em silêncio numa atualização. Quem precisa de outro
  conjunto publica outra extensão.

  **Se você já tem extensão instalada:** pacotes escritos para a versão anterior
  do formato deixam de ser compatíveis, porque foi o próprio autor que declarou
  até onde garantia o funcionamento. A tela de Extensões mostra o estado de cada
  um; peça ao autor a versão atualizada. Nada é desinstalado sozinho e nenhuma
  configuração é perdida.

- **O lembrete do compromisso aceita texto próprio** Em Tipos de agendamento, cada tipo passou a ter um campo de mensagem para o
  aviso que sai no WhatsApp antes do compromisso. Em branco, continua a frase
  padrão. Dá para usar {{nome}}, {{titulo}}, {{dia}}, {{hora}} e {{endereco}}.

- **Quem abre a conversa vê, ali mesmo, por que a IA passou o atendimento** O sistema já guardava o contexto de cada passagem do atendimento automático para uma pessoa — o
  porquê, o que a IA já tinha tentado, o que o cliente pediu com as palavras dele e se ele chegou a
  ser avisado. Só que ninguém via isso em lugar nenhum.

  Agora vê. Dentro da conversa, logo acima do campo de digitar, aparece um cartão:

  - **Por que a IA passou**, em português, e não um código técnico.
  - **O que o cliente quer** e **as últimas palavras dele**, entre aspas, separadas do que a IA
    concluiu — quem vai responder precisa saber o que foi DITO e o que foi INTERPRETADO.
  - **O que a IA já tentou**, em lista numerada, para ninguém repetir a mesma oferta.
  - **Se o cliente já foi avisado** de que uma pessoa vai assumir. E, quando não foi, por quê — é isso
    que muda a primeira frase que você digita.
  - Um botão **"Assumir e responder"**, que é o mesmo gesto do topo da conversa.

  Três cuidados que valem ser ditos:

  - **Quando o cliente parece ter pedido para parar de receber mensagens**, o cartão muda: ele não
    convida a responder, e sim a abrir a ficha do contato para confirmar o bloqueio. Um botão que diz
    "responder" ali empurraria alguém a escrever justamente para quem pediu silêncio.
  - **Se a conversa já tem dono**, o cartão diz quem está atendendo em vez de oferecer um botão que
    não funcionaria.
  - **Se o cliente pediu para ser esquecido**, o cartão mostra só o aviso de anonimização. Nada do que
    ele disse sobrevive ali.

  **A conversa esquecida volta a pedir.** Antes, se a IA passasse um atendimento e ninguém aparecesse,
  não havia nada no sistema que cobrasse — o cliente esperava indefinidamente. Agora, passado um dia
  sem ninguém assumir, o aviso volta para a Central apontando para a conversa. Ele insiste no máximo
  três vezes: alarme que nunca cala ensina a ignorar o alarme certo.

  **E dá para saber se isso está funcionando.** Em *Métricas*, junto de "Passagens para humano",
  nasceu **"Clientes que repetiram depois da passagem"**: de cada dez passagens em que o cliente voltou
  a falar, quantas ele teve de repetir o que já tinha dito. Se o contexto está chegando a quem assume,
  esse número cai. Se não está, ele não muda — e aí a novidade acima é só enfeite. Quem atende vê o
  número das conversas dele; quem gerencia vê o da organização inteira.

  Você não precisa fazer nada: a atualização já traz tudo pronto.

- **Você pode mandar os e-mails do sistema pelo seu próprio servidor** Convite de equipe, entrega de dados de LGPD e aviso de prazo podem sair pelo seu próprio servidor de e-mail, em vez de depender de um serviço externo contratado à parte. Quem instala numa VPS deixa de precisar abrir conta em outro lugar para mandar o primeiro convite.

  Quem já manda e-mail hoje **não precisa fazer nada**: o caminho anterior continua igual, e nada muda até você decidir preencher a tela nova. Os dois convivem — enquanto a tela de e-mail estiver vazia, a entrega segue pelo serviço que você já usa.

  Para ligar: entre em **Admin › E-mail**, preencha o endereço do servidor, a porta, a segurança, o usuário, a senha e o remetente, e use o botão de testar conexão antes de salvar. A partir daí a entrega passa a sair por ele. A senha é guardada cifrada, e a tela nunca a mostra de volta.

  Quem prefere configurar pelo arquivo do servidor, sem abrir a tela, tem as variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` e `SMTP_FROM_NAME` documentadas no `.env.example` — o que estiver na tela vale acima do arquivo.

  Crédito: @betoarts.

- **O banco ganha as rotinas que fazem uma tabela criada depois da instalação nascer protegida** Preparo para os módulos opcionais com dados próprios (a comanda do financeiro é o primeiro). Até aqui, tabela criada depois que o schema foi aplicado não recebia sozinha as proteções que o schema aplica em lote — ficava sem isolamento entre organizações e alcançável pela chave pública do navegador. Agora essas proteções moram em duas rotinas do próprio banco, e quem cria tabela depois as chama.

  Para quem já roda o CRM: nada muda e nada precisa ser feito. A rotina foi medida contra o schema atual e é uma passagem em branco — as 119 tabelas de organização que existem hoje já estão protegidas, e a foto do banco antes e depois da mudança é idêntica, tirando as duas rotinas novas. Nenhuma tabela nova, nenhuma coluna nova, nenhum dado reescrito, nenhuma variável de ambiente.

- **A tela que liga o aviso no WhatsApp, prova que ele funciona e diz quando ele não vai sair** O aviso no WhatsApp da equipe já existia por dentro, mas só se ligava mexendo no banco.
  Agora ele tem uma tela: **IA › Acompanhar o agente › Aviso no WhatsApp**, para quem
  administra a conta.

  Nela você escolhe por qual número o aviso sai, digita o número da equipe que vai receber,
  dá um apelido a ele ("Plantão da Ana") e liga. E tem um botão **Enviar aviso de teste**
  que manda uma mensagem de verdade naquele instante — se ela chegou, está funcionando; se
  não chegou, a tela diz o motivo em português, sem código nenhum.

  A parte mais útil talvez seja o que a tela diz **antes** de você ligar. Ela avisa quando:

  - você ainda não conectou nenhum número, ou só tem números que não servem para avisar a
    equipe (os oficiais só falam com quem falou com você nas últimas 24 horas);
  - este sistema ainda não tem um endereço na internet — aí o link do aviso não abriria nada,
    e o botão fica travado até quem instalou resolver isso;
  - o número escolhido é o mesmo que fala com seus clientes (funciona, mas um número só para
    avisos é mais seguro);
  - nenhum assistente está autorizado a abrir casos, ou todos eles só sugerem respostas — nos
    dois casos nenhum aviso vai sair, e é melhor saber disso agora;
  - o número ainda está em aquecimento, com o quanto ele já mandou hoje e o limite do dia.

  Embaixo fica a lista dos últimos avisos: quando saiu, para qual número (só os quatro
  últimos dígitos), se foi entregue e, quando não foi, por quê — com um link que abre o
  atendimento. E, quando houver casos suficientes, uma comparação do tempo que a equipe leva
  para agir nos casos em que o aviso chegou e nos que não chegou.

  Uma coisa que a tela diz com essas palavras, para ninguém achar que é defeito: **as respostas mandadas para aquele número são ignoradas de propósito**. Ele é só da equipe.
  A tela mostra quantas já foram ignoradas e quando foi a última.

  Você não precisa fazer nada agora. Nada muda para quem não ligar o aviso.

### Alterado

- **A IA avisa quando uma empresa usa endereço próprio sem a chave dela — e passa a recusar em 19/10/2026** Em Agente de IA › Provedores, quem administra uma empresa pode apontar um ponto de IA para um endereço próprio — um gateway compatível ou um serviço alternativo. Quando essa empresa não tem chave cadastrada e validada para o provedor do ponto, o sistema usa a chave de IA da instalação, a que paga a conta de todas as empresas do servidor, e a envia para esse endereço. Numa instalação com várias empresas, é a chave do dono do servidor saindo para um endereço escolhido por uma delas.

  A partir desta versão, toda vez que isso acontece **abre um aviso crítico na Central** dizendo qual ponto está nessa situação, qual empresa, e o que fazer — e o motivo também aparece na tela de Execuções. **A chamada continua funcionando**: nada para de responder quando você atualiza, e ninguém precisa mexer em configuração nenhuma para instalar esta versão.

  O aviso traz a data em que isso muda: **a partir de 19/10/2026 essas chamadas passam a ser recusadas**, como a leitura de imagens já faz desde a versão 1.29.0. Até lá há tempo de sobra para corrigir, com o aviso apontando exatamente onde.

  Para corrigir, em cada empresa que aparecer no aviso: abra Agente de IA › Provedores e, no ponto indicado, cadastre e valide a chave daquela empresa para o provedor — ou apague o endereço próprio, para o ponto voltar ao provedor padrão da instalação. Empresa sem endereço próprio não percebe diferença nenhuma, e empresa com endereço próprio e chave própria continua funcionando como sempre.

- **Marcar compromisso passa a ter um só campo para escolher o cliente** O painel de novo agendamento tinha um campo para buscar e outro para escolher quem seria atendido. Os dois viraram um: digita, a lista filtra, e dá para escolher — inclusive compromisso sem cliente. Quem já instalou não precisa fazer nada.

- **Ao marcar, o endereço vira uma lista que dá para filtrar e salvar** No painel de novo agendamento o endereço deixa de ser um campo solto: ao digitar, a lista filtra salas e unidades que a equipe já usou, e um endereço novo oferece a opção de salvar para os próximos horários. Os outros campos do painel passam a usar o mesmo bloco e o mesmo tamanho de rótulo. Quem já instalou não precisa fazer nada — depois de atualizar, a lista aparece sozinha.

- **Cada lembrete do compromisso tem o próprio texto** Em Tipos de agendamento, o aviso no WhatsApp deixou de ser um texto só e dois
  horários fixos. Dá para somar quantos lembretes quiser, cada um com a
  antecedência e a mensagem dele.

- **Quem assume uma conversa da IA recebe o contexto — e o aviso se resolve sozinho** O sistema já sabia guardar o contexto de cada passagem do atendimento automático para uma pessoa.
  Agora ele **preenche** esse contexto, em todos os caminhos: quando o cliente pede um atendente,
  quando ele parece pedir para não receber mais mensagens, quando a própria IA decide chamar alguém,
  quando o limite de gasto com IA é atingido, quando alguém da equipe escala um caso, quando o
  sistema detecta irritação na conversa e quando um assistente externo aciona a passagem.

  O que muda, na prática:

  - **Quem assume a conversa lê o porquê, o que a IA já tentou e o que o cliente pediu.**
    Antes o aviso dizia só um código em inglês — e em metade dos caminhos nem isso.
  - **O aviso da Central se fecha sozinho** quando alguém assume a conversa ou a devolve para o
    automático. Antes ele ficava aberto para sempre — e, pior, um aviso aberto impedia o próximo de
    nascer: o cliente pedia um atendente de novo e ninguém era avisado.
  - **"O cliente já foi avisado" passou a ser verdade.** O sistema afirmava isso mesmo quando a
    mensagem não tinha saído (canal fora do ar, número em aquecimento, canal excluído, contato sem
    telefone). Agora ele diz o que aconteceu de verdade, e por quê — que é o que muda a primeira
    frase que a pessoa digita ao abrir a conversa.
  - **O aviso da Central ficou curto.** O resumo da conversa saiu de lá e foi para dentro do próprio
    atendimento: na Central, qualquer pessoa da equipe enxerga os avisos, inclusive quem não tem
    permissão para abrir aquela conversa.
  - **Dois pedidos seguidos não somem mais.** Quando uma segunda passagem acontece na mesma conversa,
    ela vira um acréscimo no aviso que já existe, em vez de ser descartada em silêncio.

  Dois avisos honestos:

  - **O primeiro atendimento depois desta atualização pode custar um pouco mais em IA.** As
    instruções que a IA recebe mudaram, e a economia que reaproveita instruções repetidas recomeça do
    zero uma vez por conta. Depois disso, volta ao normal.
  - **Se você usa um assistente externo pelo MCP**, o campo `original_reason` saiu do registro de
    auditoria. O texto não se perdeu: ele passou para dentro da passagem, onde o pedido de
    esquecimento de um cliente consegue alcançá-lo — no registro de auditoria, não conseguia.

  Você não precisa fazer nada: a atualização já traz tudo pronto.

- **O sistema passa a guardar o contexto de cada passagem para uma pessoa** Quando o atendimento automático para e chama alguém da equipe, o sistema agora **guarda** o que
  aconteceu ali: por que a IA passou, o que ela já tinha tentado, o que o cliente pediu com as
  palavras dele, e se ele chegou a ser avisado de que uma pessoa ia responder.

  Por enquanto isso é só o lugar onde essa informação vai morar — nada muda na sua tela ainda. As
  próximas atualizações mostram esse contexto dentro da conversa, para quem assume não precisar ler
  tudo de novo e o cliente não repetir o que já disse.

  Duas coisas valem dizer desde já, porque são escolhas e não acaso:

  - **Quem não pode ver a conversa também não vê esse contexto.** Se a sua equipe trabalha com
    atendimento separado por pessoa, a regra é a mesma aqui.
  - **Isso é apagado junto com o resto** quando um cliente pede para ser esquecido. E o próprio
    sistema limpa os registros antigos depois de cinco anos — menos os de passagens que
    **ninguém assumiu**, que nunca são apagadas por idade: uma passagem em aberto é alguém ainda
    esperando resposta. Se quiser encurtar esse prazo, é `PASSAGEM_RETENTION_DAYS` no `.env`.

  Você não precisa fazer nada: a atualização já traz tudo pronto.

### Corrigido

- **Apagar os dados de um cliente passa a apagar também o que a IA anotou sobre ele** Quando o atendimento automático trava e chama uma pessoa, o sistema escreve um chamado com o
  que entendeu do problema: o título, o resumo da conversa, o que ficou faltando e um recorte do
  que o cliente falou. Esse texto também vai para o aviso que aparece na sua Central e para o
  assunto do pedido registrado.

  Quando um cliente exercia o direito de ser esquecido, o sistema respondia que tinha apagado
  tudo — e não tinha. Nome, telefone, conversa e mensagens sumiam; o chamado, o histórico de quem
  respondeu, o assunto do pedido e o aviso da Central continuavam lá, com o nome da pessoa
  legível dentro. Nenhum erro aparecia em lugar nenhum: o relatório dizia que estava feito.

  Agora apaga. O que descreve a pessoa é substituído; o que conta a operação continua de pé —
  quantos atendimentos pararam, quando abriram, quem da equipe respondeu e o que foi decidido.
  Sua equipe não perde nenhum número, e o relatório que você entrega ao cliente quando ele pede
  acesso aos dados passa a mostrar esses mesmos registros, que antes ficavam de fora.

  Você não precisa fazer nada. A correção entra sozinha quando você atualiza.

- **Dá para marcar compromisso daqui a dois meses pelo calendário** O painel de marcar só pedia os próximos 30 dias e desligava o mês seguinte quando esses dias acabavam. Quem tentava um horário mais adiante via o calendário travado e o aviso de ocupação do Google daquele recorte. Agora a busca acompanha o mês que está na tela, e a ocupação do Google é conferida nesse mês — a janela de agendamento do tipo continua valendo. Nada para configurar. Crédito: @IanCouto.

- **Quem só acompanha o atendimento não consegue mais escrever o que a IA anotou sobre ele** Quando o atendimento automático trava e chama uma pessoa, o sistema abre um chamado com o que
  a IA entendeu: o título, o resumo da conversa e o que ficou faltando para resolver. É esse
  texto que a sua equipe lê antes de assumir. Ele nascia do robô — mas o banco de dados aceitava
  que qualquer pessoa da sua organização o reescrevesse por fora do sistema, inclusive quem você
  cadastrou apenas como Somente leitura. O mesmo valia para o histórico de quem assumiu cada
  conversa: dava para inserir um registro dizendo que alguém pegou um atendimento que ninguém
  pegou.

  Agora esses três registros só são escritos pelo próprio sistema. Ler continua exatamente como
  era: a tela de chamados, o histórico de quem assumiu a conversa e o que o agente de IA enxerga
  não mudaram em nada. Assumir, transferir e devolver conversa também seguem funcionando igual —
  esses botões nunca escreveram direto no banco, eles pedem ao sistema, e é o sistema que
  registra.

  Você não precisa fazer nada. A correção entra sozinha quando você atualiza.

- **A instalação já termina com os modelos da OpenRouter no seletor do agente** Os modelos dos provedores diretos vêm no banco desde a instalação, mas os da OpenRouter são
  centenas e mudam sozinhos: quem os traz é uma rodada diária do agendador, às 04:15 UTC. Numa
  instalação concluída depois desse horário, quem entrava para criar o primeiro agente encontrava o
  seletor de modelos vazio, com a chave da OpenRouter já cadastrada e funcionando — e só no dia
  seguinte descobria que não era defeito. É a primeira tela que se abre para testar a IA.

  Agora, assim que o app responde que está saudável, o próprio instalador pede essa sincronização uma
  vez. O catálogo já está lá quando a instalação termina.

  Se a openrouter.ai estiver fora do ar naquele minuto, a instalação **continua e termina normal**:
  o instalador avisa na tela que não conseguiu agora e que o agendador tenta de novo às 04:15 UTC.
  Nenhum passo novo, nenhuma variável nova, e quem já tem o CRM instalado não precisa fazer nada —
  para essas instalações o catálogo já veio por uma rodada do agendador.

  Trabalho de @betoarts, recortado do #714.

- **Cliente com e-mail na ficha passa a receber o convite do Google Agenda** Ao marcar um compromisso, o convite do Google ia só para o e-mail digitado no campo de convidado (acompanhante). O e-mail da ficha do cliente não entrava, então ele recebia o lembrete no WhatsApp e não o convite na caixa. Agora o convite vai para os dois — a ficha, quando tem e-mail, e o acompanhante, se houver. Compromissos já marcados ganham o cliente na próxima sincronização. O Google não envia convite para horário que já passou: um compromisso no passado aparece na agenda do atendente, mas ninguém recebe e-mail. Nada para configurar. Crédito: @IanCouto.

- **A verificação de VPS recém-instalada passa a rodar no CI** Nada muda na sua VPS: nenhuma migration, nenhuma variável, nenhuma imagem. O que muda é o que o pipeline mede antes de a release sair — a verificação da instalação fresca (`vps-fresh-onboarding`), que existia e nunca tinha rodado em lugar nenhum, passa a rodar a cada mudança, com WAHA, Redis (a mesma tradução REST do Upstash do `docker-compose.prod.yml`) e um destino HTTP real para Resend e Nuvemshop. O primeiro dono é criado pelo mesmo `scripts/bootstrap-owner.ts` que o `install.sh` roda na sua VPS. Crédito: @webtecnica.

- **Mensagem com horário em formato inesperado não se perde mais** O aviso que o WhatsApp manda ao CRM traz o horário da mensagem, quase sempre em segundos. Quando ele vinha em outra unidade — milissegundos ou nanossegundos, o que acontece quando há um intermediário entre o WhatsApp e o CRM —, o cálculo do horário estourava e o aviso inteiro falhava: a mensagem do cliente não entrava, e nada na tela dizia por quê. Agora a unidade é reconhecida pela ordem de grandeza, e um horário ausente ou sem sentido vira a hora da chegada em vez de derrubar a entrada. Nenhuma mensagem se perde por causa disso.

  Contribuição de @vgamkt (#1130).

## [1.37.0] — 2026-09-19

### Adicionado

- **Endereços da rede interna liberados por quem administra a instalação** Quem administra a instalação agora consegue apontá-la para um serviço que roda na rede do próprio servidor — um Whisper, um gateway compatível com a API da OpenAI — pela tela **Administração › Destinos internos**, declarando o IP ou a faixa. Sem essa declaração nada muda: o sistema continua recusando `localhost`, `10.`, `192.168.` e as demais faixas internas, tanto no texto do endereço quanto no endereço que o nome resolve. A liberação vale só para o que a INSTALAÇÃO configura (hoje, o serviço de transcrição): o endereço que uma empresa escolhe no painel dela continua sem poder apontar para dentro, esteja liberado ou não, e a chave da instalação continua sem poder sair para um endereço escolhido por ela. E ela dispensa só a recusa por endereço interno — `https` em produção e os protocolos aceitos continuam valendo. Quem já tinha a lista no `.env` (`IA_DESTINOS_INTERNOS_PERMITIDOS`) não precisa fazer nada: ela segue valendo como piso enquanto a tela nunca for usada. Quando a recusa acontece, o aviso na Central diz onde se libera.

- **O filtro por marcador do funil enxerga também as "Tags da conversa"** O filtro por marcador do quadro do funil já olhava o marcador do negócio e o da pessoa. Agora olha também as "Tags da conversa", a caixa do painel do Inbox onde a equipe e a IA marcam a conversa: o seletor oferece as três caixas juntas, sem repetir, e filtrar por um marcador de conversa acha o negócio daquele contato. Vale para qualquer conversa do contato, não só a mais recente. A marcação em lote continua gravando no negócio. Decisão do dono, 19/09. Você não precisa fazer nada.

- **O contato que chega por anúncio guarda também o id do anúncio** Quando alguém clica num anúncio "Clique para o WhatsApp", a origem do contato já registrava o clique, o título e o link do anúncio. O id do próprio anúncio, porém, era descartado sempre que o clique vinha junto — o caso comum —, e sobrevivia só dentro do registro bruto da plataforma. Agora ele é gravado num campo próprio, `ad_id`, tanto pelo canal oficial quanto pelo WhatsApp por QR: ele aparece na origem do contato pela API de contatos e acompanha o negócio que nasce da conversa. Vale para quem chegar a partir desta versão: a origem de quem já está cadastrado não é reescrita. Você não precisa fazer nada. Contribuição de @rafaelbatistazz (#1221).

### Corrigido

- **A validação da chave OpenRouter respeita o gateway da instalação** Quem define `OPENROUTER_BASE_URL` para um gateway compatível via a tela de
  Credenciais dizer "chave inválida" para a credencial que o agente já estava
  usando. A validação provava a chave contra `openrouter.ai` fixo, enquanto o
  agente publicado, o turno do worker e a prova de crédito da instalação já
  usavam a base configurada.

  A prova agora é `/key` na base da instalação, com
  `https://openrouter.ai/api/v1` de default quando a variável não existe ou está
  vazia. Quem não define a variável não tem nada a fazer: o endereço continua o
  mesmo.

  Crédito: @webtecnica.

- **A visão de ocupação da agenda deixa de ser apagada e recriada a cada atualização** A `calendar_selected_external_events` — a view que responde "esse horário está ocupado?" para a Agenda — era derrubada e recriada duas vezes a cada passada do baseline, ou seja, a cada `update.sh`: o objeto deixava de existir no meio do caminho e nascia de novo com identidade nova. Agora ela é substituída no lugar, sem trocar de OID, e o `drop` continua existindo para um caso só — o clone que ainda está na forma antiga, a que expunha o título do evento, e que por isso migra na primeira atualização.

  Nada a fazer na instalação: nenhuma tela muda, nenhum dado é tocado. A garantia passa a ser medida a cada versão — `pnpm test:db:update` reaplica o baseline sobre um banco já atualizado e fica vermelho se o OID da view mudar, e monta o clone na forma antiga para conferir que ele ainda migra.

- **A contagem das abas do Inbox volta a mostrar número com um marcador filtrado** O Inbox tem um filtro por marcador, e ele enxerga tanto o marcador do contato
  quanto o da conversa. Com um marcador filtrado, as abas de cima perdiam o
  número: "Todas", "Fechadas" e "Arquivadas" ficavam sem contagem nenhuma, e o
  atendente perdia a referência de quantas conversas havia em cada visão.

  A lista de conversas sempre soube procurar o marcador nas duas caixas onde se
  marca. A contagem das abas pedia outra coisa — igualdade numa coluna de marcador
  que só existe dentro da conversa —, e o banco recusava a consulta inteira. Não
  era um número errado: era nenhum número, em todas as abas, sempre que o filtro
  por marcador estava ligado.

  Agora a contagem pergunta do mesmo jeito que a lista: o marcador vale se estiver
  no contato ou na conversa, e as abas voltam a estampar a contagem certa sob
  qualquer marcador. Sem marcador filtrado, a contagem é a que já era.

  Nada muda para quem opera: nenhuma variável nova, nenhum passo na atualização.

- **A credencial usada por versão antiga explica por que não sai e qual é a saída** Uma chave de IA que só é usada por versões antigas de agentes — as que já foram
  substituídas por uma publicação mais nova — não pode ser excluída: o banco
  guarda o histórico apontando para ela. A tentativa de excluir, porém, ensinava
  um caminho que não existe: "aponte essa versão para outra chave". Versão já
  publicada tem o conteúdo congelado e o próprio banco recusa trocar a chave dela,
  então quem seguia a instrução batia numa parede sem saber o que fazer.

  Agora a recusa diz a verdade. Ela nomeia o agente e a versão onde o uso está,
  avisa que esse uso é congelado e que a chave não sai enquanto o histórico
  existir, e mostra a saída que de fato existe: "Editar credencial". Editar troca a
  chave — ou só o nome dela — na MESMA credencial, então as versões que já apontam
  para ela continuam válidas e o próximo atendimento já sai com a chave nova. Com
  a chave vazada, a recomendação de revogá-la no painel do provedor continua
  valendo, e a exclusão segue disponível para as chaves que ninguém usa.

  O aviso da tela de credenciais foi junto: passar o mouse na chave em uso conta a
  mesma história, em vez de prometer o repontar impossível. A contagem que a tela
  mostra é a mesma que o servidor usa para decidir, nas duas listas.

  Para quem opera, nada muda no banco: nenhuma migração, nenhum ajuste, nada a
  rodar na atualização. O que muda é o que a tela responde quando a exclusão não é
  possível.

- **O marcador do contato é gravado em caixa baixa onde você o escrever** O marcador de contato podia ser gravado em caixa mista. Escrever **VIP** na ficha do contato guardava
  `VIP`; o filtro procurava por `vip` e não achava — o contato marcado não aparecia na lista, sem erro
  nenhum. Pior na hora de tirar: o marcador já gravado em caixa mista não era alcançado por nenhuma
  remoção, e o chip seguia na ficha.

  Agora **a mesma regra normaliza o marcador na escrita e na leitura**, em todos os caminhos onde ele
  entra: a ficha do contato, a importação por CSV, a API e as ações da assistente (MCP). Marcador
  escrito como **VIP**, com espaço nas pontas ou repetido na mesma lista entra como `vip` — uma vez só.
  O filtro passa a encontrar o que foi gravado, e a lista de sugestões para de oferecer a mesma
  etiqueta em duas formas.

  Os marcadores que **já estavam gravados** em caixa mista são ajustados sozinhos na atualização: a
  migration que acompanha este PR normaliza a coluna de marcadores dos contatos existentes e é
  idempotente — rodar de novo não muda nada.

  Nada muda para quem opera: nenhuma variável nova, nenhum passo na atualização, nenhum marcador é
  apagado (o teto de vinte marcadores da importação por CSV continua igual).

- **A aba Atividade deixa de mostrar código no lugar do motivo da parada** Na aba **Atividade**, quando uma ação da automação não era executada, a linha
  podia mostrar um identificador de máquina no lugar do motivo:
  `membro_indeterminado`, por exemplo. Acontecia quando o cadastro do contato não
  dizia quem o atende e a consulta que responderia isso falhava na hora — rede
  fora do ar, banco sem responder. A ação registrava o código, a tela não tinha
  frase para ele, e o que sobrava para quem atendia era o código, sem explicação e
  sem a mensagem do erro, que ficava guardada e não aparecia em lugar nenhum.

  Agora todo motivo que as ações produzem tem frase. Os motivos que apareciam como
  código passam a aparecer em português — em espanhol também, para quem usa o
  produto nesse idioma —, dizendo o que aconteceu e o que fazer a respeito.

  A segunda mudança é o **detalhe técnico**. Quando a ação guarda a mensagem crua
  da falha, ela agora aparece na mesma linha, rotulada como **"Detalhe técnico:"**
  e em corpo menor, DEPOIS da frase. A frase continua sendo a leitura principal; a
  mensagem técnica é o que quem dá suporte leva ao time que cuida do servidor, e
  sem ela não dava para separar "o servidor caiu, tente de novo" de "o cadastro
  está errado, conserte o cadastro".

  Nada muda para quem opera: nenhuma configuração nova, nenhum ajuste na
  atualização. As execuções que já estavam registradas também passam a mostrar a
  frase, porque a tradução acontece na hora de exibir.

  Uma verificação automática passa a vigiar isto: motivo novo que uma ação comece
  a produzir sem frase em português reprova a esteira, apontando o arquivo e a
  linha de quem o emitiu — antes de chegar em quem usa.

- **Motivo de perda fora da lista agora é recusado na hora, com a frase certa, em vez de erro do banco** O banco só aceita, como motivo de perda, os 9 códigos do produto somados ao que o funil tem
  cadastrado em Configurações › Funis — e isso vale inclusive para funil sem cadastro nenhum, que
  é o caso de toda instalação nova. A janela "Marcar como perdido" só conferia o texto digitado em
  "Outro" contra essa lista quando o funil JÁ tinha motivos cadastrados. Sem cadastro, qualquer
  texto passava na tela e era recusado pelo banco no clique, com um erro cru do Postgres
  (`internal_error` / `lost_reason_invalid`) em vez de uma mensagem que dissesse o que fazer.

  **O que muda é QUANDO a recusa acontece, não o que é aceito.** Texto livre continua não sendo
  motivo válido; ele passa a ser barrado na hora, com a frase que diz onde cadastrar um motivo
  novo, em vez de virar erro do banco depois do clique.

  De defesa em profundidade, quem encerra um negócio por `encerraDemanda` — as telas de ganhar e
  perder, a duplicação de negócio, a automação e a capacidade de encerramento da IA — passa a
  traduzir essa mesma recusa do banco em 422 `lost_reason_invalid`, como as rotas de arrasto,
  lote e troca de funil já faziam, em vez de 500 `internal_error`.

- **Reinstalar a versão que falhou deixa de travar a tela de atualização** Quando uma atualização falha e o sistema volta para a versão anterior, a tela de
  Atualização mostra o aviso da falha sem o botão de atualizar. Ela já sabia
  reconhecer que a falha tinha sido superada por uma instalação posterior — mas só
  quando a versão instalada era **outra**.

  Faltava justamente o caso mais comum de dar certo na segunda tentativa:
  reinstalar a **mesma** versão que falhou. Medido numa instalação real: a versão
  nova foi anunciada antes de as imagens dos contêineres ficarem prontas, a
  atualização falhou com "imagem não encontrada" e, meia hora depois, a mesma
  versão instalou sem nenhum problema. A tela continuou anunciando a falha e, sem
  botão, bloqueou a versão seguinte que já havia saído.

  Agora quem desfaz o engano é o próprio sistema em execução: se o aplicativo que
  responde já está rodando a versão que o aviso diz ter falhado, o aviso sai e o
  botão volta. Numa falha de verdade, em que o sistema voltou mesmo para a versão
  anterior, o aviso continua aparecendo como antes, com o comando para retornar.

## [1.36.0] — 2026-09-19

### Adicionado

- **A mensagem que a automação manda tem número próprio no painel** O painel de atrito passa a separar o que o AGENTE escreveu do que a AUTOMAÇÃO enviou. Regra de automação, texto fixo do follow-up e lembrete de agenda aparecem num número novo — "Mensagens enviadas por automação" —, e a conversa nomeia essas mensagens como "Automação" em vez de "IA".

  O número "Mensagens enviadas pelo agente" fica MENOR em quem usa automação, e isso não é regressão: aquelas mensagens nunca foram escritas pela IA, e até agora eram contadas como se fossem. Nenhum número antigo saiu do painel.

  Crédito: @webtecnica.

- **A Central avisa quando um follow-up publicado não está disparando** Um fluxo de follow-up com gatilho automático — silêncio, etapa do funil, atendimento aberto ou
  falta a compromisso — só cria acompanhamento se **algum agente publicado tiver esse fluxo ligado**
  em "follow-ups que arma". Faltando esse vínculo, nada acontecia e nada avisava: o fluxo aparecia
  publicado na tela, com o gatilho configurado, e nenhum contato entrava. Sem erro, sem log, sem
  sinal. Quem publicou achava que tinha ligado o follow-up, e a descoberta vinha semanas depois —
  pela pergunta "por que ninguém recebeu mensagem?".

  Agora a Central de avisos abre um aviso por fluxo nessa situação, dizendo qual fluxo é, quando ele
  dispararia e os três passos que consertam. O aviso **se resolve sozinho** assim que o vínculo com o
  agente existir — ninguém precisa fechá-lo à mão, e ele não fica pedindo algo que já foi feito.

  Fluxos **manuais** e os disparados por **regra em Webhooks** ficam de fora: eles funcionam sem
  agente nenhum, e avisar sobre eles seria alarme falso.

  A verificação roda de hora em hora. Em quem instala pela VPS ela entra junto com a atualização,
  sem nenhuma edição de arquivo — o agendador do kit já vem com ela.

- **A ficha do contato mostra campanha, conjunto, anúncio e posicionamento** A ficha do contato respondia "de onde veio?" com uma palavra só — `site` para quem chegou pelo link do site e o nome da plataforma (`meta_ads`, `google_ads`) para quem clicou num anúncio —, mesmo quando a campanha de origem já estava gravada ao lado. Agora, para quem chegou pelo link do site, a linha **Origem** mostra a fonte da campanha (`utm_source`) e, logo abaixo, aparecem **Campanha**, **Conjunto**, **Anúncio** e **Posicionamento** quando o dado existe. Nível sem valor não aparece.

  No clique em anúncio para o WhatsApp a plataforma não informa o posicionamento de cada clique, e a ficha diz isso ao lado em vez de deixar o campo vazio.

  O editor de regras de automação ganhou os mesmos quatro campos, com as mesmas palavras.

  Nada a fazer na atualização. Crédito: @rafaelbatistazz (#1212).

- **Follow-ups de clínica prontos para instalar — consulta, exame, cirurgia e falta** A tela de Follow-ups tinha o motor inteiro e nenhum fluxo: para ter o primeiro era preciso
  abrir o construtor e desenhar nó por nó — gatilho, espera, ramo, prazo de resposta — e ainda
  escrever as mensagens. Numa clínica recém-instalada isso quase nunca acontecia, e a tela ficava
  vazia embaixo da frase que promete reengajar contato sem ninguém lembrar de mandar mensagem.

  Agora existe **Começar de um modelo**, com as quatro vezes em que um paciente some no meio do
  caminho, cada uma com os textos escritos e o relógio certo:

  - **Consulta** — o paciente perguntou, a conversa parou antes de marcar: três mensagens em dez
    dias, disparadas por um dia de silêncio.
  - **Exame** — saiu o pedido e ninguém marcou: três mensagens em duas semanas, disparadas quando o
    negócio entra na etapa do funil que você escolher.
  - **Cirurgia** — quem foi avaliado está decidindo, não desistiu: quatro mensagens ao longo de
    quase três meses, sem pressionar.
  - **Falta** — a falta foi confirmada na agenda e o horário ficou vago: três mensagens em onze
    dias, a primeira duas horas depois da falta.

  Nos quatro, **responder qualquer coisa encerra o fluxo** e devolve a conversa a quem atende —
  agente ou pessoa. O follow-up existe para o silêncio; quem marca é o atendimento, que tem a
  agenda na mão. E nenhum texto nomeia doença, exame, procedimento ou especialidade: mensagem de
  saúde é lida na tela de bloqueio, às vezes por outra pessoa.

  Instalar **não manda mensagem para ninguém**: o fluxo nasce como rascunho, com o gatilho já
  armado, e abre no construtor para você ler os textos na voz da sua clínica. Para ele passar a
  disparar sozinho faltam dois passos, que a própria tela diz: publicar, e ligar o fluxo no seu
  agente em Agentes › Follow-up.

- **O link do site passa a levar conjunto, anúncio e posicionamento do anúncio** O código de origem que vai no link do WhatsApp agora aceita `utm_adset`, `utm_ad` e `utm_placement`, além da campanha: os quatro níveis que quem opera tráfego lê chegam à origem do contato. Na Meta, basta apontar as macros dinâmicas de conjunto, anúncio e posicionamento para essas chaves na URL do anúncio. Você não precisa fazer nada; quem não usar as chaves novas não vê diferença. Contribuição de @rafaelbatistazz (#1211). Disponível desde a 1.35.1, que saiu sem esta nota.

- **O canal oficial passa a registrar o próprio webhook na Meta** Conectar o canal oficial deixava metade do caminho para o operador: o CRM gravava a credencial validada e o canal ficava ENVIANDO e sem RECEBER até alguém abrir o painel da Meta, colar a URL de callback e marcar os campos — por número, e sem que a tela do CRM dissesse isso em lugar algum. Quem não sabia não via erro nenhum: as respostas do cliente simplesmente não chegavam e a janela de 24 horas nunca abria. Agora, ao conectar, a instalação inscreve o app na WABA e aponta o webhook daquele número para o endereço dela mesma (a inscrição primeiro: sem ela a Meta não entrega nada), guardando o desfecho na sessão — a tela mostra "webhook pendente" com o motivo que a Meta deu e um botão de tentar de novo, sem desconectar e reconectar o canal. Falhar nesse passo NÃO desfaz a conexão: o canal continua enviando, e o que falta é a entrega. O par número/WABA passa a ser conferido junto da credencial (número de uma conta com id de outra gravava uma sessão que envia e cujo webhook nunca chega), e o endereço público da instalação, que era calculado em três rotas com o mesmo código, passa a ter um dono só.

  Crédito: @webtecnica.

- **Conectar WhatsApp por código de pareamento** Conexões e primeiro acesso permitem escolher QR Code ou código de pareamento. O administrador informa o telefone completo e digita no celular o código gerado. O QR continua disponível como alternativa. A conexão só é concluída quando o serviço confirma o aparelho conectado; gerar o código não desconecta sessões ativas.

  Contribuição de @saraivabr (#963).

### Alterado

- **O PDF que responde ao titular passa a ser medido no byte** A resposta ao direito do titular é um arquivo PDF, e nenhum teste olhava o arquivo: as provas existentes conferem o texto extraído e o nome do controlador, que continuam certos mesmo se o motor de renderização mudar o formato do que sai. Agora a suíte mede o próprio byte entregue: o arquivo tem de começar com o cabeçalho `%PDF-` e ter ao menos uma página. Nada muda para quem opera — nenhuma tela, nenhuma rota, nenhum dado. Crédito: @webtecnica.

### Corrigido

- **A senha interna das rotinas que ficou no log do sistema é trocada sozinha** Versões anteriores do instalador escreviam a senha interna das rotinas (`INTERNAL_CRON_SECRET`) dentro da linha do agendamento, e o sistema da VPS gravava essa linha no log a cada minuto (`/var/log/syslog`, arquivos rotacionados e journal). O conserto que parou de gravar (#1054, achado por @rafaeskytrabalho) não desfazia o que já estava lá: a senha velha continuava abrindo as rotas internas para quem lesse esse log.

  Agora a atualização troca essa senha sozinha, uma vez só: gera uma nova, grava no `.env`, reinicia o app e reescreve o agendamento. A senha que ficou no log deixa de valer. Quem atualiza pelo terminal vê a troca no fim da atualização; quem atualiza pelo botão da tela tem a troca feita pelo agente de atualização em até 5 minutos depois (o app reinicia por alguns segundos nesse momento). Nenhum arquivo precisa ser editado. Instalação nova já nasce com senha que nunca foi para o log e não passa pela troca.

  Recomendado, não obrigatório: apagar os logs antigos, onde a senha velha aparece — o comando está no aviso do fim da atualização.

- **Envio de integração por token deixa de aparecer como se fosse da IA** Uma integração que manda mensagem pelo CRM com um token de servidor (o caminho do servidor MCP) tinha o envio registrado como se tivesse saído da IA: o balão da conversa mostrava "IA" e as telas que contam o que a IA falou somavam esse movimento. Na agenda acontecia o mesmo com o compromisso marcado por token, que nascia como "Marcado pelo atendente de IA". Nos dois casos, o dado afirmava uma autoria que não existia.

  A partir desta versão, quem envia por token é registrado como o SISTEMA, separado da IA: o balão passa a dizer "Sistema", o compromisso passa a dizer "Marcado pelo sistema", e as contagens de IA deixam de incluir esse envio. Nada muda para quem responde pelo WhatsApp do celular nem para quem digita no CRM.

  Não há nada a fazer na atualização. As linhas já gravadas ficam exatamente como estão — não há reescrita de histórico — e só os envios novos recebem o rótulo certo. Envios de automação continuam registrados como antes: movê-los junto mexe na mesma leitura e é decisão de produto à parte.

  Contribuição de @webtecnica.

- **A busca do agente que não acha nada para de contar como sucesso** A busca de produtos do agente que não encontrava nada **terminava bem** e era auditada como sucesso: o painel de capacidades (`fn_agent_tool_usage`) mostrava "nenhuma falha" enquanto o agente respondia "não temos" para todo cliente — o defeito era invisível justamente para quem precisava vê-lo (issue #484). O número não mentia: ele não existia.

  Agora a tool **declara** o vazio que não é sucesso (`motivoDoVazio`) e a auditoria grava a chamada como falha, com o motivo — `nao_encontrado`, `sem_estoque` ou `varredura_parcial`, que são vazios diferentes e passam a ser contáveis um por um. Quem acha continua sucesso, e vazio que é **resposta** (um contato sem pedidos, uma agenda sem compromissos na janela) continua sucesso: só o vazio declarado pela própria tool muda de lado, para o conserto não virar alarme geral.

- **O construtor de fluxos deixa de ampliar a tela para 200% no primeiro nó** Num fluxo novo, ainda vazio, o primeiro nó adicionado fazia a tela saltar para o zoom máximo (200%): o enquadramento automático, que existe para mostrar o fluxo inteiro ao abrir, ficava guardado para quando aparecesse o primeiro nó — e enquadrar um nó só é ampliá-lo. Os nós seguintes nasciam fora da vista. Agora o enquadramento vale só para quem abre um fluxo que já tem nós; o fluxo vazio fica no zoom normal. Nada muda para quem opera a VPS.

- **O Despausar do menu da lista volta a funcionar para os agentes-molde** No menu de ações de cada linha da lista de agentes, o item Despausar nascia
  bloqueado para os agentes do tipo mcp_agent — que são justamente os
  agentes-molde criados com a instalação (Atendimento, Agendamento, Financeiro).
  O Pausar logo abaixo não tinha essa trava, então quem pausava um desses agentes
  ficava sem nenhuma forma de despausar pela lista: o item aparecia apagado, sem
  aviso e sem explicação, e a única saída era abrir a página do agente.

  Agora as duas ações se comportam igual. Continua bloqueado só o que faz sentido
  bloquear: agente arquivado (nem pausa, nem despausa) e agente sem versão
  publicada — este último clicável de propósito, para que a tentativa diga em
  português o motivo, que é concluir a configuração e publicar uma versão.
  Nenhuma permissão, nenhum dado e nenhum fluxo de conversa mudam com isso.

- **O filtro por marcador do funil enxerga também o marcador do contato** O produto tem mais de uma caixa de marcador, e duas delas importam para o
  funil. Uma é o marcador do negócio, o campo de texto dentro de "Editar lead". A
  outra é o marcador da pessoa, o que você escreve em "Tags do contato" no Inbox e
  na ficha do contato — o mesmo que a campanha lê, e o que a maioria usa no dia a
  dia.

  O filtro do funil só enxergava o primeiro. Quem marcava o cliente e depois
  tentava filtrar o quadro por esse marcador não achava o card, e o seletor nem
  oferecia a opção: ele montava a lista da mesma fonte, então só aparecia o que
  alguém tivesse digitado dentro de algum card. Quadros inteiros ficavam com uma
  ou duas etiquetas no seletor, nenhuma delas a que se usava.

  Agora o quadro traz os marcadores do contato junto dos cards, o seletor lista as
  duas caixas juntas, sem repetir, e filtrar por qualquer uma acha o negócio.

  Nada deixa de funcionar: o marcador escrito dentro do card continua filtrável
  como antes. As "Tags da conversa", a terceira caixa do Inbox, seguem fora do
  filtro do funil. Negócio sem contato — criado à mão ou por webhook — continua
  aparecendo normalmente. Nenhuma variável nova, nenhum passo na atualização.

- **O agente passa a saber os DOIS passos da agenda — e não promete mais checar sem checar** Um agente com as capacidades de agenda ligadas ("Ver o que a empresa atende", "Ver horários livres na agenda", "Marcar consulta ou sessão") respondia ao cliente com "vou verificar/organizar seu atendimento" e nunca consultava a agenda: o cliente ficava sem horário e sem resposta. Eram dois buracos, e os dois estão fechados.

  **1. O primeiro passo não era ensinado.** Falar de horário real exige duas coisas: o TIPO de atendimento (o `slug`) e os horários daquele tipo — e o segundo passo precisa do `slug` que o primeiro devolve. O bloco de instruções que o agente recebe nomeava `crm_find_free_slots` em toda frase e `crm_list_event_types` em nenhuma: a cadeia existia só na descrição da própria ferramenta, que o modelo lê por último e sem peso de instrução. Agora o agente que tem as duas ferramentas recebe também a instrução dos dois passos, dizendo que a lista não é a resposta e que o `slug` sai dela — e que inventar um `slug` não vale.

  **2. A trava não reconhecia a promessa.** Havia uma trava determinística para isto — a mensagem que promete uma checagem só sai depois que a ferramenta foi de fato chamada —, mas ela reconhecia a promessa apenas quando o texto dizia "horário", "agenda", "disponibilidade", "agendamento", "marcação", "encaixe" ou "vaga". Duas palavras ficavam de fora, e é justamente por elas que o caso escapava:

  - **o nome do serviço**: "atendimento", "consulta" e "sessão" são o que a própria tela chama de serviço na hora de agendar;
  - **o verbo "organizar"**: prometer "organizar o atendimento" é a mesma promessa vazia de "verificar o atendimento", dita de outro jeito.

  Com a trava enxergando essas frases, o agente que promete olhar a agenda é obrigado a consultá-la no mesmo turno — e responde com os horários reais (ou explica o que impediu), em vez de deixar o cliente esperando. Conversa comum que só menciona o atendimento ("o atendimento de vocês é ótimo") continua passando normalmente.

- **A guarda da release confere a identidade do PR de origem, e não o nome do autor do commit** O passo que decide se um push para a `main` corta tag de release conferia o NOME de autor do commit — campo de texto que quem commita escolhe, e que era um literal dentro do próprio `release.yml`. Agora ele pergunta à API do GitHub quem abriu o PR de origem daquele merge, e só corta a tag quando o PR foi aberto pelo bot do App da release ou quando o head do PR é um branch `release/*` do repositório de cima, que é o caminho por onde um corte legítimo passa. Um commit que se apresente com o nome do bot num PR de outra pessoa passa a ser recusado, e o passo da guarda fica vermelho em vez de criar a tag em silêncio. A contagem de fragmentos apagados também passou a pedir `--find-renames`, para que renomear um fragmento não seja lido como fragmento consumido. Nada muda na operação de quem já roda o DeskcommCRM numa VPS.

- **Repetir a mesma criação pela API não cria o registro duas vezes** Quem integra com a API e manda o cabeçalho `Idempotency-Key` ao criar um modelo de mensagem (`POST /api/v1/message-templates`) tinha duas falhas. Repetir o mesmo pedido devolvia 409 `idempotency_conflict` em vez da resposta gravada, porque o resumo do pedido era gravado num formato que a comparação nunca reconhecia. E dois pedidos iguais chegando ao MESMO tempo criavam o modelo duas vezes. Agora a chave é reservada antes da criação: a repetição devolve a resposta original, e o pedido simultâneo recebe 409 `idempotency_in_progress`, que pode ser repetido em instantes. Se a criação falhar, a chave é liberada na hora e a nova tentativa executa normalmente.

  O `update.sh` aplica a mudança de banco sozinho (migration 0321), inclusive em quem já tinha a tabela. O operador não precisa fazer nada, e a tela não muda. Diagnóstico e desenho de @webtecnica (PR #1189, issue #778).

- **O filtro por marcador do Inbox procura nas duas caixas onde você marca** O Inbox tem duas caixas de marcadores no mesmo painel: a do contato — a mesma
  da ficha e a mesma que a campanha lê — e a da conversa, onde o atendimento
  automático também encosta os próprios marcadores. O filtro da lista de
  conversas procurava só na caixa da conversa.

  O efeito era marcar um cliente, filtrar por esse marcador e receber "nenhuma
  conversa". Sem erro, sem aviso — a leitura natural é que o CRM perdeu o
  marcador. E a lista de opções do filtro sofria do mesmo desencontro: oferecia
  só os marcadores da conversa, então o que você acabara de escrever no contato
  nem aparecia para ser escolhido.

  Agora o filtro encontra a conversa quando o marcador está em qualquer uma das
  duas caixas, e a lista de opções junta os marcadores das duas, sem repetir.
  Quem já filtrava por marcador de conversa continua achando o mesmo. Sem
  marcador filtrado, a lista é a mesma de antes.

  Nada muda para quem opera: nenhuma variável nova, nenhum passo na atualização.
  A atualização aplica sozinha a função nova do banco que o filtro usa.

- **A Central avisa quando o processamento rápido de eventos cai para o cron de segurança** Quando o laço rápido do `event_log` não consegue carregar no worker, a instalação deixa de esconder a degradação só no log do contêiner. A Central passa a mostrar um aviso por organização explicando que o cron de segurança continua processando a fila, mas com atraso maior; o aviso é resolvido automaticamente quando o laço volta a carregar.

- **O marcador novo posto numa conversa aparece na hora no filtro do Inbox** Ao criar um marcador novo em "Tags da conversa", ele só aparecia no filtro por marcador do Inbox e nas sugestões depois de até cinco minutos, ou recarregando a página: a lista de marcadores ficava guardada e ninguém mandava relê-la. Agora gravar o marcador manda reler a lista, como o lado do contato já fazia. Nada muda para quem opera a instalação.

- **A nota de voz gravada no Chrome chega no canal oficial** Quem gravava uma nota de voz no CRM pelo Chrome — no computador ou no celular — via o envio dar certo na tela, e o cliente recebia uma mensagem de áudio que não toca: o WhatsApp dele dizia que o áudio não estava mais disponível. No Firefox a mesma gravação sempre funcionou, e é essa diferença que explica o defeito ter durado: o Firefox grava direto no formato de destino e não passava pelo trecho com o erro.

  O CRM converte a gravação do Chrome para o formato que o WhatsApp aceita, e a conversão estava certa — o arquivo saía como Ogg com Opus. O que estava errado era a etiqueta gravada junto: `audio/ogg`, sem dizer o codec. O canal oficial não aceita `audio/ogg` genérico para nota de voz, e o áudio chegava ao cliente sem tocar. Agora a etiqueta sai completa, com o codec, e é a mesma que o navegador usa quando ele próprio sabe gravar nesse formato.

  Duas coisas que valem saber: notas de voz enviadas antes desta correção continuam quebradas para quem as recebeu — é preciso gravar de novo. E, quando a plataforma recusa a entrega e avisa o CRM, a mensagem aparece como falha, mas ainda sem o motivo; se ela aceita um áudio que depois não toca, o CRM não tem como saber, e a mensagem fica como enviada.

  Contribuição de @rafaelbatistazz (#1187).

- **O radar de risco parava de avaliar a empresa inteira quando um negócio tinha compromisso na agenda** O radar que avalia quais negócios estão esfriando **parava de avaliar a empresa inteira** quando encontrava um único negócio em estado inesperado. Todos os outros ficavam sem avaliação, e ninguém era avisado.

  Agora um negócio problemático é registrado e a rodada **segue para os demais**. No fim, o registro diz quantos falharam — então o problema aparece em vez de se esconder atrás de uma lista vazia.

  A causa era uma data: para negócio com compromisso adiado ou com presença vencida na agenda, o radar calculava "neste estado desde" com uma data **no futuro**, e o banco recusava a gravação. Agora essa data nunca passa do momento da avaliação.

- **A IA escolhida no onboarding passa a valer para a empresa inteira** Quem escolhia um provedor no passo "Configurar IA" do onboarding e colava a chave dele ficava com a escolha valendo só para o atendente que nascia ali, e o atendente nascia como rascunho pedindo uma chave de outro provedor. A prova de crédito da própria tela piorava a impressão: ela procurava a chave no provedor da empresa, e dizia que não conseguia testar o crédito sobre uma chave que funcionava. Agora a escolha daquele passo passa a valer para a empresa inteira, com o provedor e o modelo do catálogo dele gravados juntos — um não serve sem o outro. Quando a lista de modelos do provedor escolhido ainda não chegou nesta instalação, a IA da empresa continua a anterior e a tela diz por quê; a chave fica guardada do mesmo jeito, e não é preciso colá-la de novo. Trocar a IA de um atendente continua possível, depois, no editor dele.

- **PDF sem texto deixa de virar "falha de infraestrutura" quando a frase do erro mudar** A leitura de PDF distingue dois casos: o arquivo que abriu inteiro e não tem letra selecionável (é conteúdo, não defeito) e a falha de verdade ao ler. Até agora essa distinção era feita comparando a FRASE do erro, em inglês. Passa a ser feita por um motivo próprio, que não muda quando alguém traduzir ou reescrever a mensagem — e alguém vai traduzir, porque essa frase chega a quem usa.

  Sem isso, no dia em que a frase mudasse, todo PDF escaneado passaria a ser registrado como falha de infraestrutura, enchendo o log de alarme falso e escondendo a falha real no meio.

  Nada a fazer na instalação.

- **Os testes do kit param de trocar o autor dos commits de quem os roda** Cinco testes de shell (`pnpm test:shell`) montam repositórios git descartáveis e gravavam neles uma identidade de mentira com `git -C <pasta> config user.*`. Só que o git grava onde ele *resolve* o repositório, e isso não é necessariamente a pasta pedida. Um `GIT_DIR` herdado, por exemplo quando a suíte roda de dentro de um hook, passa por cima do `-C`, e uma pasta que não é repositório sobe até o repositório de cima. Em 10/09/2026 isso deixou `Pessoa <alguem@fork.dev>` no `.git/config` de um checkout de desenvolvimento, e essa identidade assinou 829 dos 987 commits (sem merge) que entraram na `main` até 18/09.

  Agora cada um desses testes zera o ambiente do git herdado e dá a identidade de commit por variável de ambiente. Onde o próprio config é o dado sob teste, a escrita vai direto no arquivo de config do clone, sem resolver repositório. Uma guarda estática (`tests/unit/testes-de-shell-nao-vazam-identidade.test.ts`) reprova a volta de qualquer uma das duas formas. Nada muda para quem opera uma instalação.

- **A instalação que escolheu OpenAI deixa de ouvir que falta chave de IA** Se a instalação escolheu **OpenAI** como provedor e guardou a chave em `OPENAI_API_KEY`, o boot anunciava `[env] Nenhuma chave de IA configurada` — uma lista que não contava a chave que o produto usa — e a escada de chave usada pelos processos de fundo não sabia de qual provedor era a chave da instalação quando o modelo vinha sem o prefixo do provedor (o id do catálogo, como `gpt-5.6-terra`). Agora o aviso conta a chave da OpenAI e o degrau resolve o modelo no provedor que a organização escolheu.

  Nada muda para quem opera: nenhuma variável nova, nenhum ajuste, nenhum passo na atualização. Quem cadastra a chave pela tela (IA › Credenciais) já era atendido e segue igual. O agente publicado já respondia por essa chave; este conserto não muda o atendimento dele. Crédito: @webtecnica.

## [1.35.1] — 2026-09-18

### Alterado

- **O campo "Motivos de perda extras" sai de Configurações › Organização** Havia dois lugares para cadastrar motivo de perda, com nomes quase iguais. Um
  funciona: **Etapas do funil**, o campo "Motivos de perda (separados por
  vírgula)" — é ele que a janela de perder oferece e é ele que o banco aceita. O
  outro, em **Organização**, prometia "adicionados ao set padrão" e não era lido
  por ninguém: nem pela janela, nem pela validação que decide se o motivo passa.

  O efeito era pior do que não ter o campo. Quem cadastrava ali não via os motivos
  na hora de marcar um negócio como perdido, escrevia o motivo à mão em "Outro" e
  recebia um erro genérico — o banco recusava um texto que a tela dizia ter
  aceitado, e nada na interface ligava uma coisa à outra.

  O campo saiu da aba Organização. Motivo de perda continua se cadastrando em
  **Etapas do funil**, por funil, que é onde o relatório de perdas agrupa.

  Nada some do banco: o que já estava gravado fica na linha, apenas sem tela. Se
  você tinha motivos cadastrados só ali, eles nunca chegaram a valer — recadastre
  no funil para passarem a aparecer na janela de perder.

### Corrigido

- **A catraca do espanhol passa a cobrar a chave que vem de tabela de outro módulo** O teste que garante que toda frase de tela tem espanhol resolvia a chave quando a tabela de rótulos era declarada no MESMO arquivo. Quando a tabela morava noutro módulo — o caso de `TRIGGER_LABELS` e `ACTION_LABELS` (rótulos do construtor de fluxo), `SEVERITY_LABEL` (inbox da IA) e `ROTULO_DO_PAPEL` (convite de equipe) —, a chamada passava batida e ninguém era avisado. Agora a catraca atravessa o `import` e cobra cada valor possível da tabela no dicionário, nas áreas de produto, `lib/` inclusive.

  Medido na `main` de 18/08/2026: 103 chamadas resolvidas, 196 valores exigidos do dicionário e 9 valores faltando, em 3 arquivos. Esses 9 ficam numa lista de dívida congelada dentro do próprio teste: a lista só encolhe, e traduzir um deles deixa o teste vermelho pedindo a remoção da linha. O que o `t()` recebe de dado de runtime — identificador solto, `algo.campo` — segue fora do alcance de propósito: cobrar isso é o passo seguinte da mesma issue. Nada muda na tela de quem opera.

- **A cerca de `organizations` resolve o tipo do cliente admin que mora em outro arquivo** O gate que garante que toda escrita em `organizations` passa pelo cliente admin reconhecia o cliente injetado por parâmetro só quando o TIPO estava escrito no próprio arquivo — ou num `type` local. Três formas que o `tsc` aceita ficavam vermelhas com a escrita certa: o alias importado de outro módulo (`import type { Admin } from "@/lib/waha/ingest"`, que já é exportado no repositório), o membro que chega por `extends` de uma interface, e o cliente que uma função passa para outra dentro do mesmo arquivo, sem anotação no receptor.

  Agora o resolvedor atravessa o `import` até o módulo que declara o tipo — dois arquivos, o que usa e o que declara — e segue a herança até a base. A passagem entre funções passou a ser provada pela CHAMADA: o parâmetro sem anotação de uma função local não exportada é aceito quando todas as chamadas visíveis a ele entregam um cliente admin. Todas, não uma: uma chamada correta com outra entregando o cliente de sessão mantém o vermelho, e função exportada continua fora do alcance, porque pode ser chamada de um arquivo que a varredura não vê.

  Nada muda para quem opera: nenhum arquivo do repositório muda de veredito (a cerca já estava verde) e o que autoriza continua sendo o tipo, nunca o nome. O que muda é o atrito de quem escreve certo.

- **O follow-up espera a janela abrir sem desistir do contato** Quando um passo de mensagem caía fora do horário permitido de envio — a noite,
  o domingo fechado, ou a faixa de horário que você escolheu —, o acompanhamento
  já reagendava a mensagem corretamente para a próxima abertura. O problema era o
  outro lado: o motor do fluxo não ficava sabendo do adiamento, continuava
  perguntando "essa mensagem já saiu?" e, depois de cerca de onze horas
  perguntando, desistia do contato. Na tela aparecia o aviso
  **"Um fluxo de follow-up parou de tentar"**, e o motivo registrado dizia que a
  mensagem nunca tinha sido concluída — o que era falso: ela estava só esperando
  o horário que você mesmo configurou. Uma janela que fechasse no sábado à noite
  e só reabrisse na segunda já passava desse limite.

  Agora o passo diz que está esperando, e diz até quando. O motor guarda o
  contato parado até a hora da abertura em vez de gastar tentativas, o dossiê do
  acompanhamento mostra a linha
  **"Segurou o envio até o horário permitido"** com a data, e a desistência
  automática continua existindo para o que ela sempre serviu: um envio que de
  fato travou, sem sinal de vida nenhum.

  Nada muda para quem opera: nenhuma variável nova, nenhum ajuste, nenhum passo
  na atualização. Contatos que já tinham sido dados como perdidos por esse motivo
  não voltam sozinhos — o conserto vale dos próximos em diante.

- **Quem baixa o projeto para usar ou estudar deixa de receber um erro que não é dele** Quem faz uma cópia do projeto (um "fork") para estudar, testar ou contribuir
  recebia um erro vermelho na verificação automática logo na primeira vez que a
  rodava — e o erro não tinha nada a ver com o que a pessoa tinha feito. Ele
  existia porque o projeto confere se as imagens de instalação pertencem ao dono
  certo, e numa cópia esse dono é outro por definição.

  Agora a conferência entende quando está rodando dentro de uma cópia e não cobra
  nada ali, dizendo por escrito que aquele caso não foi medido — em vez de dizer
  que passou, que seria mentira, ou que falhou, que era o problema.

  Contra o projeto original a conferência continua exatamente como era: se alguém
  tentar trocar o dono das imagens num pedido de alteração, o erro aparece.

  Para quem já opera um servidor, nada muda: isto acontece inteiramente na esteira
  de verificação, antes de qualquer versão ser publicada.

- **O envio de vendas para o Google Ads volta a funcionar, e o botão só aparece quando a instalação está pronta** A versão 1.35.0 trouxe o envio de conversões para o Google Ads falando uma versão da API que o Google já tinha desativado (v17). Toda venda voltava recusada, sem nova tentativa, e a tela de Conversões mostrava a página de erro do Google no lugar do motivo. Agora o envio usa a v25, que o Google mantém até agosto de 2027. A versão fica num lugar só do código, e um teste impede que ela volte a ficar abaixo das que o Google ainda mantém. Quando o Google responder algo fora do formato de erro dele, a tela mostra um motivo legível, com a pista de que a versão pode ter saído do ar.

  A 1.35.0 também dizia que, sem as credenciais do Google Ads no `.env`, o botão "Conectar com Google" não aparecia — e ele aparecia. Agora é verdade: sem `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_OAUTH_CLIENT_ID` e `GOOGLE_ADS_OAUTH_CLIENT_SECRET`, o cartão do Google Ads diz que o envio ainda não está disponível nesta instalação e lista, pelo nome, quais variáveis faltam. Quem já tem as três configuradas não precisa fazer nada.

- **A guarda de primeira mensagem da origem de site passa a filtrar a organização** A origem da página só é gravada quando aquela é a PRIMEIRA mensagem do contato. A consulta que responde isso sai pelo client administrativo — o que passa por cima do isolamento entre organizações que o banco aplica sozinho — e ela não filtrava a organização: filtrava o contato e a direção, e só. A resposta era sobre o contato no banco inteiro, não sobre o contato desta organização.

  O filtro passou a vir do chamador, com a organização de quem recebeu o webhook — nunca do corpo da requisição. Medido no `tests/unit/origem-do-site.test.ts` em 18/09/2026: 25 testes verdes; removida apenas a linha do filtro, 2 ficam vermelhos, e o caso de duas organizações responde `false` porque a mensagem de entrada mais antiga daquele contato vinha de fora da fronteira. Nada muda na tela de quem opera: o `contact_id` é uuid e não colide entre organizações, então o resultado de hoje já era o certo. O que muda é a consulta deixar de depender disso.

- **Erros de leitura do acervo respeitam o idioma da interface** Mensagens de falha ao ler arquivos do acervo agora usam chaves estáveis de interface, impedindo que detalhes técnicos façam a tradução cair silenciosamente em português. Crédito: @joaopaulomirandamatias.

- **O gateway configurado em OPENROUTER_BASE_URL vale também para o agente** Quem aponta `OPENROUTER_BASE_URL` para um gateway compatível com a OpenRouter via os pontos do painel funcionarem, mas o agente publicado não: o botão "Sugerir resposta" e o turno do agente mandavam a chave para `openrouter.ai` e morriam com "Missing Authentication header". Agora seguem a variável o agente no app, o turno do agente no worker, a credencial da organização sem endereço preenchido no painel e a prova de crédito da instalação; sem ela, nada muda. A validação da chave na tela de Credenciais ainda consulta `openrouter.ai`. Crédito: @rogercampel.

- **O sinal de presença deixa de poder encher o registro de auditoria** O sinal de presença do atendente, que saiu na 1.34.0, faz uma batida por aba a cada 60 segundos. Agora só a PRIMEIRA batida de cada pessoa deixa uma entrada no registro de auditoria — que é a que cria a linha e acorda o roteamento, o único efeito que outra pessoa sente. As batidas seguintes não registram nada, pela mesma régua que já vale para a rodada de cron que não fez nada: audita-se quando houve efeito, nunca se deixa de auditar por comodidade.

  Sem isso, uma instalação com oito atendentes de plantão somaria cerca de 3.800 entradas de auditoria por turno de oito horas, sem que ninguém tivesse feito nada — e o registro de auditoria é onde se procura quem fez o quê quando algo dá errado.

  Nada a fazer na instalação: o comportamento muda sozinho na atualização, e nenhuma entrada já gravada é tocada.

- **A prova de sincronia do kit para de acusar chave inocente sob carga** A prova de sincronia do `hostgator-setup-kit/test-validators.sh` confere se toda chave prometida no `.env.hostgator.example` é gravada pelo `install.sh`. Sob máquina saturada, ela às vezes acusava uma ou duas chaves que o `install.sh` grava, e a cada rodada eram chaves diferentes, sobre os mesmos arquivos.

  A causa era a checagem por chave. Cada chave era conferida por um `printf | grep -qx` próprio, ou seja, um processo por chave, e qualquer falha desse processo era lida como "chave ausente". Agora a pertença é respondida dentro do próprio shell, sem abrir processo, e não tem como falhar sozinha. A assinatura das rodadas registradas na issue #1153 confirma isso: cada uma acusou uma ou duas chaves espalhadas, enquanto uma lista truncada perde a cauda e, para deixar de fora aquelas chaves, teria de acusar de 14 a 54 ao mesmo tempo.

  A lista também é contada duas vezes, desenho de @webtecnica no PR #1207: a lista do pipeline e uma contagem direta no `install.sh`, as duas por chave única. Se divergirem, o resultado é inconclusivo, nunca "chave faltando". Contar por chave única evita outro falso vermelho: um `envq` repetido em dois ramos de um `if` é uma chave só. O piso fixo de 30 chaves saiu. Nada muda para quem instala pelo kit.

- **A verificação automática deixou de dizer "cancelado" quando ela mesma demora** Quando a bateria de verificação automática levava mais tempo que o limite
  configurado, o sistema marcava o resultado como "cancelado" — a mesma palavra
  que aparece quando alguém cancela de propósito. Quem tinha enviado uma
  contribuição lia "cancelaram o meu trabalho", e quem ia conferir saía procurando
  uma pessoa que não existia.

  Agora o limite serve só para matar o que travou de verdade, e quem avisa que a
  bateria engordou é uma mensagem em português que diz o que aconteceu e o que
  fazer — nomeando a parte que passou do previsto.

  Para quem opera um servidor, nada muda: isto acontece inteiramente na esteira de
  verificação do projeto, antes de qualquer versão ser publicada. O que muda é o
  tempo até um conserto chegar até você, porque contribuições boas deixam de ficar
  paradas por um diagnóstico errado.

## [1.35.0] — 2026-09-18

### Adicionado

- **A atualização agora conta se o banco deu disputa** Quando uma atualização termina, a tela passa a contar o que aconteceu com o
  banco: se ele estava em disputa com o sistema no ar, quantas retentativas foram
  necessárias e em qual passada o banco fechou. Se a rodada não passou pelo banco
  — atualização só de código, por exemplo —, a tela não fala do assunto: ela não
  inventa uma passada que ninguém mediu. E uma rodada que NÃO conseguiu fechar o
  banco (a disputa persistiu até o teto de tentativas, ou veio um erro que
  retentativa não cura) também fica em silêncio: a frase existe para dizer que
  fechou, e afirmar fechamento onde não houve seria pior que não dizer nada.

  O efeito para quem opera: uma atualização que precisou de três passadas por
  causa do sistema em uso deixa de parecer idêntica a uma que fechou de primeira,
  e o dono do servidor sabe que o "deu certo" dele veio acompanhado de disputa —
  o que muda o que ele confere depois.

- **CSV agora é um formato aceito no acervo de conhecimento da IA** Antes, o acervo de conhecimento só lia PDF, Markdown e texto puro — uma
  planilha exportada como CSV era recusada com "não sei ler esse tipo de
  arquivo", e Excel (`.xlsx`/`.xls`) continua recusado, mas agora com uma
  mensagem que ensina a exportar como CSV primeiro. Cada linha da planilha vira
  um bloco de busca próprio (`Coluna: valor`), então uma tabela de preços ou uma
  lista de perguntas frequentes em CSV passa a ser pesquisável pelo agente linha
  a linha, sem virar uma tabela ilegível depois de indexada. Crédito: @cabindaferreira.

- **Um acompanhamento pode esperar semanas sem morrer quando o cliente fala** Até agora não dava para montar um acompanhamento de retorno — "volte a falar com
  esta cliente daqui a 28 dias" — dentro de um fluxo. Qualquer espera era
  interrompida assim que o cliente mandasse qualquer mensagem: ou o acompanhamento
  era cancelado, ou o relógio era cortado e a mensagem de retorno saía na hora
  errada. Para uma cliente de manutenção, que conversa com o estúdio várias vezes
  no mês, os dois desfechos estavam errados — e por isso essa regra só existia
  escrita no prompt do agente, onde não dá para editar o prazo, ver quem está
  esperando nem medir o resultado.

  Agora a espera de um fluxo tem uma opção nova.
  **A resposta do cliente não encurta mais a espera.**
  Ela vale só para esperas de 24 horas ou mais (numa espera curta
  seria um tiro no pé: prenderia alguém no meio da conversa) e o acompanhamento
  fica visível na fila como "Aguardando a data do retorno", com a data em que volta
  a falar. Enquanto ele dorme, o cliente continua podendo entrar em outros
  acompanhamentos — antes, um só já ocupava a vaga dele por todo o período.

  Quem pede silêncio continua sendo respeitado: um "pare de me mandar mensagem"
  cancela também o retorno que estava dormindo.

  Junto vem uma capacidade nova para os agentes de IA,
  **"Iniciar um acompanhamento configurado"**,
  que deixa o agente pôr o cliente num fluxo que você montou na tela. É o que tira do texto do agente as decisões de quando falar, o que dizer
  e quando parar, deixando com ele só o que ele realmente sabe: que o atendimento
  terminou e ainda há motivo para voltar.

  Há um limite conhecido, e ele importa antes de você armar um retorno longo: se o
  atendimento que originou o acompanhamento for encerrado ou substituído durante a
  espera, o envio é cancelado. Isso já acontecia com o retorno agendado pelo agente
  e não é novo — a diferença é que agora **você fica sabendo**: abre um aviso na
  Central dizendo qual fluxo era e que o retorno não saiu. Nada a fazer na VPS além
  de atualizar.

- **Aviso automático N dias antes (ou depois) de uma data do funil** Sua equipe já guardava datas no funil — a data do casamento, o vencimento, o dia da prova — e elas
  não acionavam nada: quem quisesse avisar 240 dias antes teria de olhar negócio por negócio, e no dia
  certo.

  Agora existe uma automação para isso, em **Automações → Nova automação**: escolha "Quando faltarem N
  dias para uma data do funil", diga de qual funil é o campo, qual campo de data e quantos dias antes
  avisar. No dia certo, a regra dispara uma vez por negócio — dá para mandar mensagem no WhatsApp,
  aplicar uma etiqueta, mover o card, o que a automação já fazia.

  O número aceita sinal: `7` avisa sete dias antes da data; `-60` avisa **sessenta dias depois** dela —
  é assim que a confirmação de entrega sai depois do casamento, com a mesma data que já está no
  negócio. O aviso sai às 9h da manhã no fuso da sua empresa, e cada negócio recebe uma vez só por
  regra: mudar a data depois do disparo não faz o aviso voltar — para uma segunda cobrança, crie uma
  regra nova.

  A regra só dispara para negócios do funil e do campo escolhidos, e só nas organizações que a
  configuraram: quem não usa a automação não é varrido nem recebe nada.

- **Envio de conversão de volta pro Google Ads** Até aqui, mesmo com o clique do Google Ads já sendo capturado (versão
  anterior), o sistema não tinha como avisar o Google quando aquele lead virava
  venda de verdade — o anúncio continuava otimizando "pessoa que clicou", nunca
  "pessoa que comprou".

  Agora existe a conexão completa: um botão "Conectar com Google" em
  Configurações › Conversões autoriza a organização, e a partir daí, sempre que
  um negócio vindo do Google Ads é marcado como ganho, o valor da venda é
  reportado de volta para a conta de anúncios — o mesmo laço que já existia para
  a Meta.

  Não muda nada para quem não usa: a conexão precisa ser configurada
  explicitamente (autorizar + informar a conta de anúncios + a ação de
  conversão), e a instalação precisa ter as credenciais do Google Ads
  (`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_OAUTH_CLIENT_ID`,
  `GOOGLE_ADS_OAUTH_CLIENT_SECRET`) configuradas no `.env` — sem elas, o botão
  de conectar simplesmente não aparece.

- **Landing page de captura de clique do Google Ads** Até aqui, uma organização que anunciava no Google Ads não tinha como saber
  quais leads do WhatsApp vieram de qual clique pago — o Google Ads, ao
  contrário da Meta, não tem um "Clique para o WhatsApp" nativo que carregue
  essa informação para dentro da conversa.

  Agora existe uma landing page (`/api/v1/anuncios/google/<organização>`) que
  recebe o clique do anúncio, gera um código curto e redireciona para o
  WhatsApp com esse código já embutido no texto da mensagem. Quando a pessoa
  manda a mensagem, o sistema reconhece o código e carimba o contato com a
  origem do anúncio — o mesmo carimbo que já existe para a Meta.

  Não muda nada para quem já usa o produto: a captura só funciona para a
  organização que configurar seu número de WhatsApp e o texto da mensagem em
  `google_ads_landing_pages` (ainda sem tela própria nesta versão). O passo
  seguinte — reportar a venda de volta para o Google Ads — continua fora do ar,
  porque depende de credenciais da API do Google Ads que a maioria das
  instalações ainda não tem.

- **A conversa que ficou com uma pessoa pode voltar ao agente de IA sozinha, depois de um prazo** Quando alguém assume uma conversa — pelo botão, pela IA passando para humano ou pelo celular —, o agente de IA para de responder nela até ser devolvido. Isso continua sendo a regra. O que muda: em Configurações › Distribuição de atendimento, a organização pode ligar um prazo (de 5 minutos a 24 horas) para devolver a conversa ao agente sozinha quando ninguém da equipe deu mais nenhum sinal — nem assumiu, nem respondeu pela tela ou pelo celular. O tempo conta do último sinal, então um atendimento longo com a pessoa respondendo não é interrompido. A volta acontece pelo mesmo caminho do botão "Devolver": as travas saem, o acompanhamento pausado retoma e a linha do tempo do negócio diz que foi o prazo, e depois de quantos minutos. Só devolve onde há agente publicado para aquele número — devolver para ninguém deixaria a conversa muda. Desligado (o padrão, inclusive para quem já tem o sistema instalado), nada muda: a IA só volta quando alguém clica em Devolver. Motivo: numa instalação real, 12 das 31 conversas ativas de um dia estavam paradas com humano, ninguém devolvia, e o cliente que escrevia de novo ficava sem resposta. Crédito: @Gervanno.

- **Kwanza (Kz) e o fuso de Luanda passam a aparecer nas listas de escolha** Quem opera em Angola não encontrava a própria moeda nem o próprio fuso: em
  Configurações › Organização, a lista de moedas ia só até dólar, peso e real, e
  as listas de fuso horário — da organização, do perfil de cada pessoa, da equipe
  e da janela de envio do WhatsApp — só ofereciam cidades da América do Sul. Sem a
  opção certa, restava deixar o relógio do Brasil e ver o agente respeitar a
  janela de envio três horas fora do lugar. Agora o kwanza aparece na lista de
  moedas (e o valor sai escrito como se escreve lá, `249,90 Kz`) e "Luanda
  (Angola)" aparece em todas as listas de fuso.
  **Nada muda para quem já usa o sistema:** o padrão de quem nunca escolheu
  continua sendo real e São Paulo — o que entrou foi opção, não troca.
  Crédito: @cabindaferreira.

### Alterado

- **A doutrina de chamada de servidor passa a dizer o que o código exige** A documentação interna prometia autenticar chamada de servidor com um token
  começando em `tok_`, e o sistema exige `dsk_`. Quem seguia o texto recebia
  "credencial inválida" sem entender por quê — o prefixo `tok_` não existia em
  nenhuma linha de código.

  Além disso o texto descrevia a autenticação por chave de servidor como se
  valesse em toda a API, quando ela é habilitada rota por rota. Agora o texto diz
  a direção (é assim que o produto quer atender sistema externo, e as rotas vão
  sendo convertidas conforme cada integração precisa) e entrega o comando que
  responde quais rotas já aceitam hoje, em vez de um número que envelhece.

  Nada muda para quem opera uma instalação: não há env nova, nem migration, nem
  comportamento diferente no que já estava no ar.

- **O relatório de acesso deixa de se chamar LGPD quando a lei não é essa** O PDF que responde ao direito de acesso do titular citava a LGPD fixa no
  código. Agora a citação sai do perfil do país da organização — e o documento
  simplesmente **não cita lei** quando o país ainda não tem a citação revisada, em
  vez de citar a de outro.

  No Brasil, nada muda no que você entrega: a citação continua "LGPD Art. 18, II
  (Lei nº 13.709/2018)". O título do arquivo passa a ser "Relatório de Acesso aos
  Dados" — o documento é sobre o direito ao acesso, e o nome da lei é do país. O
  prazo de resposta também passa a ser contado no calendário de feriados do país
  da organização, não no brasileiro fixo.

  Não há ação para quem opera a VPS.

### Corrigido

- **A atualização numa VPS de outra arquitetura se vira sozinha** Numa VPS cuja arquitetura não tem imagem publicada, o registro responde `no matching manifest for linux/arm64/v8`, o `pull` não traz imagem nenhuma e o `up -d` morre junto. O desfecho era o pior possível: o CRM continuava na versão antiga e ninguém era avisado — pelo botão **Atualizar** nem isso, porque o agente roda sozinho no cron e a falha não cabia na tela. Agora, quando o `pull` falha por arquitetura, o kit constrói aqui nesta VPS a MESMA versão alvo (`docker-compose.build.yml`, subindo pelo override com `pull_policy: never` para o Compose não voltar ao registro) e termina dizendo, em português, que as imagens foram construídas aqui nesta VPS e o motivo. Quando a imagem existe para a sua arquitetura, nada muda: nenhum build local, nenhuma ação sua, nenhuma variável, nenhum comando. Crédito: @webtecnica.

- **No construtor de fluxos, a regra de etapa passa a funcionar — e o cartão do passo diz a verdade** No passo "Verificar condição", a etapa do funil era digitada à mão. O sistema
  compara a etapa pelo código interno dela, então a regra "o lead está na etapa
  PAGO" nunca era verdadeira, e ninguém avisava: o fluxo publicava e o contato
  seguia pelo caminho errado. Agora a etapa é escolhida numa lista (com o nome do
  funil junto), o número de passos é um campo numérico, e publicar recusa a regra
  sem valor, a que aponta para etapa que não existe mais e a que ficou arquivada —
  dizendo qual regra corrigir. Um fluxo antigo com a etapa digitada à mão continua
  rodando como está; ao publicar de novo, o sistema pede para escolher a etapa.

  Regras de "passos" também voltam a decidir como foram escritas: a tela antiga
  gravava o número como texto e o sistema nunca dava a regra por verdadeira, então
  "pelo menos 3 passos" mandava todo mundo pelo caminho do "não". Vale a pena
  conferir os fluxos ativos que comparam passos — eles podem passar a seguir por
  outro caminho, que é o que foi pedido quando a regra foi escrita.

  No cartão de cada passo, o texto deixa de ser cortado no meio, o passo de
  classificar nasce com opções em português ("Interessado", "Sem interesse") no
  lugar de "hot"/"cold", "grace 15min" virou "espera 15 min", e a saída de escape
  de um passo que já tem saídas deixa de se chamar "Sempre" — ela só é usada
  quando nenhuma das outras serve, e agora se chama "Outros casos". As linhas
  entre os passos ganharam contraste: no tema claro elas quase sumiam.

- **A agenda de quem atende passa a dizer por que não dá para marcar, e de quem é o horário** A agenda de quem atende abria com um aviso de permissão sem motivo no lugar dos horários: a tela pedia a lista de membros da organização a uma rota que só quem administra pode ler, recebia a recusa e mostrava "Você não tem permissão para esta ação" — sem dizer de que permissão se tratava, nem como pedir. Quem atende agora lê a mesma lista por um caminho próprio, com o papel mínimo de quem atende, e o que essa lista devolve é só o que a barra da agenda usa: nome e se a pessoa tem agenda. E-mail e data do último acesso não saem por ali.

  O horário ocupado no Google da dona da agenda também deixa de aparecer livre para quem atende. A ocupação passa a ser lida por pessoa, e não pelo que a sessão de quem olha tem direito de ver: quem atende recebia apenas a própria ocupação, e desenhava livre o horário em que a dona já estava comprometida. Quando a leitura de uma pessoa falha, o que foi lido das outras continua na tela, e o motivo da falha fica registrado.

  A explicação do bloqueio passou a distinguir os dois casos que a mesma frase cobria. "Ocupado" é quando alguém já está comprometido naquele horário — inclusive no Google; "fora da jornada" é quando aquele horário não faz parte do que a pessoa publicou. O rótulo da coluna só diz "Você" quando o dono da agenda é quem está logado, e o painel do dono não escreve mais "Você" para si mesmo. E um dia de folga dentro da jornada deixou de ser anunciado como "Nenhum horário publicado neste dia", que fazia parecer configuração faltando para quem já tinha publicado jornada: a folga agora se anuncia como folga, e a falta de jornada continua tendo o seu próprio aviso.

  Quem já roda o sistema não precisa fazer nada: nada de configuração mudou, só o que a tela diz e o que ela mostra.

- **O anonimizador cobre os documentos que o Brasil não usa** Quem manda texto de conversa para o modelo tinha dois buracos: o BI angolano
  (`003862011LA042`) e o CPF de nove dígitos (`541712345`) atravessavam o
  anonimizador intactos — medido, antes do conserto, nos dois casos, um depois do
  outro.

  Agora o conjunto de padrões é declarado no perfil do país, o anonimizador e a
  guarda que o confere usam o MESMO conjunto (antes eram duas listas que podiam
  divergir em silêncio), e documento novo entra pelo perfil em vez de virar mais
  um padrão solto no meio dos outros.

  Ninguém precisa fazer nada.

- **Regra de automação transfere o negócio entre funis em vez de abrir um segundo** Quando uma regra de automação aponta para outro funil e o contato já tinha um negócio aberto no funil antigo, a regra criava um SEGUNDO negócio e deixava o primeiro aberto: o mesmo cliente aparecia duas vezes, um card em cada funil, e ninguém sabia qual dos dois era o de verdade. Agora a regra TRANSFERE: o negócio é levado para o funil da regra com os mesmos dados (título, valor, responsável, campos personalizados e etiquetas) e o do funil antigo é encerrado como perdido, com o registro de para onde foi. Negócio aberto no mesmo funil continua sendo movido de etapa, e contato sem negócio aberto continua ganhando um negócio novo.

  Esse encerramento não conta como perda comercial: "Levado para outro funil" é o motivo próprio da transferência, e as métricas de perdas (a por responsável e a do relatório de atrito) deixam de contá-lo — trocar de funil não é perder o negócio. O motivo de sistema também não aparece na janela "Marcar como perdido": ele continua gravado pela transferência, mas não é oferecido a quem está fechando um negócio à mão — sem isso, um clique tiraria uma perda comercial real do número. A atualização aplica a mudança no banco sozinha: nada precisa ser feito à mão, e negócio encerrado antes dela continua contando como perda.

- **Uma consulta de membro que não volta não acusa mais o responsável de estar fora da organização** Quando uma regra de automação ia atribuir um responsável a um negócio e a
  consulta que confere se aquela pessoa é membro da organização não voltava — rede
  fora, banco fora —, a regra terminava dizendo `user_not_in_org`, como se o
  responsável escolhido tivesse saído da organização. O aviso mandava o operador
  mexer justamente no que estava certo: quem ele havia escolhido para atender.

  Agora a ação separa "não é membro" de "não deu para saber". O responsável que
  realmente não é membro continua sendo recusado do mesmo jeito, com
  `user_not_in_org`. Quando a consulta falha, a execução passa a ser marcada com o
  código `membro_indeterminado`, e a mensagem do erro fica registrada no detalhe da
  execução.

  O que muda para quem opera, hoje: o histórico da regra deixa de acusar a
  configuração. Antes ele dizia que o responsável escolhido estava fora da
  organização, o que mandava mexer justamente no que estava certo. A frase amigável
  para esse caso na aba Atividade ainda não existe — o histórico mostra o código —
  e está sendo tratada à parte.

- **A suíte E2E não deixa conexões de WhatsApp de teste no banco** Ao terminar, o Playwright agora remove as sessões de WhatsApp criadas pelos seeds E2E. Também há um script explícito para limpar resíduos antigos; em banco remoto ele exige `--allow-remote` para evitar exclusão acidental. Crédito: @joaopaulomirandamatias.

- **A Fila para de empurrar para o fim quem insiste — a espera passa a contar da primeira mensagem sem resposta** Na aba Fila, a posição de cada conversa era calculada pela ÚLTIMA mensagem do cliente. O efeito era o inverso do pretendido: quem escrevia de novo — cobrando, perguntando outra vez — reiniciava a própria espera e descia para o fim, atrás de quem escreveu uma vez e ficou quieto. Quem mais estava tentando ser atendido era o último a ser atendido.

  A régua agora é a mensagem do cliente **mais antiga que ninguém respondeu ainda**, e é ela que ordena a lista, que a pílula "Aguardando há…" mostra e que a posição dita no WhatsApp usa. A resposta do atendente continua encerrando a espera: a partir dela, a próxima mensagem do cliente conta do zero, como deve ser.

  Um aviso para quem já tem fila rodando: a atualização preenche a coluna nova das conversas que já existem, usando as mensagens de cada atendimento. Na prática, conversas que estavam no fim da fila porque o cliente insistiu vão subir, e as que estavam no topo podem descer — a ordem passa a refletir quanto tempo cada um espera de fato. Nada precisa ser feito à mão.

- **Instalador volta a pedir consentimento antes de ligar a telemetria** O template self-host não pré-define mais `SENTRY_DSN` vazio antes da primeira execução. Assim, o instalador volta a perguntar pelo envio de relatórios de erro; em modo `--yes`, mantém a telemetria desligada, e uma escolha anterior continua preservada nas reexecuções. Crédito: @joaopaulomirandamatias.

- **O kit explica quando a VPS usa uma arquitetura sem imagem publicada** Instalação e atualização agora recusam ARM64/aarch64 antes de consultar ou baixar as imagens do DeskcommCRM, explicando que as imagens oficiais atuais são `linux/amd64` e orientando usar uma VPS x86_64/amd64. Crédito: @joaopaulomirandamatias.

- **O funil passa a falar a moeda que a empresa escolheu, em vez de real sempre** Em Configurações › Organização dá para escolher a moeda da empresa, e o funil
  ignorava a escolha em dois pontos. O total no topo de cada coluna do quadro
  saía sempre com `R$` na frente — o número estava certo e o símbolo mentia. E
  todo negócio criado pela tela "Novo negócio" nascia em real, mesmo numa empresa
  que opera em peso ou dólar: o valor cadastrado passava a ser exibido na moeda
  errada em toda tela que o mostra. Agora o total sai na moeda dos negócios da
  coluna, e um negócio novo nasce na moeda que a empresa declarou.
  **Nada muda para quem opera em real,** e nenhum negócio já cadastrado tem a
  moeda alterada — o conserto vale para o que nasce daqui em diante. Um detalhe
  visível: o total da coluna passa a mostrar os centavos, porque quem os escondia
  era a mesma linha que escondia a moeda. Crédito: @cabindaferreira.

- **Um PDF recebido no WhatsApp não derruba mais o agente** Um PDF de poucos KB recebido no WhatsApp reiniciava o processo do agente de IA a cada poucos segundos (estouro de memória ao ler o arquivo), e enquanto isso nenhuma conversa era respondida — o mesmo PDF voltava à fila e derrubava de novo, sem limite. Agora a leitura de PDF roda num processo à parte, com teto de memória próprio: um arquivo que não dá para ler vira um erro comum daquela mensagem, o agente segue respondendo, e depois de cinco tentativas a Central de Avisos recebe o aviso. Vale também para qualquer outro processamento que derrube o processo no meio: ele passa a contar como tentativa em vez de voltar à fila para sempre.

- **Erro de PDF no acervo de conhecimento para de acusar o arquivo errado** Toda falha ao ler um PDF no acervo de conhecimento — qualquer uma —
  aparecia como "Se ele for só imagens escaneadas, não há letra nenhuma
  para ler", mesmo quando o PDF tinha texto selecionável e o problema era
  outro (por exemplo, uma dependência nativa ausente na instalação). A
  mensagem específica que `extractPdfText` já produzia para cada causa
  era descartada e trocada por essa frase única em
  `lib/ai/rag/ingest/documento.ts`, então quem enviava um PDF perfeitamente
  legível recebia uma explicação que apontava para o próprio arquivo como
  culpado. Agora a causa relatada é a causa real — e, no caso que motivou o
  conserto (uma peça nativa do leitor de PDF que ficou de fora da imagem), a
  mensagem diz o que quem opera a VPS pode de fato fazer: atualizar a
  instalação e, se não resolver, avisar quem instalou. Antes ela mandava
  reinstalar pacotes, que num servidor com a imagem pronta não é um passo que
  exista. Crédito: @cabindaferreira.

- **O teto de gasto de IA volta a contar quando o agente atende no Claude Sonnet 5** A tela Uso e orçamento mostrava gasto zero em instalações que atendem no Claude Sonnet 5 — o modelo padrão do catálogo —, e o limite mensal nunca disparava, por mais que a conta do provedor subisse. A tabela de preços interna tinha parado na geração 4 dos modelos, e o que ela não conhece é registrado como custo desconhecido, que o teto soma como zero. Agora a geração 5 tem preço, e o gasto aparece e conta. Pelo mesmo motivo, o Claude Opus 4.5 em diante era cobrado ao preço do Opus 4 aposentado, três vezes mais caro, o que fazia o teto disparar antes da hora. Crédito: @maclevison.

## [1.34.0] — 2026-09-18

### Adicionado

- **Dá para abrir um dia de atendimento pela tela, e não só fechar** A tela de agenda sabia tirar dias da agenda — feriado, férias, viagem — e não sabia o
  contrário: **acrescentar** um dia que a jornada semanal não cobre. O botão só fechava, e
  sempre o dia inteiro.

  Agora o mesmo bloco pergunta o que fazer: fechar o dia, como antes,
  ou **abrir para atendimento** num intervalo de horas que você escolhe. A lista abaixo continua mostrando os
  dois, cada um com o seu rótulo.

  Se os dias se repetem, dá para abrir o período inteiro de uma vez:
  preencha **repetir toda semana até** e o bloco cria toda semana daquele dia
  da semana até a data limite, pulando o que já estiver cadastrado em vez de
  duplicar. O limite é um ano por vez.

  Quem mais ganha com isso é quem não atende em jornada fixa. Com a jornada semanal vazia,
  todo dia nasce fechado e só as datas que você abrir passam a oferecer horário — que é como
  se monta a agenda de quem atende em dias irregulares, às vezes em lugares diferentes no
  mesmo dia. Antes isso não tinha como ser feito pela tela.

  Nada muda para quem já usava: fechar um dia continua fechando o dia inteiro, e os dias já
  cadastrados seguem como estão.

- **Anúncios › Meta mostra o Connect rate de cada campanha** A tabela de campanhas de Anúncios › Meta ganhou a coluna Connect rate (visualizações da página ÷ cliques no link), a mesma conta do Gerenciador de Anúncios da Meta, logo depois do CTR. Campanha que não leva ninguém a uma página — mensagem no WhatsApp, por exemplo — mostra "—", e não 0%, porque ali não houve medição. Não há nada a fazer na instalação: os dois números passam a vir na mesma leitura de insights que a tela já fazia, sem chamada nova e sem gastar cota a mais. E a tabela passa a carregar mesmo quando a métrica nova não vem: se a plataforma recusar um dos dois nomes, a tela repete a leitura sem eles — a coluna fica "—" e todas as outras continuam funcionando, em vez de a tela inteira cair. O "—" não é mudo: no hover ele explica que o número não veio da plataforma (vazio não é zero), e o motivo cru que ela devolveu fica no log do servidor — sem esse rastro, a repetição trocaria um erro visível por um erro invisível. Crédito: @webtecnica.

- **A presença do atendente passa a existir — e a Equipe mostra quem está aí** O produto tinha o **leitor** do sinal de presença e nunca teve o **emissor**:
  o cron `attendant-heartbeat` derrubava do plantão quem não emitisse sinal de
  vida há 15 min, e nenhum arquivo do repositório emitia sinal nenhum. O único
  escritor de `last_heartbeat_at` era o clique na chave de plantão — um carimbo de
  clique se fingindo de batida, e a chave se desligava sozinha ~15 min depois de
  ligada (medido pelo @paulolimajr77 no PR #720).

  Agora cada aba aberta emite uma batida a cada 60 s (`POST
  /api/v1/attendants/presence`), e "tem alguém aí?" é respondido na hora da
  pergunta, a partir do carimbo: sem cron de expiração e sem coluna booleana de
  presença. Fechar a aba não escreve nada no banco — a pessoa some da lista de
  presentes dentro do prazo, sozinha. Quem lê: a rota de disponibilidade, a
  escalação (e a ferramenta MCP que o agente usa), o aviso ao lead e a tela de
  Equipe, com selo presente/ausente e o carimbo.

  A presença **não** toca na decisão. A separação é de tipo, não de disciplina: o
  predicado do plantão (`estaDePlantao`, em `lib/routing/eligibility.ts`) não
  recebe presença como entrada. Quem tira alguém do plantão é a pessoa (a chave)
  ou a jornada publicada — nunca o navegador fechando.

  Custo: uma escrita por aba a cada 60 s (480 em um turno de 8 h); com a aba
  fechada, nenhuma.

### Alterado

- **Arrumação interna de quem valida as chaves de integração** A parte do sistema que confere uma chave de integração (as que começam com `dsk_`) foi separada em duas: a que decide se a chave vale, e a que traduz a recusa para o formato de quem perguntou. Antes as duas eram a mesma peça, e qualquer outro pedaço do sistema que quisesse conferir uma chave tinha de carregar junto o vocabulário de erro de um protocolo que não era o dele.

  Nada muda para quem usa ou opera o sistema: as mesmas chaves continuam valendo, as recusas (chave desconhecida, revogada ou vencida) continuam devolvendo exatamente a mesma resposta, e o registro de último uso da chave continua sendo gravado. Você não precisa fazer nada e nenhuma integração precisa ser refeita.

  Crédito: @faxamkt.

### Corrigido

- **A IA voltou a conseguir remarcar um atendimento para logo depois do próprio fim quando há intervalo configurado** Com um intervalo antes do atendimento configurado — o respiro entre uma conversa e a seguinte —, a IA que tentava remarcar um atendimento para o horário logo depois do fim dele mesmo recebia uma recusa de "horário não disponível". A culpa era do próprio atendimento sendo movido: ele entrava na conta como se já estivesse ocupando o horário de destino, e o intervalo só aumentava a área onde essa confusão acontecia. Sem intervalo configurado, o mesmo pedido passava.

  Agora o atendimento que está sendo remarcado deixa de contar como ocupação contra si mesmo. Nada muda para os vizinhos: o intervalo continua valendo, e mover um atendimento para cima de outro continua sendo recusado como...[truncated]

- **A tela de atualização para de anunciar uma versão que o servidor não confirmou** Quando uma atualização terminava bem mas o servidor não voltava a se comunicar com o sistema — serviço parado, tarefa agendada removida, credencial vencida —, a tela de atualização anunciava como instalada a versão que o pedido pedia, e continuava anunciando por tempo indeterminado. Se o aplicativo não tivesse subido na versão nova, quem abrisse a tela lia a versão nova enquanto o que estava de fato em execução era a antiga, e não havia como desconfiar do que a tela dizia.

  Agora a tela só afirma a versão que o servidor confirmou por último. Nos minutos seguintes ao fim de uma atualização bem-sucedida, ela diz que o pedido terminou, que a confirmação ainda não chegou e qual é a última versão que o servidor confirmou — e não oferece de novo a atualização que acabou de ser feita. Passado o prazo sem nenhuma confirmação, a versão-alvo volta a aparecer como pedido em aberto, com o botão de atualizar de volta: se o aplicativo realmente não subiu, você consegue tentar outra vez pela própria tela.

  Nada para configurar. Quem tem o servidor reportando normalmente não vê diferença nenhuma: a tela segue mostrando a versão em execução e volta sozinha ao estado de sempre assim que a confirmação chega. Crédito: @webtecnica.

- **O agente de IA responde mais rápido no WhatsApp** O turno do agente pagava tempo que não precisava pagar antes de responder ao
  cliente: os dois classificadores auxiliares — o que sugere a etapa do funil e o
  que olha sinal de jailbreak — rodavam um depois do outro, e a pausa que dá ar
  humano à primeira mensagem era somada por cima do tempo que o turno já tinha
  gastado pensando.

  Agora os dois classificadores rodam ao mesmo tempo (o turno espera só o mais
  lento) e a pausa humana desconta o que já foi esperado. Quando há fila de
  mensagens acumulada, o escoamento não dorme entre um lote cheio e o próximo.

  Nada muda no ritmo de envio que protege o número do WhatsApp, nem no consumo do
  banco de quem não tem atendimento nenhum: os dois padrões que mexeriam nisso
  ficaram de fora, esperando medição.

- **A origem da página sobrevive quando o contato chega pelo WhatsApp** Quando alguém lia uma campanha no site e tocava no botão que abre o WhatsApp, a
  conversa entrava no CRM como WhatsApp e a origem da página morria ali: o card
  nascia sem rótulo nenhum, e o relatório de onde vem o negócio perdia justamente
  o toque que mais custa — o que veio de anúncio ou de landing page.

  Agora o link do botão pode carregar a origem junto (utm_source, utm_medium,
  utm_campaign, gclid) e ela é estampada no contato ANTES do card nascer, de modo
  que o card já nasce com o rótulo. Mensagem sem código nenhum segue exatamente
  como era.

  O código vale só na primeira mensagem do contato e nunca sobrescreve uma origem
  já gravada, inclusive a de anúncio: quem chegou de campanha paga primeiro mantém
  a campanha paga. Ele leva apenas campos de campanha — nenhum dado pessoal — e
  tem teto de tamanho. Em Configurações → Conversões há a explicação de como montar
  o link, com um exemplo gerado na hora, e a lista de contatos ganhou o filtro de
  origem "Site (landing page)".

- **Falhas de leitura da Agenda do Google voltam a explicar o motivo** Quando o Google recusa a leitura incremental da agenda, o diagnóstico agora usa o motivo estruturado da resposta em vez de gravar apenas `Google HTTP N`, sem copiar e-mail ou texto livre devolvido pelo provedor.

- **Conserto do sistema passa a valer já na primeira atualização, não na seguinte** A atualização carregava as rotinas do instalador antes de trocar para a versão nova, então um conserto que vivesse numa dessas rotinas só entrava em vigor na atualização seguinte. Foi o que aconteceu com o conserto que tira o segredo da linha de tarefas agendadas: quem atualizou continuava com a linha antiga até rodar a atualização outra vez.

  Não há nada a fazer: a próxima atualização aplica a correção sozinha — e, desta vez, numa passada só.

- **Dois stacks locais no mesmo host deixam de semear o banco um do outro** Quem mantém mais de um checkout do CRM rodando ao mesmo tempo na mesma máquina — cada stack com o próprio `project_id` e a própria faixa de portas — deixa de ver os dados de teste de uma sessão aparecerem no banco da outra. O arquivo `.env.e2e`, que os scripts de seed usam para abrir conexão direta com o banco, passa a receber a porta do Postgres do stack que está de pé, e não mais um endereço fixo da porta padrão: antes, com dois stacks no ar, a segunda sessão semeava o banco da primeira — conexão válida, schema idêntico, suíte verde e o estrago invisível, que é o que fazia o problema sobreviver sem queixa.

  Quando o stack não devolve a URL de conexão, o gerador do `.env.e2e` agora recusa a gerar o arquivo e diz o que faltou, em vez de gravar a porta padrão em silêncio na esperança de acertar. Os scripts de verificação passam a cobrir isso: um teste de shell sobe um stack falso fora da porta padrão e exige que o arquivo gerado acompanhe a porta daquele stack, para que a volta do endereço fixo reprove em vez de passar despercebida.

  Na sua instalação na VPS, nada muda: é o ambiente de desenvolvimento e de testes que fica correto.

- **A checagem de saúde não diz mais que o banco caiu quando ele está de pé** Quem instalou o CRM num projeto Supabase que **já servia outra aplicação** podia ver a
  atualização terminar dizendo que o app não respondeu "ok" — com o CRM atendendo
  normalmente, o login abrindo e os dados todos no lugar.

  A causa era da sonda, não do banco. A checagem de saúde consultava a API do Supabase sem
  dizer em qual schema procurar, e aí valia o **schema padrão do projeto** — que é `public`
  em projeto novo, mas é o da outra aplicação quando ela chegou primeiro. A sonda procurava a
  tabela no lugar errado, recebia "não existe" e concluía que o banco estava fora. Agora ela
  pergunta pelo mesmo schema que o CRM usa de verdade.

  Isso importa além do susto: a atualização usa essa resposta para decidir se deu certo, e um
  "não" falso fazia a versão nova ser **revertida sozinha** logo depois de instalar. Quem
  atualiza pela tela podia ver a versão voltar ao que era, sem nenhum erro aparecendo no CRM.

  Nada muda para quem instalou num projeto Supabase dedicado ao CRM — nesses, a sonda já
  acertava o schema por acaso, e continua acertando.

- **PDF com texto selecionável deixa de ser recusado como "só imagens escaneadas"** Ao anexar um PDF em Ensinar algo novo ao agente, todo arquivo — mesmo um com texto normal,
  selecionável — era recusado com "não consegui extrair texto deste PDF. Se ele for só imagens
  escaneadas...". A causa não era o arquivo: o `pdfjs-dist`, a biblioteca que lê o PDF, saía
  inteiro do build de produção (`next build` no modo standalone), porque o rastreador de
  dependências do Next não segue o `import()` que essa biblioteca usa para o subcaminho que o
  projeto carrega. O pacote simplesmente não chegava na imagem Docker, e todo PDF — com ou sem
  texto — falhava do mesmo jeito.

  Agora o build inclui o pacote explicitamente, do mesmo jeito que já era feito para o
  `@napi-rs/canvas` e o `@swc/helpers` — e mais um passo que só apareceu testando o caminho real
  de produção (o Turbopack bundla o pdfjs-dist num chunk próprio, e esse chunk procura o
  `pdf.worker.mjs` do pdf.js como arquivo vizinho dentro de `.next/server/chunks/`, não em
  `node_modules/`). PDFs com texto selecionável voltam a ser lidos; a mensagem de "só imagens
  escaneadas" volta a aparecer só quando o PDF É, de fato, só imagem. Provado com um PDF real de
  170 páginas, extraindo texto de ponta a ponta pelo mecanismo de carregamento de chunk que a
  produção usa.

- **Prévia do agente volta a listar tipos de atendimento da Agenda** O botão de testar o agente com contato fictício usa novamente a ferramenta real que lista os tipos de atendimento da Agenda antes de procurar horários disponíveis.

- **Rodar a suíte de testes numa VPS instalada deixa de acusar um erro que não existe** Quem instala o produto numa VPS copia o `.env.hostgator.example` para `.env` — é o
  caminho normal da instalação. Um dos testes do projeto varre o disco procurando
  repetições do endereço das imagens Docker, e esse arquivo copiado herda o mesmo
  endereço que o exemplo já tem permissão de conter. Resultado: a suíte reprovava em
  toda instalação de verdade, apontando para um arquivo que nem é versionado.

  O `.env` e o `.env.local` são estado da máquina, não código do projeto; o teste
  passou a ignorá-los, e continua reprovando qualquer arquivo versionado que repita
  o endereço.

- **O CI passa a provar que a imagem publicada extrai texto de PDF** Nada muda na sua VPS: nenhuma variável nova, nenhuma migration, nenhum comando. O que muda é o que o pipeline mede antes de a imagem sair — depois que a imagem do app sobe, o job extrai um PDF de amostra DENTRO dela, pelo mesmo caminho que a rota usa, e reprova se o texto não vier.

  Uma imagem publicada podia ler PDF de texto como "sem texto": a extração morre dentro dela antes de o arquivo ser aberto, e nenhum job do pipeline media isso. Os testes de extração rodam pelo repositório, onde a peça que falta na imagem existe; o gate de boot só exige que o app suba. O app sobe — a extração é que não funciona, e isso só aparecia quando alguém mandava um PDF de verdade. Enquanto o empacotamento não levar essa peça para a imagem, este passo fica vermelho de propósito: é ele dizendo no CI, na hora de publicar, o que hoje só aparecia no atendimento. Crédito: @webtecnica.

- **A Zona de perigo volta a apagar os dados operacionais em quem já enviou resposta revisada** Numa organização com resposta revisada, "apagar dados operacionais" parava na primeira tabela: a chave estrangeira de `ai_reply_drafts.message_id` apontava para `messages` sem ação de exclusão, então o banco recusava o `delete from messages` antes de a exclusão das conversas levar os rascunhos junto. O botão prometia apagar seis tabelas e não apagava nenhuma.

  A chave passa a `on delete set null`, como as outras três que apontam para `messages`. Na Zona de perigo o rascunho continua indo embora com a conversa, que é o dado operacional da organização; o que a ação muda é o caminho inverso — apagar uma mensagem avulsa deixa de travar (e deixa de arrastar o rascunho). Um invariante de banco novo cobre o caso: organização com resposta revisada apagada por inteiro, e a organização vizinha intacta.

  Nada muda para quem opera: a correção é de banco e se aplica sozinha na atualização.

## [1.33.0] — 2026-09-17

### Adicionado

- **Chave de IA editável — dá para trocar sem excluir e recriar** Na tela IA › Chaves de acesso à IA, cada chave agora tem um botão de editar. Por ele você
  troca a chave (e o nome) sem apagar e recriar: os agentes continuam ligados nela e, no próximo
  atendimento, já usam a chave nova. Antes só existiam revalidar e excluir, e excluir era um beco
  sem saída quando algum agente usava a chave.

  Quem tentava o caminho antigo — excluir e recriar — batia numa recusa que ainda mandava "remover
  as versões antes". Isso era duplo engano: remover a versão apaga o agente e o histórico dele, e
  a própria instrução não tinha como ser seguida, porque a versão está presa por outros dois
  vínculos. A recusa agora diz quantas versões usam aquela chave, nomeia os agentes e as versões,
  e ensina o caminho que existe: apontar cada versão para outra chave. Para girar uma chave que
  está em uso, o botão de editar resolve em um passo.

  O número "Em uso por" de cada chave passou a contar todas as versões que apontam para ela —
  inclusive rascunhos e versões antigas —, que é exatamente o que impede a exclusão. Antes ele
  contava só a versão publicada e podia mostrar zero numa chave que o sistema não deixava excluir.

  Nada a fazer na instalação: nenhuma chave existente é tocada e nenhum dado é convertido.

### Corrigido

- **O aviso de mensagem nova diz quem escreveu** O aviso que aparece na esquina quando chega mensagem dizia sempre "Nova
  mensagem", nunca o nome de quem escreveu: a leitura do contato saía sem sessão e
  o banco respondia com zero linhas — sem erro, sem log, sem nada reprovando. O
  aviso agora busca o contato pelo mesmo caminho autenticado que o avatar já
  usava, mostra o nome (ou o telefone) de quem escreveu, e traz o botão "Abrir
  conversa" para ir direto até ela. Nada a fazer na VPS além de atualizar.

- **Condição por "Desfecho do passo anterior" volta a filtrar leads** A condição **Desfecho do passo anterior** — e a negação escrita com ela
  ("não é <classe>") — agora decide de verdade. O motor montava esse campo como
  `null` fixo, então o filtro era decorativo: quem escrevia uma negação via o
  fluxo mandar **todos** os leads pelo ramo da negativa, inclusive os que nunca
  passaram por um passo de classificação, e o follow-up seguia calado pelo
  caminho errado.

  O que muda em quem opera a VPS:

  - a condição passa a ler a classe escolhida pelo último passo de classificação
    da inscrição — o mesmo desfecho que o histórico da conversa mostra;
  - lead **sem classificação** deixa de satisfazer a negativa: "não foi X" só vale
    para um lead que **foi classificado** com outra classe. Ausência de dado não
    prova a negativa (e `é`/`contém` já eram falsos nesse caso);
  - vale conferir os fluxos que usam essa condição com `não é`: eles podem passar
    a desviar leads que antes seguiam reto por ali. Nada quebra e nada precisa ser
    reconfigurado — era o filtro que o dono da VPS achava que já estava valendo.

- **Ligar o pacote "Atender e responder" não oferece mais duas capacidades que o motor descartava** Na configuração do agente, o pacote **Atender e responder** listava duas capacidades com
  checkbox marcável que o motor recusava em silêncio a cada turno: enviar mensagem de WhatsApp
  e passar a conversa para uma pessoa. Quem marcava via o agente publicado com a capacidade
  ligada, e nada acontecia — o único sinal era uma linha no log do worker.

  As duas continuam existindo e continuam acontecendo: quem envia é o próprio sistema, pelo
  caminho seguro, com opt-out, regra anti-ban e o silêncio dos follow-ups quando um humano
  assume. O que muda é a tela — em vez de um checkbox que o motor descartava, ela mostra a
  capacidade com o motivo escrito, e o pacote passa a contar só o que ele de fato entrega.

  Quem instala não precisa fazer nada: nada que o agente já fazia deixou de funcionar, e
  nenhuma capacidade ligada por engano passa a ter efeito.

- **A pausa que imita digitação humana deixa de segurar o número inteiro** Quando a IA respondia, a pausa que imita digitação humana era paga com a trava do
  número na mão. Enquanto um cliente esperava 1,2s a 7,5s, todo atendimento do MESMO
  WhatsApp esperava atrás dele — e com o throttle anti-ban somado no mesmo ponto, o
  pior turno segurava a fila por até 9,5s. Dois atendentes no mesmo número entravam em
  fila; a fila ficou mais longa.

  A pausa continua existindo, com a mesma duração e o mesmo aviso de digitando: ela só
  passou a ser paga antes de a trava do número ser tomada, então durante a espera o
  número já pode atender o próximo. Nada a fazer na VPS.

- **A Agenda encontra clientes pelo nome exibido em Contatos** Em Novo agendamento, o cliente que chegou pelo WhatsApp e só tem o nome do perfil não era encontrado pela busca e aparecia em branco na lista de quem será atendido. Agora a busca procura pelo nome do cadastro e pelo nome do perfil do WhatsApp, e a lista mostra o mesmo nome da tela de Contatos: o do cadastro e, na falta dele, o do perfil. Nada para configurar. Crédito: @vanksestevao.

- **Na Agenda, o papel Somente leitura não vê mais "Novo agendamento"** Quem entra na Agenda com o papel "Somente leitura" via o botão "Novo agendamento", podia clicar num horário livre da grade e podia abrir o painel de marcação pelo "Marcar compromisso" que chega do Inbox — e só descobria a recusa no 403 da rota, depois do gesto. Agora as três portas somem para esse papel: o botão não aparece, a grade fica só de leitura (sem bloco clicável) e o painel não abre sozinho pelo link. O rótulo do botão e o comportamento de quem tem papel de equipe ficam iguais — e a rota continua decidindo, como sempre. Ficam de fora, ainda com o 403 da rota: "Confirmar", "Remarcar", "Cancelar", "Realizado" e "Faltou" no Histórico da Agenda. Crédito: @webtecnica.

- **Excluir uma conexão de WhatsApp fecha o aviso crítico que ficava aberto para sempre** A Central de avisos mantinha um alarme crítico para uma conexão que já não existia — "WhatsApp fora do ar (STOPPED) — Nenhuma mensagem entra nem sai por esta conexão até ela voltar" — e o cartão nem conseguia mostrar o contexto: "Este contexto não está disponível para você". O aviso só fechava quando a própria sessão avisava que tinha voltado, e uma conexão arquivada nunca mais manda evento nenhum: o único caminho que resolveria o episódio desaparecia no mesmo instante em que a conexão era removida. Enquanto isso, a conexão nova, com o mesmo número, podia estar funcionando normalmente nos dois lados.

  Agora, ao excluir (ou arquivar) uma conexão, os avisos abertos DELA são resolvidos no mesmo ato — e só os dela: o alerta de outro número que segue caído continua na Central, e o número que voltar a cair avisa de novo. O que a operação fez com os avisos fica registrado na auditoria.

  Crédito: @webtecnica. Relato: @rogercampel.

- **O boot não acusa falta de IA quando a credencial pode estar no painel** O aviso de inicialização agora distingue ausência de chave no ambiente de ausência real de credencial, evitando orientar quem opera a corrigir uma configuração que pode já estar válida em IA › Credenciais. Crédito: @joaopaulomirandamatias.

- **A atualização diária da lista de modelos de IA voltou a rodar** Numa instalação nova, a tarefa que atualiza todos os dias a lista de modelos de inteligência artificial disponíveis era recusada pelo próprio sistema e não fazia nada. O instalador cria dois segredos diferentes para as tarefas agendadas, e essa tarefa — só ela, entre as vinte e quatro — aceitava apenas um deles, enquanto o agendador usa o outro. Como a saída dessas chamadas não é guardada, a recusa diária não aparecia em lugar nenhum.

  Você não precisa fazer nada: nenhuma configuração muda e nenhum segredo precisa ser trocado. A tarefa passa a ser aceita como as demais.

  Também saiu do projeto o arquivo de agendamento que só servia a uma plataforma de hospedagem que o produto não usa, junto com a exigência de mantê-lo atualizado a cada tarefa nova. A lista que vale continua sendo a do agendador que acompanha a instalação, e ela segue protegida: tarefa sem agendamento, ou agendamento apontando para tarefa que não existe, continuam reprovando na verificação automática.

- **A ficha do contato identifica o nome do perfil do WhatsApp** Na visão geral do contato, o nome recebido do perfil do WhatsApp deixa de aparecer com o rótulo técnico em inglês e passa a ser identificado claramente na interface. Crédito: @joaopaulomirandamatias.

- **A agenda, o novo contato, o novo lead e o onboarding passam a falar o idioma de quem usa** Quem usa o sistema em espanhol deixa de ver em português os motivos e horários dos blocos da agenda, os avisos de remarcação, o campo de e-mail do novo contato, a janela de novo lead e o rótulo do botão de tema. O onboarding passa a seguir o idioma da organização quando a pessoa não escolheu um idioma próprio, e a página passa a declarar ao navegador o idioma em uso assim que carrega. A tradução completa da interface para chinês simplificado entrou no sistema, mas ainda não aparece para escolha. Em português, nada muda. Crédito: @xxjjjj.

- **O intervalo antes do atendimento passou a valer também na hora de marcar** Se você configurou um intervalo antes (ou depois) do atendimento — aquele tempo de respiro entre um compromisso e outro —, o vizinho só era levado em conta quando caía dentro do horário consultado. Na hora de MARCAR (pela IA, por token ou por webhook) a conferência olhava só a janela do próprio atendimento, o compromisso vizinho ficava fora dela e o horário era aceito, mesmo invadindo o intervalo que você pediu para guardar; e a lista de horários tinha a mesma falha na borda do período pedido. Agora as duas olham também o intervalo antes e depois. Efeito que você pode notar: pedir à IA para passar um compromisso para o horário logo depois dele, com intervalo configurado, passa a ser recusado, porque o próprio compromisso ainda ocupa o intervalo. Nada para configurar: os agendamentos que já existem seguem como estão.

  Crédito: @webtecnica.

- **Arquivo que o sistema não conseguiu ler deixa de virar resposta inventada** Quando a leitura de um arquivo enviado pelo cliente falhava de vez — um PDF
  escaneado, sem texto de verdade, é o caso mais comum —, o agente recebia apenas
  a marca "[documento]". Isso diz que chegou um arquivo e não diz que ninguém
  conseguiu abri-lo, e o agente respondia como se soubesse o que havia ali.

  Medido numa instalação real: uma cliente mandou um PDF de catálogo, o extrator
  de texto falhou, e o assistente respondeu que o material "parece ser de
  distribuidora/promocional" — uma afirmação sobre um conteúdo que ele nunca leu.

  Agora a falha grava a mesma marca que os outros casos de arquivo ilegível já
  gravavam: "não consegui interpretar". Da mensagem seguinte em diante o agente
  sabe que houve um arquivo que não deu para ler e avisa, em vez de supor. O
  aviso na Central continua aparecendo como antes, com o motivo técnico.

  O turno que já tinha respondido não volta atrás — a correção vale do próximo em
  diante, que é quando o agente lê o histórico da conversa.

- **O editor do agente diz na tela por que o Publicar está desabilitado** No editor do agente, o motivo de o botão Publicar estar desabilitado existia só no `title` do botão: aparecia com o ponteiro parado em cima dele. Em celular e tablet não existe hover, e um botão desabilitado não recebe foco do teclado — quem mais precisava da explicação era exatamente quem não a recebia. Agora o motivo aparece como texto na própria tela, logo abaixo do cabeçalho do editor, e o botão aponta para ele por `aria-describedby`, então o leitor de tela anuncia a explicação junto do rótulo. As frases do motivo não mudaram e continuam traduzidas em espanhol. Nada muda na sua VPS: nenhuma migration, nenhuma variável, nenhum comando. Crédito: @webtecnica.

- **Campos de lista fechada voltam a aceitar mais de uma opção** No editor de campos do funil, em Configurações, digitar a vírgula entre as opções de um campo de seleção apagava o separador e colava a palavra seguinte na anterior — na prática só dava para salvar uma opção. Agora a lista aceita quantas opções você digitar. Crédito: @deskcommopp4s-cmd.

- **A recusa do Google passa a dizer o que aconteceu** Quando o Google recusava uma alteração da Agenda, o erro gravado no compromisso dizia apenas "Google HTTP 400". O Google já tinha dito o motivo na resposta (`invalid`, `insufficientPermissions`, `rateLimitExceeded`…), mas ele era descartado antes de virar a frase. Agora a frase diz o tipo da recusa (sem permissão no calendário, limite de uso do Google, evento que não existe mais, recusa que repetir não resolve), o código HTTP e o motivo que o Google mandou — por exemplo: "o Google recusou e repetir não muda o resultado — HTTP 400 (invalid)".

  O compromisso recusado continua marcado com erro e continua sendo reexaminado pela sincronização, como antes. Da resposta só entra o que tem formato de identificador (letras e sublinhado): e-mail de convidado e frases ficam de fora da frase, que é gravada e mostrada na tela. Quando o calendário inteiro foi apagado no Google, a frase agora diz isso, em vez de falar do evento. Nada para configurar. Crédito: @webtecnica.

- **A documentação deixou de dizer que o sistema roda numa plataforma que ele não usa** Vários textos do projeto — o guia de quem contribui, os runbooks de operação, as especificações e até uma mensagem de erro do próprio sistema — afirmavam que o CRM era publicado e testado numa plataforma de hospedagem gerenciada. Isso deixou de ser verdade: o produto é instalado na sua própria infraestrutura, e é lá que ele opera.

  Nada muda no que você roda hoje. O que muda é o que você lê: a mensagem que aparece quando falta uma variável agora manda ajustar o `.env` da instalação, em vez de um painel que você não tem; os procedimentos de trocar chave do WhatsApp e de rotacionar credenciais passam a descrever o `.env` e a recriação dos contêineres; e o texto que quem contribui recebe ao abrir um pedido de mudança deixa de anunciar um resultado de verificação que não existe mais, e diz onde olhar o que de fato trava a entrada do código.

  O agendador de tarefas para quem instala sem cron próprio continua existindo e funcionando igual — só deixou de ser descrito como coisa de uma plataforma específica.

## [1.32.1] — 2026-09-17

### Corrigido

- **A senha das rotinas automáticas deixa de ser gravada no log do servidor** A rotina que processa a fila de eventos a cada minuto levava a senha interna escrita na própria linha do agendamento, e o servidor anota cada execução no log do sistema: a senha ia parar lá uma vez por minuto. Agora ela fica num arquivo que só o administrador do servidor lê, e a linha do agendamento só aponta para ele. Instalações novas já nascem assim; nas existentes, a troca acontece sozinha a partir da atualização SEGUINTE a esta, porque a atualização em curso ainda roda o instalador da versão anterior. Crédito: @rafaeskytrabalho.

## [1.32.0] — 2026-09-17

### Adicionado

- **Guias opcionais podem ser instalados e ativados por organização** A área Extensões permite ao responsável pela instalação admitir um catálogo revisado e baixar guias declarativos sem reconstruir o aplicativo. Cada organização escolhe quais guias ativar e como apresentá-los no CRM; desativar preserva a configuração. Os pedidos ficam registrados, com retomada e cancelamento de preparações interrompidas. O conteúdo instalado continua disponível quando o catálogo está fora do ar.

  O responsável pela instalação também atualiza um guia para outra versão do catálogo, desfaz a última troca mesmo com o catálogo fora do ar e remove um guia da instalação. Enquanto houver um guia sendo preparado, a atualização do sistema pela tela espera; a própria tela diz como retomar ou cancelar essa preparação em Extensões. Remover desliga o guia em todas as organizações, guarda a configuração de cada uma e registra na auditoria de cada organização por que ele saiu; ao reinstalar, cada organização decide se ativa de novo.

  Este primeiro perfil aceita apenas conteúdo e ações conhecidas do sistema. Código externo e o catálogo público com avaliações ainda não são oferecidos. O sistema continua funcionando com zero extensões, e a atualização normal aplica as tabelas necessárias, sem variável obrigatória nem edição manual de arquivo. A única variável nova, `EXTENSIONS_LOCAL_CATALOG_ORIGIN`, é de laboratório e fica vazia por padrão.

### Corrigido

- **As travas do modo somente leitura do suporte cobrem todas as tabelas já na instalação nova** As travas do modo somente leitura do suporte cobrem todas as tabelas da organização já na primeira aplicação do schema, e uma instalação nova chega ao mesmo conjunto de travas que uma instalação atualizada.

  Não há nada a fazer: a próxima atualização aplica a correção sozinha.

## [1.31.1] — 2026-09-17

### Corrigido

- **A atualização refaz o banco quando ele está ocupado, e para de mostrar avisos falsos** Quem tinha materiais do acervo ligados a um agente via, a cada atualização, até três avisos de banco (`could not create unique index`), mesmo com tudo certo. Não havia dado errado: o instalador tentava recriar três regras antigas do acervo que ele mesmo apaga logo depois, e que não cabem mais no jeito atual de guardar os materiais. Essas tentativas saíram, e nenhum dado foi apagado ou alterado.

  A atualização também recriava, por um momento, 21 regras de acesso antigas que ela mesma apagava em seguida, e reinstalava outras 2 numa versão mais larga que a de hoje. Isso acabou. Algumas dessas regras eram mais largas que as atuais: no meio-tempo, um usuário só de leitura conseguia alterar dados que as regras de hoje protegem — medido num Postgres de verdade, com um `viewer` que hoje não altera, não apaga e não cria um lead, e que com a regra antiga fazia as três coisas. E se a atualização falhasse justo no comando que apaga a regra antiga, ela ficava valendo até a atualização seguinte.

  O ruído escondia um problema de verdade. Com o CRM atendendo, o banco às vezes recusa um comando da atualização por disputa com o próprio app (`deadlock detected`), ou a conexão cai no meio. A atualização avisava e seguia, e o que não aplicou ficava para trás: numa instalação real, o acervo dos agentes ficou sem a regra que permite lê-lo. Agora a atualização aplica o banco de novo, em até três passadas no total, e mostra na tela o que precisou refazer. Se ainda assim o banco não terminar limpo, o **fim** da saída diz isso e explica o que fazer conforme a causa: repetir a atualização quando o banco estava ocupado, ou acertar a conexão do `.env` quando faltou permissão — repetir, nesse caso, não resolveria. Na atualização pelo botão da tela esse aviso ainda não aparece: ele fica registrado em `.update.log`, na pasta do projeto no servidor.

  A nova tentativa vale a partir da atualização seguinte a esta, porque quem executa uma atualização é o instalador que já está no servidor. Os avisos falsos e as regras de acesso antigas saem já nesta.

- **A atualização deixa de reabrir, no meio do caminho, permissões que ela mesma fecha adiante** O instalador aplica o arquivo de banco inteiro a cada atualização, um comando de cada vez. Três linhas dele concediam uma permissão que o próprio arquivo retira adiante — o banco ficava, no meio do caminho, com uma permissão a mais do que teria no fim.

  As três linhas saíram. O estado final do banco é exatamente o mesmo de antes: quem termina a atualização fica com as mesmas permissões de sempre, e nada muda para quem usa o sistema. Duas guardas novas impedem a volta: uma lê o arquivo e recusa concessão no corpo que seja revogada adiante, e a outra prova em banco que reaplicar o arquivo não deixa nenhuma função ganhar permissão que ela não tinha.

## [1.31.0] — 2026-09-17

### Adicionado

- **O agente confere e marca o horário na mesma chamada** Quando a pessoa já dizia o dia **e** a hora ("quinta às 14h"), o agente conferia a agenda,
  respondia que o horário estava livre e encerrava o turno — **ninguém marcava nada**, e o
  compromisso só existia na conversa. Consultar e marcar eram duas idas ao modelo, e o turno
  parava no meio do caminho com o cliente achando que estava agendado.

  Agora o agente tem uma ferramenta que faz as duas coisas numa chamada só: se o horário pedido
  estiver livre, ele é marcado na mesma resposta, com o mesmo tipo de atendimento, a mesma reserva
  de horário e a mesma exigência de aprovação da equipe dos agendamentos que já existem.

  Se o horário **não** estiver livre, nada é marcado — e o agente recebe os horários que a agenda
  tem naquele dia, para oferecer uma alternativa na mesma conversa em vez de pedir outra data no
  escuro. O horário marcado é sempre o que a agenda confirmou como livre, nunca o texto que veio
  na mensagem.

  Em quem já usa o assistente, a capacidade nasce desligada: o que cada assistente pode fazer
  fica gravado na versão publicada dele, e capacidade nova não entra sozinha. Abra o assistente,
  vá em "O que o agente pode fazer", ligue "Ver se o horário está livre e já marcar" — o pacote
  "Vender e mover o funil" vai aparecer como parcial até você ligar — e publique. Em instalação
  nova o assistente já nasce com ela.

- **Etiquetas ganham tela própria para renomear, juntar e excluir** Configurações agora tem a tela de Etiquetas: a lista das etiquetas em uso, com quantos
  contatos, negócios, conversas e regras de agente cada uma alcança. De lá dá para renomear,
  juntar duas numa só e excluir. No renomear e no juntar, a regra de marcação dos agentes que
  escrevia a etiqueta é corrigida na mesma operação, numa transação só; no excluir, a tela avisa
  quantas regras continuam escrevendo a etiqueta e não mexe nelas.

  Era esse o defeito de origem: renomear a etiqueta sem corrigir a regra deixava o agente
  escrevendo a grafia velha na próxima conversa. Quem instala não precisa fazer nada: o
  `update.sh` aplica a migration e a tela aparece em Configurações para gerentes e
  administradores.

- **Levar um negócio aberto para outro funil (o clone que a P-01 mandava usar)** Negócio que começou no funil errado (ou que muda de natureza no meio do caminho —
  o pedido de suporte que virou venda) não tinha por onde sair: o quadro só sabe
  trocar a etapa DENTRO do mesmo funil, e quem tentava pela API recebia "não é
  permitido, clone o negócio" — apontando para um clone que não existia em lugar
  nenhum do produto. A instrução apontava para o vazio.

  Agora existe a troca de funil, por enquanto pela API (`POST
  /api/v1/leads/[id]/clone`); o botão no quadro vem na fatia seguinte. O negócio é
  criado no funil de destino (na primeira etapa aberta, ou na etapa que você
  escolher) com os mesmos dados — título, contato, valor, dono, previsão, tags e
  campos personalizados (os que o funil de destino não tiver continuam guardados no
  negócio, mas só aparecem na tela quando você criá-los lá) — e a origem é encerrada
  como perdida. Os dois lados contam a troca na linha do tempo: o novo negócio mostra
  de qual funil veio, e o antigo mostra para qual funil foi levado, em vez de
  aparecer como uma perda comum.

  Duas coisas que a troca NÃO faz, de propósito: negócio já encerrado não é clonado
  (reescrever um ganho como perda apagaria o desfecho que alguém registrou) e trocar
  de etapa dentro do mesmo funil continua sendo o arrastar de sempre, sem encerrar
  nada.

### Alterado

- **O botão que cria um lead no painel do Inbox passa a se chamar "Novo Lead"** No painel lateral do Inbox, o botão "Lead" passa a se chamar "Novo Lead". Ele sempre abriu o cadastro de uma negociação nova para o contato, mas o nome curto dava a entender que mostraria o lead que já existe. O lead existente continua sendo editado em "Leads recentes", no mesmo painel, e a ficha da pessoa continua em "Ver contato". Nada muda no que o botão faz. Crédito: @rafaelbatistazz.

### Corrigido

- **A janela de perder mostra os motivos que você cadastrou no funil** Quem cadastrava os próprios motivos de perda em Funis não os encontrava na hora de marcar um
  card como perdido: a janela oferecia sempre a lista padrão do produto. O operador escolhia
  "Outro", digitava o motivo à mão e só descobria no clique se aquele funil aceitava o texto —
  com erro na cara quando não aceitava.

  Agora a janela lê os motivos do funil do próprio card. Se você cadastrou "Sem orçamento" e
  "Fora do perfil", são esses dois que aparecem, com as suas palavras; sem nada cadastrado, a
  lista padrão continua valendo. Nos funis com motivos cadastrados, "Outro" passa a recusar ali na
  tela o texto que aquele funil não aceita — antes do clique, em vez de depois dele — e a dizer onde
  se cadastra um motivo novo. Deixar o detalhe em branco continua valendo em qualquer funil: grava
  "Outro", como sempre.

- **Arrastar o mesmo card duas vezes seguidas no funil deixa de dar "modificado por outro usuário"** No funil, o primeiro arrastar de um card funcionava, mas arrastar o mesmo card de novo logo em seguida mostrava "Lead foi modificado por outro usuário. Recarregue e tente novamente.", sem ninguém mais usando, e só voltava a funcionar recarregando a página. O próprio movimento registra a mudança de etapa no histórico, e esse registro atualizava o card de novo depois que a tela já tinha guardado a versão anterior. Agora o servidor devolve a versão final do card e a tela a guarda na hora, então, assim que o primeiro movimento é confirmado, dá para mover o mesmo card de novo sem recarregar a página. Crédito: @rafaelbatistazz.

- **O compromisso do Google que atravessa a borda do período volta a aparecer na grade** O compromisso do Google Agenda que começa antes do período que a tela desenha e termina dentro dele — das 23:30 às 00:30, por exemplo — passa a aparecer quando atravessa a borda desse período: a virada da semana na visão Semana, a virada do mês na visão Mês e toda meia-noite na visão Dia. Ele entra fatiado no pedaço que cai dentro do período. Antes, a grade perguntava pelo começo do compromisso e só desenhava os que começavam dentro do período: o horário que a tela mostrava livre era recusado na hora de marcar. A tela e a rota que a alimenta passam a usar a mesma conta do motor de disponibilidade (interseção de intervalos), lida de um só lugar. Para quem lê a lista pela API, o bloco do Google passa a vir recortado no período pedido — o instante de começo nunca é anterior ao período, e o de fim nunca é posterior. Fora isso, nada mudou: a grade continua recebendo apenas identificador, dono e os dois instantes, nunca o conteúdo do evento.

- **Mover um card para uma etapa de perda sem motivo deixa de dar erro 500** Mover um card para uma etapa que fecha o negócio como perdido sem informar o
  motivo respondia "Erro inesperado" (500) — e o card não se movia, sem dizer por
  quê. Acontecia nos três caminhos que trocam a etapa do negócio: o arrasto no
  quadro, o movimento em lote e o movimento feito pelo assistente de IA.

  O motivo da perda é exigência do banco desde sempre (a etapa de perda fecha o
  negócio, e fechar como perdido sem causa registrada não é permitido). Quem estava
  errado era a tela, que deixava a pergunta chegar ao banco e devolvia a recusa como
  falha de servidor.

  Agora a resposta é a recusa de negócio, com o que fazer: no arrasto, o card volta
  para a coluna de origem e a tela avisa "Informe o motivo da perda: use “Marcar
  como perdido” no menu do card, que pede o motivo."; no lote, a recusa avisa antes de tentar, em vez de derrubar o lote inteiro
  por causa de um card; e o assistente de IA não leva o card para a etapa de perda:
  ele avisa na Central que o negócio deveria ser marcado como perdido e que o motivo
  é uma decisão de quem está no negócio. O aviso não se repete a cada mensagem do
  cliente: enquanto o primeiro estiver aberto na Central, não nasce outro igual para o
  mesmo negócio.

  Nenhuma ação é necessária na instalação: a regra do banco não mudou e nenhum dado
  foi tocado.

- **Dá para excluir um card do funil pelo menu do próprio card, inclusive no celular** Para excluir um card do funil era preciso selecioná-lo e usar a barra de ações em lote. No celular e no tablet isso era impossível: a caixa de seleção e o botão de menu do card só apareciam com o mouse em cima. Agora o menu de ações do card tem "Excluir", com confirmação que diz o nome do card e o que vai junto (o histórico de atividades; o contato e as conversas continuam), e o botão do menu fica visível em telas de toque. A opção aparece para quem já podia mexer no funil. Selecionar vários cards de uma vez continua só no computador: a caixa de seleção do card segue aparecendo apenas com o mouse em cima. Crédito: @rafaelbatistazz.

- **Conectar o Google Agenda deixa escolher qualquer conta do Google, não só a do e-mail de login** Ao conectar o Google Agenda, quem já tinha aberta no navegador a conta com o mesmo e-mail do login no CRM ia direto para ela, sem passar pela escolha de conta. Quem entra no CRM com um e-mail e tem a agenda em outro não conseguia vincular a agenda certa. Agora o CRM pede ao Google o seletor de contas em toda conexão, com a conta do login apenas sugerida — quem desenha essa tela é o Google. A conexão continua sem expirar sozinha. Crédito: @rafaelbatistazz e @webtecnica.

- **"Leads recentes" do Inbox diz o funil, a etapa e o status em português** No painel lateral do Inbox, a seção "Leads recentes" mostrava só título, status e valor. Dois leads de mesmo nome em funis diferentes ficavam idênticos ("open · —"), e o status aparecia em inglês. Agora cada lead mostra o funil e a etapa onde está e o status traduzido (Aberto, Ganho, Perdido). Leads de funil arquivado deixam de aparecer na lista. Arquivar um funil não fecha os leads dele, então eles continuavam na lista. Nenhum dado é alterado. Crédito: @rafaelbatistazz.

- **O nome que você edita no contato passa a aparecer no lugar do nome do WhatsApp** Quem corrigia o nome de um contato em "Editar contato" continuava vendo o nome do perfil do WhatsApp — às vezes um apelido ou um emoji — no Inbox, na lista de contatos, nas notificações e no radar de risco. O agente de IA e o lembrete da agenda também chamavam o cliente pelo nome do perfil. Agora o nome preenchido na ficha vem primeiro em todos esses lugares; o nome do WhatsApp só aparece quando o contato não tem nome cadastrado. Nada precisa ser refeito: contatos que já têm nome passam a mostrá-lo na hora. O mesmo vale para o card da Agenda, para a prévia de um pedido de LGPD e para o título do negócio que uma automação cria — três lugares que ainda montavam o nome por conta própria e podiam mostrar um código interno do WhatsApp no lugar do nome. Um efeito fica GRAVADO: o card de negócio que nascer de uma primeira mensagem a partir de agora leva esse nome no título — os cards que já existem continuam com o título que receberam quando nasceram. Crédito: @rafaelbatistazz.

- **O Radar de risco deixa de mostrar leads de funil arquivado** Depois de arquivar um funil, os leads dele continuavam aparecendo no Radar de risco, e na lista de demandas sem próximo passo, como se precisassem de atenção. Arquivar um funil não fecha os leads, e o radar lia todos os leads abertos da organização. Agora leads de funil arquivado e as demandas ligadas a eles ficam de fora do radar, tanto na tela quanto na consulta que o agente de IA faz. Nenhum dado é alterado: os leads e o histórico continuam guardados no funil arquivado. Um número ainda não acompanha: o contador "Demandas abertas sem próximo passo", na tela de Métricas, continua somando as demandas de funil arquivado — ele sai de outra consulta, e será alinhado em seguida. Até lá as duas telas mostram números diferentes para a mesma coisa, e o do Radar é o que já exclui o funil arquivado. Crédito: @rafaelbatistazz.

- **Tag em lote no funil mostra as tags que já existem** No funil, ao selecionar vários cards, o menu "Tag…" da barra de ações só oferecia um campo para digitar uma tag nova, sem mostrar as tags que os leads já usam. Agora o menu lista até 10 tags já usadas pelos leads do funil, filtrando pelo que você digita, e clicar aplica a tag a todos os cards selecionados. Digitar uma tag nova continua funcionando. A atualização não muda nada no seu banco: a tela passa a mostrar tags que já existem. Crédito: @rafaelbatistazz.

- **Tags do contato no Inbox sugerem as tags que já existem** No painel lateral do Inbox, o editor de tags do contato não sugeria nada: cada pessoa digitava a tag do zero, e a mesma ideia virava várias tags diferentes ("google", "gogle", "google ads"). Agora ele mostra, como botões "+ tag", as tags que já existem nos contatos mais recentes da organização — até oito por vez —, do mesmo jeito que o editor de tags da conversa já fazia. Clicar aplica a tag, sempre em minúsculas — é a mesma forma com que o editor já gravava o que se digita, então o rótulo do botão diz exatamente o que vai ser gravado. A atualização não mexe em nenhum dado: as tags que já estão gravadas continuam como estão, e o que muda é a sugestão aparecendo na tela. Crédito: @rafaelbatistazz.

## [1.30.0] — 2026-09-16

### Adicionado

- **A conversa ganha "Arquivar" — sai da fila viva, fica guardada numa aba própria e volta sozinha quando o cliente escreve** Quem atende passa o dia na Fila, e nem tudo que acaba ali merece continuar à vista: conversa que o cliente abandonou, número que era trote, atendimento que já terminou e ninguém fechou. Até agora não havia nada a fazer com isso — a conversa ficava na lista para sempre, empurrando para baixo o que ainda é trabalho. Excluir de vez continua fora, porque o histórico é do cliente e não se apaga.

  Agora existe **Arquivar**. Tudo que já é do passado ruma para uma pasta própria: a conversa sai da Fila e das listas de conversas em andamento, aparece na aba **Arquivadas** (ao lado de "Fechadas", com o próprio número) e o histórico continua inteiro para quem for consultar. Arquivar **encerra o atendimento**, como um fechamento — a diferença é onde a conversa fica guardada e o rastro que fica na auditoria. Se o cliente escrever de novo, a conversa volta sozinha para a caixa de entrada — o banco já fazia essa volta, e agora a tela conta isso em vez de esconder.

  Quem pode arquivar é quem já podia encerrar: atendente para cima. O que passa a ficar registrado é o motivo da mudança: arquivar deixa o evento próprio `conversation.archived` na auditoria, em vez de se confundir com "devolvida" ou com o fechamento do atendimento. Fechar continua sendo fechar, e o número da aba "Fechadas" passa a contar só as fechadas — antes ele somava as arquivadas e mostrava mais do que a lista.

- **Os guias do assistente passam a funcionar em qualquer pasta, e dois deixam de ser descartados** Um comando só (`curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash`) liga os guias `deskcomm-instalar`, `deskcomm-cliente-novo`, `deskcomm-metricas`, `deskcomm-prompt`, `deskcomm-contribuir` e `deskcomm-doutrina` nas pastas globais do Claude Code, Codex, Cursor, OpenCode e Antigravity — antes eles só existiam com o assistente aberto dentro de um clone atualizado, o que deixava de fora justamente quem ainda não instalou. Pedir o assunto em português aciona o guia em qualquer um deles. Os guias não se atualizam sozinhos: rodar o comando de novo traz a versão nova, e `curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash -s -- --remover` desfaz. O cabeçalho de dois guias trazia um erro de formato que assistentes mais rigorosos descartavam sem avisar, e foi corrigido.

- **Quem ainda não tem conta já vê login, cadastro, convite e páginas legais em espanhol** O idioma da interface sempre dependeu de uma sessão: `preferência da pessoa → idioma da
  organização → padrão`. Fora dessa cadeia — login, cadastro, aceite de convite, política de
  privacidade e termos — não havia nenhum sinal para seguir, e a tela caía sempre em português,
  mesmo para quem nunca vai ler português.

  Agora essas telas também consultam o `Accept-Language` que o navegador já manda em toda
  requisição: se o visitante não tem preferência salva (é a primeira vez, ainda não tem conta),
  o idioma dele na lista de preferências decide. Uma preferência já salva continua vencendo
  sempre — isto só entra em jogo para quem a tela nunca viu antes.

### Corrigido

- **A ajuda de "esperar a resposta por" no follow-up voltava a português mesmo em espanhol** O texto de ajuda do campo "Esperar a resposta por (minutos)" (nos construtores de
  classificação e de resposta correspondida do fluxo de follow-up) era uma string pronta em
  português — composta uma vez, no idioma do arquivo, citando o rótulo da aresta e o mínimo em
  minutos. Com o idioma em espanhol, ela continuava aparecendo em português, porque nunca
  passava por `t()`: só existia como texto fixo.

  Virou uma função que compõe a frase no idioma de quem está olhando, citando o mesmo rótulo
  traduzido que a aresta mostra no canvas do fluxo. Nenhum comportamento muda para quem usa
  português.

- **O construtor de follow-up para de reaproveitar identificadores, e "cancelar se o lead responder" passa a valer na espera** Duas coisas que estavam quebradas no acompanhamento automático. A primeira: ao abrir um fluxo já salvo e acrescentar um passo ou uma ligação, o construtor recomeçava a contagem de identificadores do zero — o passo novo nascia com o mesmo identificador de um que já existia, e a ligação que você acabou de desenhar aparecia por cima de outra, ou o salvamento era recusado. Agora a contagem continua de onde o fluxo parou. A segunda: a chave "cancelar se o lead responder" só valia enquanto o fluxo esperava uma resposta; numa espera por tempo — "aguarde 2 dias" —, a resposta do cliente não cancelava nada e a próxima mensagem saía assim mesmo, como se ele não tivesse respondido. Agora cancela nos dois casos.

  Um aviso para quem já editou fluxos antes desta versão: um rascunho que ficou com identificadores repetidos **não se conserta sozinho**. Abra o fluxo, apague o passo ou a ligação duplicada pela tela e salve de novo — daí em diante o problema não volta.

- **O domínio de quem manda o PR não viaja mais dentro da imagem** Nada muda na sua VPS: nenhum endereço de terceiro foi encontrado no código que
  embarca hoje, e nada foi trocado em produção. O que muda é o portão do
  repositório. A catraca que já barrava o nome antigo do produto — "DeskcommCRM"
  escrito na tela de quem instalou com a marca dele — passou a barrar também
  domínio de terceiro: site pessoal, endereço de teste ou visão de alguém
  enterrado numa parte do código que vai para a imagem. Quando isso acontece, o PR
  é reprovado com o endereço e o arquivo na mensagem. Foi por esse buraco que a
  identificação enviada à OpenRouter levava o endereço pessoal de quem escreveu o
  PR: o consumo de cada instalação ficava creditado a um site que não é o seu nem
  o nosso.

  Crédito: @webtecnica.

- **A marca enviada deixa de sumir da barra lateral quando o banco não responde** Quem sobe o logo da instalação em Configurações › Marca recebe o aviso “Logo atualizado.” e, no render seguinte, o desenho da marca. Se a consulta ao banco falhasse exatamente nesse instante — uma resposta perdida, um pico de carga no banco —, o sistema tratava o silêncio como resposta e guardava “não há marca gravada” por 30 segundos: a barra lateral voltava a desenhar a marca do produto, sem logo, com o arquivo novo já gravado e sem nada na tela dizendo que algo tinha falhado. Agora a leitura que falha vale só para aquela tela: a tela seguinte pergunta ao banco de novo e mostra a marca enviada. Quando o banco responde, nada muda — a marca continua sendo lida uma vez a cada 30 segundos.

- **Material arquivado que ficou marcado no assistente volta para a tela, com o desmarcar a um clique** Arquivar um material do acervo não podia travar o assistente que o tinha marcado — mas travava: o
  acervo chegava na seção já sem os arquivados, o id continuava em `knowledge_source_ids`, e o salvar
  recusava a versão com "um dos materiais marcados não existe mais, ou foi arquivado" sem oferecer
  onde desmarcar. Agora o arquivado **e marcado** aparece na lista com o selo "arquivado no acervo" e
  com o desmarcar a um clique; o arquivado que ninguém marcou continua fora da lista, e arquivado não
  conta como material do assistente em nenhum aviso.

- **Material do tipo documento para de oferecer o editor de perguntas e respostas** Quem cadastrou um documento — uma política de troca, um manual, um contrato — clicava em
  "Editar conteúdo" no cartão dele e caía num editor de pergunta e resposta EM BRANCO, como se
  o material tivesse sido cadastrado vazio. O botão agora nasce do tipo do material: documento
  não guarda pergunta e resposta, então não oferece esse editor. O que ele continua oferecendo
  é preparar de novo, ver o que o agente aprendeu e arquivar.

- **Importar a planilha não perde mais o produto de nome longo** Quando a planilha não trazia a coluna de código, o nome do produto virava o código
  dele, cortado em 60 caracteres. Nome de importado passa disso e difere no fim — 100 ml
  e 200 ml, 128 e 256 GB —, então dois produtos diferentes chegavam com o MESMO código: a
  segunda linha era recusada como "código repetido na planilha", citando um código que
  não existe na planilha, e o produto não entrava no catálogo. Agora o corte leva junto
  uma assinatura curta do nome inteiro, o que mantém os 60 caracteres, continua
  distinguindo, e a reimportação continua atualizando em vez de duplicar.

  O corte também acontecia antes de colapsar os espaços, e um código terminado em espaço
  é uma identidade diferente da que a tela grava: editar esse produto pela tela mudava o
  código dele, e a importação seguinte criava uma segunda linha do mesmo produto. Isso
  acabou junto.

  Se o seu catálogo já tem produto de nome muito longo que entrou pela planilha, o código
  dele passa a terminar com essa assinatura. A próxima importação da mesma planilha cria
  uma linha nova ao lado da antiga, a de código cortado — a antiga pode ser apagada pela
  tela do catálogo. Nada a fazer antes de atualizar.

  Crédito: @webtecnica.

- **A tela de criar agente e alguns avisos de IA voltaram a português mesmo com o idioma em espanhol** O guarda de i18n (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) varre o AST das telas
  atrás de prosa em português fora de `t()`, mas não alcança texto que mora fora da tela — em
  constantes importadas de `lib/`. Quatro pontos escapavam por essa lacuna:

  - Os pacotes de capacidade (Atender e responder, Vender e mover o funil, Não perder o
    cliente, Passar para um humano, Organizar a operação, Aprender e evoluir) na tela de criar
    ou editar agente, e o texto de cada um.
  - O prompt padrão de um agente novo — que também é o `system_prompt` de verdade se ninguém
    editar, por isso em espanhol ele já instrui a IA a responder em espanhol, não em pt-BR.
  - Os seis avisos de erro do cadastro da chave de inteligência artificial (onboarding).
  - No construtor de fluxo de resposta correspondida, duas opções ("Se a informação já
    existir" e as três alternativas dela) que a mesma tela de classificação já traduzia
    corretamente — só esta ficou para trás.

  Corrigido envolvendo cada ponto em `t()`/`useT()` no local de exibição (mesma convenção do
  resto do produto) e completando o dicionário. Nenhum comportamento muda para quem usa
  português.

- **O atendimento para de se desligar sozinho 15 minutos depois de ser ligado** Em Equipe › Atendimento, ligar a chave de um atendente durava
  **cerca de quinze minutos**. Passado esse tempo, o sistema desligava a chave
  sozinho e nada a religava — a pessoa aparecia como offline, deixava de receber conversas novas e
  sumia dos horários oferecidos na Agenda, sem ter feito nada. Quem percebia
  religava, e quinze minutos depois acontecia de novo.

  A causa: uma rotina automática desligava quem não desse "sinal de vida", e esse
  sinal **nunca foi implementado em lugar nenhum do sistema**. Como ninguém o
  emitia, todo atendente era considerado ausente logo depois de se declarar
  disponível — em toda instalação, sempre.

  A rotina foi removida, e a disponibilidade passou a ser calculada na hora:

  - chave **desligada** → indisponível, e ninguém religa por você
  - chave **ligada, sem jornada publicada** → disponível 24 horas por dia
  - chave **ligada, com jornada publicada** → disponível dentro dela, indisponível
    fora — e **volta sozinho** no início do próximo horário

  Essa última linha é a que não existia: a jornada só sabia restringir, nunca
  reativar. Agora a chave é a sua decisão ("eu atendo") e a jornada diz quando —
  sem ninguém precisar ligar nada todo dia.

  A coluna "Status" da tela passa a mostrar três estados em vez de dois:
  **De plantão**, **Fora do horário** e **Desligado**. Antes, quem estava com a chave
  ligada às 22h aparecia igual a quem tinha desligado — e ia procurar defeito onde
  só havia uma jornada que terminou.

  Você não precisa fazer nada para adotar. Se alguém da sua equipe estava
  aparecendo como offline sem explicação, volta ao normal nesta versão.

  Um detalhe que vale conferir na sua equipe: quem fica com a chave ligada e **sem jornada publicada** passa a contar como disponível 24 horas por dia, porque não há horário que o limite. Se não for isso que você quer para alguém, publique a jornada da pessoa em Equipe › Atendimento.

## [1.29.0] — 2026-09-16

### Adicionado

- **O "Novo Lead" do funil passa a escolher o contato** Pelo funil, o "Novo Lead" pedia título, etapa, valor e tags, mas não tinha onde pôr a pessoa: o negócio nascia sem contato, sem telefone e sem ligação com a base de contatos. Quem cadastrava pelo quadro ficava com um card que o WhatsApp não consegue responder e que as automações não conseguem casar com ninguém. A importação de planilha já fazia o certo — procura o contato pelo telefone, reaproveita e cria quando falta —, e as duas telas davam resultados diferentes para a mesma coisa.

  Agora o diálogo abre com um campo **Contato** no topo: procure pelo nome ou pelo telefone, escolha da base ou crie na hora, sem sair da tela. Escolher alguém com o título ainda vazio preenche o título com o nome do contato.

  O contato continua **opcional**: quem abre o card no meio da ligação e completa depois segue conseguindo. Sem contato escolhido, a tela diz o que o lead perde — não recebe WhatsApp nem entra nas automações. Aberto pelo Inbox, que já sabe de quem é a conversa, nada muda.

  Leads sem contato criados antes desta versão continuam como estão; vinculá-los pela tela é a próxima fatia da #852. Crédito: @rafaelbatistazz.

- **A tela de Contatos passa a filtrar quem veio de anúncio** A lista de Contatos oferecia filtrar por Manual, WhatsApp, Nuvemshop e Importado (CSV). Quem chegou por um clique em anúncio — do Meta ou do Google — ficava gravado com essa origem no sistema e não aparecia em filtro nenhum: para encontrá-lo era preciso abrir contato por contato. Agora as duas origens de anúncio estão na mesma lista de filtros, em português e em espanhol.

- **Dá para digitar o identificador do modelo quando o provedor não tem catálogo** Na tela do agente, o campo Modelo só oferecia uma lista. Quando o provedor escolhido não devolve catálogo — é o caso de quem usa um serviço compatível, um gateway próprio ou um modelo que acabou de sair —, a lista aparecia vazia e não havia como seguir: o agente ficava sem modelo, mesmo com a chave certa cadastrada. Agora, quando não há catálogo para aquele provedor, o campo vira um campo de digitação e aceita o identificador do modelo exatamente como o serviço o nomeia. Com catálogo, nada muda: a lista continua sendo a lista.

- **Áudio pode ser transcrito em outro serviço compatível, sem trocar a chave da conversa** Quem quiser transcrever áudio num serviço diferente do padrão — Groq, um Whisper próprio, qualquer endereço com o mesmo formato de transcrição da OpenAI — agora preenche `TRANSCRIPTION_API_KEY` no `.env`, e opcionalmente `TRANSCRIPTION_BASE_URL` (o endereço do serviço) e `TRANSCRIPTION_MODEL` (o modelo de transcrição). A chave vale só para a transcrição: a conversa com o cliente e a leitura de imagem continuam usando o provedor que já está configurado. Sem essas variáveis, nada muda — a transcrição segue usando a chave da OpenAI, e se ela também não existir, o comportamento é o de hoje, com o aviso na Central e a orientação para cadastrar a chave.

### Corrigido

- **Um aviso de atualização antiga que falhou não trava mais o botão de atualizar** Quando uma atualização feita pela tela falhava e o sistema voltava sozinho para
  a versão anterior, a tela de Atualização passava a mostrar "A atualização para a
  versão … não deu certo", sem o botão de atualizar. Se depois alguém atualizasse
  por outro caminho (o `update.sh` no terminal, por exemplo), o sistema subia
  normalmente, mas o aviso antigo continuava ali. Quando saía uma versão nova, a
  tela mostrava de novo a falha de dias atrás e não oferecia o botão, e o único
  jeito de sair desse aviso era justamente clicar nele. Isso foi medido numa
  instalação real: uma falha de 13/09 impedia atualizar para a 1.27.2 pela tela em
  15/09, com a 1.23.0 já no ar desde 14/09.

  Agora, quando o servidor informa uma versão diferente das duas envolvidas na
  tentativa que falhou, a tela entende que a falha foi superada e volta a oferecer
  a atualização normalmente. Uma falha que ainda é o estado atual do servidor
  continua sendo mostrada como antes, com o comando para voltar.

- **Automação com condição de tag passa a funcionar quando a caixa difere** Numa automação, a condição sobre tags só disparava quando o texto digitado era idêntico à tag, maiúsculas incluídas: a regra escrita para "Google" não rodava para a tag "google", que é exatamente como o Inbox grava toda tag de contato. A regra existia, aparecia ativa na tela e nunca acontecia. Agora a condição compara a tag inteira sem diferenciar maiúsculas — "Google" pega "google" e continua não pegando "Google Ads", que é outra tag. Nada que funcionava antes deixa de funcionar, e nenhuma regra passa a alcançar quem não alcançava. Na tela de regras, o operador desses campos passa a se chamar "tem a tag", que é o que ele faz.

- **Automação por tag do contato deixa de criar lead repetido** Uma regra com gatilho "quando um contato ganhar uma tag" e ação "criar/mover lead no funil" criava um negócio novo toda vez que rodava, mesmo quando o contato já tinha um negócio aberto naquele funil — o contato acabava com vários leads iguais. E as ações seguintes da mesma regra, como "atribuir a um atendente", ficavam sem lead para agir, então a execução aparecia como "Parcial" na aba Atividade. Agora a automação move o negócio que o contato já tem no funil de destino, cria só quando não existe nenhum, e as ações seguintes passam a agir sobre esse lead. Leads criados em duplicidade antes desta versão continuam onde estão. Uma consequência que vale saber: numa regra assim, a ação "adicionar tag" que vier depois passa a etiquetar o NEGÓCIO, não mais o contato — é o efeito de as ações seguintes enxergarem o lead. Crédito: @rafaelbatistazz.

- **Contato que veio de anúncio da Meta pelo número oficial passa a ter a origem do anúncio** Quem clicava num anúncio "Clique para o WhatsApp" e caía num número conectado pela API oficial da Meta ficava com a origem "whatsapp", como se tivesse escrito por conta própria. O anúncio de onde a pessoa veio não era gravado, e a venda desse contato não podia ser devolvida à Meta como conversão. Agora a origem passa a ser o anúncio da Meta, com o clique e o título do anúncio, como o canal intermediado já fazia. Vale para os cliques a partir desta versão: a Meta só envia esses dados na primeira mensagem, então os contatos que já entraram continuam como estão. Crédito: @rafaelbatistazz.

- **O CI volta a medir a instalação em PostgreSQL 17, além do 15** Nada muda na sua VPS: nenhuma variável nova, nenhuma migration, nenhuma imagem. O que muda é o que o pipeline mede antes de a release sair — o gate de banco do CI voltou a rodar nas duas majors do PostgreSQL (15 e 17) e passou a exercitar também o `update.sh` sobre um banco COM DADOS, que é o caso da sua instalação e não o de um banco vazio. Crédito: @webtecnica.

- **A spec do inbox em tempo real volta a medir o que conserta o canal, e não só a tela** Nada muda na sua VPS: nenhuma migration, nenhuma variável, nenhuma imagem. O que muda é o que o teste mede. A spec do inbox em tempo real olhava só a saída — o texto na tela, que chega por dois caminhos por causa do `refetchOnWindowFocus` — e por isso ficava verde com o canal de tempo real mudo. Agora ela assere o que trafega no socket (`phx_join` autenticado e o `postgres_changes` com o corpo da mensagem) e reprova quando o conserto do #327 não está no bundle. Crédito: @webtecnica.

- **A hora na linha da Fila passa a ser a do tempo de espera** Na aba Fila a lista ordena por quem espera resposta há mais tempo, mas a hora mostrada à direita de cada linha era a da última mensagem de qualquer lado: responder uma conversa fazia o horário dela pular para agora sem que ela saísse do lugar, e a coluna de horas saía fora de ordem. Agora a hora na Fila é a da última mensagem do cliente — a mesma que ordena a lista e a mesma que a pílula "Aguardando há…" já usava. Nas demais abas nada muda, e a ordem da Fila continua por tempo de espera, agora com teste que a prende. Crédito: @webtecnica.

- **A resposta da IA não aparece mais duplicada depois de o WhatsApp reconectar** Quando o WhatsApp caía e voltava, as respostas da IA que tinham ficado esperando
  eram reenviadas sozinhas — e a mesma frase podia aparecer duas vezes na conversa.
  O reenvio automático era o único caminho que não apagava a cópia criada pelo eco
  do WhatsApp. Agora ele apaga, do mesmo jeito que o envio normal já fazia.

  Quem usa o motor WEBJS tinha um problema pior no mesmo caminho: a mensagem podia
  ficar presa e ser mandada ao cliente de novo a cada minuto. Isso também foi
  corrigido.

- **Mídia recebida volta a usar o endereço do provedor configurado no ponto** Quando um ponto de IA era apontado para um serviço compatível — um endereço que não é o oficial do provedor, como um gateway interno —, o atendimento pelo chat funcionava, mas as imagens que os clientes enviavam continuavam sendo descritas pelo endereço oficial, e falhavam, porque a chave era daquele outro serviço. A leitura de mídia agora pega o endereço cadastrado no mesmo lugar em que o chat pega, então imagem e conversa usam o mesmo provedor. Quem nunca cadastrou endereço próprio não percebe diferença: vale o padrão do provedor, como antes. A transcrição de áudio não era afetada por este caminho.

  Duas recusas passam a existir nesse caminho, e as duas abrem aviso na Central em vez de falharem em silêncio: se o endereço cadastrado apontar para dentro do próprio servidor (endereço local, rede interna do Docker, metadados da nuvem), a imagem e a chave não saem para lá; e se a empresa tiver endereço próprio cadastrado mas estiver usando a chave de IA da instalação, a leitura é recusada com a instrução de cadastrar a chave da empresa — a chave que paga a conta da instalação inteira não viaja para um endereço escolhido por uma das empresas.

- **O worker passa a dizer se o laço do event_log carregou, e a publicação exige isso antes de marcar stable** Nada muda na sua VPS: nenhuma migration, nenhuma variável, nenhum comando. O `/healthz` do worker passa a publicar um campo a mais (`event_log_drain`, com o motivo quando o laço não carregou) e a falha ao carregar o laço deixa de ser um aviso de rotina para ser erro — era o aviso que fazia um drain parado parecer normal, e foi assim que a fila do `event_log` ficou dez dias sem drenar com o worker respondendo saudável. Do lado da publicação, o CI passa a executar as imagens do worker e do scheduler antes de publicá-las: worker que não sobe ou laço que não carrega não vira a versão `stable` de quem self-hospeda. Crédito: @webtecnica.

- **No Inbox, o botão de tags diz que a tag é do contato** No painel lateral do Inbox, o botão que abre as tags do contato dizia apenas "Tag", enquanto logo abaixo, no mesmo painel, fica a seção "Tags da conversa". Os dois lugares guardam tags diferentes, e quem atende não sabia em qual estava mexendo. Agora o botão se chama "Tags do contato". Nada muda no comportamento. Crédito: @rafaelbatistazz.

- **O provisionamento do Supabase lê as chaves em qualquer ordem e não perde mais a senha do banco** Na instalação, o passo que busca as chaves de API do projeto novo lia a resposta
  da Management API por POSIÇÃO: procurava `anon` e, só no que vinha depois dela,
  `api_key`. Quando a API do Supabase passou a devolver `api_key` antes de `name`,
  a leitura passou a voltar vazia e a instalação morria no passo 5 com "Não
  consegui ler anon/service_role" — num projeto que já estava criado e de pé. A
  leitura agora é por objeto, e a ordem dos campos deixou de importar.

  O estrago maior era o outro lado. A senha do banco é gerada no começo e a API
  não a devolve depois, então quem morria no passo 5 ficava com um projeto
  ocupando uma das duas vagas do plano grátis e sem a credencial à mão. A senha
  passa a ser gravada em `.env.supabase-provision` (só leitura pelo dono, 600)
  antes de o projeto ser criado; quando um passo falha, a mensagem diz onde ela
  está; e uma segunda tentativa reaproveita a mesma senha em vez de gerar outra.

## [1.28.0] — 2026-09-16

### Adicionado

- **O CRM pode reconhecer quem já é cliente pela agenda** Nova regra em Configurações › Tipos de agendamento, desligada em toda organização: quando um administrador liga “Clientes pela agenda”, todo contato com horário marcado ganha a etiqueta “cliente” e a data de “Cliente desde” na ficha — a data do primeiro horário que conta — o dia em que se combinou, ou o dia do atendimento quando ele for mais antigo —, nunca uma data futura —, e quem já tinha horário marcado ganha na hora de ligar. Horário cancelado, falta e horário apagado não contam: se não sobrar nenhum, sai a etiqueta que o sistema pôs, e a que a equipe pôs à mão fica. Se alguém da equipe tirar a etiqueta, ela não volta — e a etiqueta que a equipe puser à mão o sistema nunca tira. As automações “Quando um contato ganhar uma tag” disparam uma vez por contato, na primeira vez que o sistema acrescenta a etiqueta: não disparam para quem já era cliente ao ligar, para quem já tinha a etiqueta posta à mão, nem de novo para quem cancela e marca outra vez, nem ao juntar contatos duplicados. Com a regra ligada, a tela de Funis permite marcar um “funil de clientes”, onde abre o negócio de quem já é cliente e volta a escrever. Atualizar não muda nada em organização nenhuma até alguém ligar a regra. Contribuição de @423313 (PR #867).

### Corrigido

- **O nome do compromisso pessoal da agenda do Google deixa de ficar ao alcance dos colegas** Quem conecta a agenda pessoal do Google ao CRM costuma fazer isso só para os horários ocupados contarem na agenda da equipe. A tela nunca mostrou o nome desses compromissos, mas a permissão do banco deixava qualquer pessoa da organização, inclusive com acesso somente leitura, consultá-lo diretamente com o próprio login.

  Na prática, só havia nome para ler em agendas sincronizadas antes da versão 1.17.0. Desde ela, o serviço que sincroniza com o Google guarda só o horário, sem o nome, e apaga o nome que encontra quando atualiza o evento. O que sobra são compromissos gravados antes disso e que a sincronização não voltou a atualizar: os que já passaram, os cancelados, e os de agendas que ela deixou de ler — desmarcadas, removidas da conta do Google, de quem saiu da equipe ou com a conexão caída. Eles ficam até a limpeza automática removê-los, por padrão 90 dias depois de terminarem.

  Agora nenhum login de usuário lê esse nome — nem os colegas, nem a própria pessoa que conectou a agenda, já que nenhuma tela o exibia. Os horários ocupados continuam contando exatamente como antes. Esta versão não apaga os nomes que sobraram: ela fecha a leitura.

  Continua ao alcance de qualquer pessoa da organização o identificador de cada agenda sincronizada — que, na agenda principal do Google, é o e-mail da conta conectada. Dá para fechar isso sem mudar nenhuma tela — limitando a leitura dessas linhas a quem conectou a agenda e a quem gerencia a equipe, que já vê essa conta —, mas isso muda quem enxerga o quê e não entra nesta correção.

## [1.27.3] — 2026-09-15

### Corrigido

- **O áudio da chamada de voz sai e chega, e o painel some quando a ligação acaba** Quem ligava pelo CRM com o sistema aberto em mais de uma aba, ou em mais de um
  computador, ficava com a ligação muda dos dois lados: cada aba abria o próprio
  áudio, o serviço de voz ficava só com a última, e ela podia ser a aba que
  ninguém estava olhando. Agora o áudio abre só na aba onde você clicou em
  "Chamar" ou "Atender", já no clique. As outras abas avisam que o áudio está em
  outra aba e oferecem trazer para ela.

  Consertos que vinham junto:

  - Quando o cliente desligava, o painel da ligação podia continuar na tela, com
    o botão de encerrar ativo. Agora ele confere com o servidor e some sozinho.
  - O aviso de áudio passou a separar "o áudio não abriu" de "o áudio caiu", cada
    um com um botão para tentar de novo.
  - Clicar duas vezes em encerrar deixou de registrar dois encerramentos, e
    encerrar uma ligação que já tinha acabado não registra mais nada.
  - O canal que atualiza a tela em tempo real voltava de uma queda e, pouco
    depois, caía de novo sozinho. Isso afetava também a caixa de entrada.

## [1.27.2] — 2026-09-15

### Corrigido

- **A chamada de voz pelo WhatsApp liga de verdade depois de parear** Quem pareava o número de chamada de voz e clicava em "Chamar" recebia "Não foi
  possível completar a chamada. Tente novamente em instantes." e continuava
  recebendo, mesmo com o número pareado, até alguém reiniciar o serviço de voz. O
  pareamento pedia ao serviço para "re-parear" logo depois de criar a sessão, e
  isso deixava a ligação presa a uma conexão já descartada. Agora o pareamento
  cria a sessão uma vez só, e o código QR chega do mesmo jeito.

  Consertos que vinham no mesmo caminho:

  - Celulares brasileiros que o WhatsApp registrou sem o nono dígito eram
    discados com ele, e o telefone do outro lado nunca tocava: a tela ficava em
    "Chamando…" até desistir. O CRM agora pergunta ao WhatsApp qual é o número
    registrado antes de ligar.
  - A ligação feita pelo CRM era registrada como recebida. A que o cliente não
    atendia virava um aviso de "chamada perdida" na Central, pedindo para ligar
    de volta a quem você acabou de ligar. Agora ela aparece na linha do tempo
    como "Chamada de voz sem resposta", sem aviso.
  - Ao começar a ligação, a tela às vezes mostrava um erro enquanto o telefone
    do outro lado já tocava, e o painel da ligação podia sumir.
  - Desvincular o aparelho pelo celular deixava a tela dizendo "pareado" para
    sempre. Agora ela volta a "não pareado" e dá para parear de novo.
  - Clicar em "Parear" de novo, com o aparelho recém-vinculado e a tela ainda
    desatualizada, podia desconectar o aparelho. Agora o CRM confere com o
    serviço de voz antes de apagar qualquer coisa.
  - Desconectar o número quando o serviço de voz já tinha perdido a sessão dava
    erro sem fim. Agora desconecta.
  - O código QR que vencia continuava na tela sem funcionar. Agora a tela avisa
    que venceu e libera o botão para gerar outro.

## [1.27.1] — 2026-09-15

### Corrigido

- **O dia bloqueado também vale para o horário da noite** Em agendas com fuso diferente de UTC — no Brasil, os horários da noite —, a folga ou o feriado cadastrado para um dia não barrava o horário perto da virada: a lista de horários livres o oferecia, e a IA conseguia marcá-lo. As exceções de data passam a ser buscadas pelo dia local da jornada, e não pelo dia UTC do horário pedido — o mesmo dia que a lista de horários pergunta. A tela, a IA e a conferência da marcação feita pela IA usam a mesma leitura, então mudam juntas. O encaixe que uma pessoa marca fora da lista continua dispensando a exceção de data, como antes.

- **A ocupação do Google Agenda vale para quem marca na agenda de outra pessoa** Um Atendente que marca na agenda de outra pessoa passa a conferir a ocupação contra o Google Agenda dela, e não só contra os compromissos do sistema. Antes, a conexão de Google do dono não era visível para o Atendente, e com ela sumiam os compromissos pessoais do dono: a lista de horários livres os oferecia e a marcação era aceita por cima deles, tanto no horário da lista quanto no encaixe fora dela. A tela e a recusa dizem só ocupado ou livre; para conferir, o sistema lê o início e o fim de cada compromisso do Google de quem atende, nunca o título ou o conteúdo do evento. A grade da agenda ainda não desenha esses compromissos para o Atendente; quando ele escolhe um desses horários, a recusa avisa que o horário já está ocupado na agenda de quem atende.

## [1.27.0] — 2026-09-15

### Adicionado

- **Processamento que para de tentar agora aparece na Central de avisos** Quando um processamento em segundo plano falha cinco vezes e o sistema desiste dele — ler uma foto ou um áudio que o cliente mandou, rodar uma automação, preparar um material da base de conhecimento, ou fazer a IA responder uma mensagem de cliente —, a Central de avisos passa a receber um alerta crítico com o tipo do processamento e o motivo da falha. Antes isso acontecia em silêncio: o efeito não ocorria e nada indicava o problema em nenhuma tela. Quando o que não aconteceu foi a resposta da IA, o aviso tem título próprio ("A IA deixou de responder uma mensagem de cliente") e orienta a responder pelo Inbox. Para uma pane não inundar a Central, cada organização tem no máximo dois desses avisos abertos por vez — um para a IA que deixou de responder e um para os demais processamentos —, e um não esconde o outro: o aviso aberto de uma foto que não pôde ser lida não impede o da IA de aparecer. Depois de corrigir a causa, marque o aviso como resolvido para voltar a ser avisado.

### Alterado

- **Três índices redundantes saem do banco** O banco mantinha três índices cujo trabalho já era feito por outro índice da mesma tabela. Eles cobravam o preço em toda gravação e ocupavam espaço em disco. Foram removidos na atualização. As buscas que os usavam continuam atendidas por índice — o maior, da mesma tabela — e nenhuma proteção contra duplicidade foi perdida.

### Corrigido

- **Automações da Agenda voltam a disparar quando alguém marca ou confirma pela tela** Quando uma pessoa da equipe marcava, confirmava, remarcava ou cancelava um compromisso pela tela da Agenda, o compromisso era gravado normalmente, mas as automações ligadas a esses momentos — por exemplo "quando um agendamento for confirmado, avise o cliente" — não rodavam. O aviso para as regras era recusado pelo banco sem nada aparecer na tela. Agora ele é registrado pelo mesmo caminho que o resto do sistema usa, e as regras da Agenda disparam também para o que é feito pela equipe. Os compromissos marcados pelo assistente de IA não eram afetados.

- **O registro de auditoria não pode mais ser alterado nem apagado pela chave de serviço** Num projeto Supabase, a tabela de auditoria herdava do próprio Supabase a permissão de alterar, apagar e esvaziar registros — inclusive pela chave de serviço, que ignora as regras de acesso por organização. Na prática, quem tivesse essa chave conseguia apagar ou reescrever um registro escolhido da auditoria. Essas permissões foram removidas: a auditoria agora só recebe registros novos e é lida. A limpeza legítima, que apaga apenas registros mais antigos que o prazo de retenção configurado, continua funcionando como antes.

- **A falha ao atualizar a conversa depois de uma mensagem passa a ficar registrada nos três canais** Quando uma mensagem é gravada e a atualização da conversa falha logo em seguida, a mensagem existe, mas a conversa não sobe na lista do Inbox e, no canal oficial, a janela de resposta de 24 horas não abre. No canal oficial essa falha não era registrada em lugar nenhum; no canal intermediado ficava só no log do servidor, que se perde quando ele reinicia. Agora os três canais gravam a ocorrência no registro de eventos do banco, com a conversa, o sentido da mensagem e o motivo. Nenhuma tela mostra esse registro ainda: ele serve para quem investiga uma conversa que ficou para trás. O texto da mensagem do cliente não é copiado para ele.

- **Foto ou áudio que o provedor de IA recusou passa a abrir aviso na Central** O aviso "O agente não conseguiu ler uma foto ou áudio que o cliente enviou" já aparecia na Central quando o modelo escolhido não enxerga imagens, quando o provedor não está disponível nesta instalação ou quando falta a chave para transcrever áudio. Quando a falha vinha da própria chamada ao provedor — chave recusada, modelo que a conta não pode usar, tempo esgotado — ou do download do arquivo, o sistema tentava cinco vezes e desistia sem avisar ninguém. Agora essa desistência abre o mesmo aviso, com a frase de erro do provedor, que diferencia chave errada de modelo não liberado. No mesmo momento a Central recebe também o aviso de processamento que parou de tentar, se não houver um desses já aberto; numa pane, fica no máximo um de cada aberto por organização. Esses avisos não escondem o de que a IA deixou de responder um cliente, que abre por conta própria.

## [1.26.0] — 2026-09-15

### Adicionado

- **Quem opera a agenda agora pode confirmar um pedido de horário pela tela** Na agenda, a aba "Aguardando confirmação" e o painel de detalhe do compromisso ganharam o botão Confirmar. Em negócios que exigem aprovação de cada horário, o pedido que o assistente reservou só virava compromisso se o cliente respondesse no WhatsApp — caso contrário o prazo vencia e a reserva era cancelada automaticamente. Agora a decisão pode ser tomada por quem atende, com um clique.

- **O App da Meta passa a ser cadastrado pela tela de administração, sem editar o servidor** Para receber mensagens pelo número oficial da Meta, era preciso abrir o arquivo de configuração do servidor e escrever lá a chave secreta do aplicativo e um código de confirmação inventado por quem instalou.

  Agora quem administra a instalação faz isso em **Admin › API Oficial (Meta)**: cola a chave secreta do aplicativo e o sistema gera sozinho o token de verificação, mostrado uma única vez, pronto para copiar para o painel da Meta. A chave fica guardada cifrada e nunca volta a aparecer. Se o token se perder, dá para gerar outro na mesma tela — ela avisa antes que o novo precisa ser colado na Meta.

  A tela de Conexões e o primeiro acesso passam a apontar para esse lugar, em vez de mandar configurar o servidor.

  Você não precisa fazer nada. Quem já tem a chave e o token no arquivo de configuração continua funcionando como está: o arquivo segue valendo como reserva, e só deixa de ser usado quando alguém salvar pela tela.

  A guarda da credencial na instalação é contribuição de @webtecnica.

- **A agenda aceita encaixe fora da grade quando quem marca é da equipe** O sistema oferece horários numa grade fixa: a partir do começo de cada faixa do
  expediente, de duração em duração. Isso vale para o que o assistente oferece ao
  cliente — mas quem atende precisa poder marcar o que combinou por fora dela: o
  cliente que só pode 10:30, o encaixe, o atendimento que começa mais cedo.

  Antes, o servidor recusava todo horário fora da grade, viesse de quem viesse, e a
  saída era mudar o horário do cliente para caber numa régua interna.

  Agora, quando quem marca é **uma pessoa da equipe logada no sistema**, o servidor
  aceita horário fora da grade, até fora do expediente, desde que o responsável já
  tenha publicado seus horários de atendimento.

  Na tela, isso fica em **Agenda › Novo agendamento**: depois de escolher o dia, abaixo
  dos horários dele aparece **"Outro horário"**. A pessoa digita a hora e segue para a
  mesma confirmação de sempre. O dia sem nenhum horário publicado (um domingo, por
  exemplo) também pode ser escolhido — de hoje em diante, nos meses que o calendário
  do painel deixa abrir —, e ali o campo de hora já abre direto. A hora digitada vale
  no fuso que o painel mostra ("Horários no fuso …"). **Remarcar**, na lista de
  compromissos, abre o mesmo painel e tem a mesma opção.

  "Outro horário" não aparece para quem tem o papel **Somente leitura**, que não pode
  marcar, nem enquanto o responsável não publicou seus horários. Clicar num horário
  vazio da grade e arrastar um compromisso continuam oferecendo só os horários da
  grade.

  O assistente e as integrações por token não ganham o encaixe: para eles o horário
  continua tendo de ser um da grade do expediente, respeitando a antecedência mínima
  e a janela de reserva do tipo.

  Para os dois, o sistema recusa marcar em cima de outro agendamento do mesmo
  responsável (cancelado ou falta não contam), ou de um evento do Google Agenda dele
  numa agenda marcada como "Conta como ocupado" (evento marcado como "Disponível" no
  Google não conta). Quando a recusa acontece pelo painel, o motivo aparece logo acima
  do botão Confirmar, o painel continua aberto e, no encaixe, a hora digitada continua
  no campo. A conferência do Google tem dois limites.

  O primeiro: ela só conhece o que a sincronização já trouxe, que vai de um dia atrás
  até cerca de 90 dias à frente. Marcar depois desse período, ou em cima de um evento
  criado no Google e ainda não sincronizado, passa. Para períodos fora da
  sincronização, a tela de horários avisa "Ocupação do Google ainda não verificada
  neste período."

  O segundo: uma pessoa com papel de Atendente, marcando na agenda de outra pessoa,
  não enxerga o Google Agenda dela, e a marcação passa. O próprio responsável,
  gerentes e administradores enxergam.

### Alterado

- **A versão da Graph API passa a morar num lugar só** A versão da Graph API com que a instalação fala (hoje `v22.0`) deixa de estar copiada à mão em dez arquivos de produção e passa a viver num só, com uma catraca que reprova a suíte se alguém escrever a versão à mão em qualquer outro arquivo. Nada muda para quem opera: a instalação continua falando `v22.0`, e `META_GRAPH_VERSION` continua mandando quando existe — inclusive quando ela está preenchida com espaço ou vazia, que antes virava URL sem versão. O que muda é o dia do bump: subir de versão passa a ser uma edição deliberada num arquivo, em vez de dez edições com uma esquecível.

  Crédito: @webtecnica.

### Corrigido

- **Sincronizar modelos e enviar modelo usam a credencial salva na tela do canal** O envio de texto do canal oficial já resolvia a credencial da conexão (sessão primeiro, ambiente como reserva). O caminho do MODELO não: tanto o POST de `/api/v1/channels/templates` quanto o envio de modelo liam `META_SYSTEM_USER_TOKEN` e `META_PHONE_NUMBER_ID` do `.env`. Numa instalação que conectou o número pela tela, "Sincronizar modelos" respondia **400 `missing_meta_token`** para quem tinha a credencial salva e visível na própria tela, e o segundo número oficial da instalação não sincronizava nem enviava um modelo — logo o modelo, que é o que a janela fechada exige.

  Agora os dois caminhos resolvem pela sessão, com o ambiente só como reserva, pela mesma porta que o resto do canal usa. A ordem dos desfechos não muda: sem canal oficial a resposta continua `no_meta_channel`, e sem credencial nenhuma (nem na sessão, nem no ambiente) continua `missing_meta_token` e o envio segue o desfecho de "canal não conectado" (`meta_not_configured`, recuperável) em vez de virar falha.

  Nada muda para quem só tem o ambiente: a instalação continua sincronizando e enviando pelo `.env` como antes.

- **O botão Confirmar do painel de marcação volta a aparecer em telas de notebook** Em telas de notebook comuns, o painel de **Agenda › Novo agendamento** (e o de
  **Remarcar**) cortava a parte de baixo sem mostrar barra de rolagem. Depois de
  escolher o horário, o botão **Confirmar** ficava fora da área visível: inteiro
  escondido em 1280×800 e 1366×768, e cortado ao meio em 1440×900. Não havia como
  clicar nele com o mouse.

  Agora a coluna do calendário rola por conta própria quando não cabe, e escolher um
  horário leva a confirmação até a vista. O contexto à esquerda e a lista de horários
  à direita ficam parados, e em telas grandes e no celular nada muda.

- **Cadastrar um contato com telefone já usado explica o motivo, em vez de "Erro interno"** Criar pela tela um contato cujo telefone já pertencia a outro contato da mesma organização
  terminava num aviso de "Erro interno. Tente de novo em instantes." — e tentar de novo dava o
  mesmo erro, porque não havia nada de errado com o servidor: o telefone já estava em uso.

  Agora o aviso diz o que aconteceu: "Já existe um contato com este telefone." (em espanhol,
  "Ya existe un contacto con este teléfono."). O cadastro continua recusado, como antes; o que
  muda é a explicação.

  Por baixo, a resposta de `POST /api/v1/contacts` passou de 500 para 409, com o código
  `contact_exists` e o id do contato que já usa o telefone em `details.contact_id`. Por
  enquanto nenhuma tela usa esse id — ela só mostra a frase —, e essa rota aceita apenas a
  sessão de quem está logado, não token de integração. O e-mail e o CPF também não podem se
  repetir nessa tabela, e o 409 só sai quando já existe um contato ativo com aquele telefone:
  qualquer outra recusa continua como antes.

  Você não precisa fazer nada.

  Achado e corrigido por @webtecnica.

## [1.25.1] — 2026-09-15

### Corrigido

- **A agenda para de chamar de falha do servidor o erro de quem chamou errado** A listagem da agenda respondia "erro do servidor" para toda recusa que não fosse
  "falta um recorte". O caso que apareceu na prática é o id de um CONTATO enviado
  no lugar do id de um negócio — a mesma troca que a #509 mediu. A consulta era
  recusada corretamente, mas a resposta dizia que o problema era do servidor: a
  tela tratava como falha nossa, e o monitoramento de erros contava como incidente
  uma requisição que só estava com o parâmetro trocado.

  Agora essa recusa sai como erro de quem chamou, com um código próprio que diz que
  o id mandado não é um negócio do funil e que a correção é usar o do contato. O
  "erro do servidor" fica reservado para o que é falha de verdade, com teste que
  atravessa a rota para separar os dois.

  Você não precisa fazer nada.

  Achado e corrigido por @webtecnica.

- **Atualizar o CRM deixa de desligar os lembretes** Toda atualização desligava o lembrete de todos os tipos de agendamento em que
  alguém o tinha ligado. Sem erro e sem aviso: a tela mostrava o controle
  desmarcado como se ninguém o tivesse marcado, e o cliente deixava de receber o
  aviso do compromisso.

  A correção de histórico que fazia isso era certa quando foi escrita, numa época
  em que nada lia esse campo — só que ela voltava a ser aplicada a cada
  atualização, e o disparador nasceu no meio do caminho. Agora ela roda uma vez
  por banco e para de reescrever a sua escolha.

  **Se você já usou lembretes, confira se continuam ligados** em Configurações ›
  Agenda, no campo "Avisar o cliente antes do compromisso". Uma atualização
  anterior pode tê-los desligado, e esta versão não religa sozinha: religar por
  conta própria mandaria mensagem para clientes de quem desligou de propósito.

- **A IA deixa de afirmar o tamanho de um catálogo que não mediu** Quando a varredura do catálogo era cortada e a loja não informava o total, a resposta ao
  cliente saía com o número `null` no meio da frase — o agente dizia "o catálogo desta loja
  tem null". Era uma afirmação sobre um tamanho que ninguém mediu, justamente no lugar onde a
  regra é declarar a dúvida.

  O mesmo valia para a lista vazia: "não encontrei" podia ser ouvido como "a loja não tem",
  quando o que houve foi uma varredura que não chegou ao fim. Lista vazia só é ausência quando
  a varredura terminou.

  Agora o tamanho medido continua sendo dito — é ele que explica o corte a quem opera — e o que
  não foi medido é dito como desconhecido. Nada muda no que o operador precisa fazer: as mesmas
  ferramentas respondem, e a regra de não afirmar ausência sem varredura completa já valia.

- **Três mensagens seguidas deixam de virar três negócios** Quando alguém escrevia várias mensagens em sequência — "oi", "tudo bem?",
  "queria marcar" —, cada uma podia abrir um negócio novo no funil. O mesmo
  cliente aparecia duas ou três vezes, tudo no mesmo minuto, e quem organiza a
  fila tinha que limpar à mão.

  Agora a entrada é serializada por cliente: a segunda mensagem encontra o card
  que a primeira criou, em vez de criar outro.

  Continua possível ter mais de um negócio aberto para o mesmo cliente quando é
  você quem cria — o que mudou vale só para o card que o sistema abre sozinho.

- **Integração com token de servidor volta a conseguir escrever** Um token de servidor sem escopo de agente era tratado como se fosse uma pessoa
  logada, e o sistema tentava anotar o token como "quem fez". O banco recusava,
  porque token não é gente — então mandar mensagem ou marcar compromisso por
  token respondia **erro interno**, sem pista do motivo.

  Agora o token é reconhecido como integração, e essas escritas voltam a
  funcionar. Se você tem um sistema ligado por token, três coisas passam a valer
  para ele junto com isso:

  **O envio por token respeita o modo de teste do canal.** Enquanto o número
  estiver em teste, só os números da lista de teste recebem; para os outros a
  mensagem fica como falha, com o motivo "modo de teste do canal". É a mesma
  regra que já valia para a IA e para as automações. Para liberar, abra
  "Configurar acesso da IA" no número, em Conexões, e deixe-o como "IA aberta ao
  público".

  **Comparecimento e falta continuam sendo registrados pela equipe.** Por token, a
  API recusa com o pedido de confirmação humana na Agenda, em vez de devolver um
  erro genérico.

  **Mensagem enviada por token não pausa a IA** na conversa, ao contrário da
  resposta de um atendente pela tela.

  Token de agente de IA nunca foi afetado, e continua igual.

## [1.25.0] — 2026-09-15

### Adicionado

- **O aniversário do contato pode disparar uma automação** A data de nascimento já aparecia na ficha do contato e não acionava nada: para
  parabenizar alguém era preciso descobrir sozinho quem fazia aniversário.

  Em Automações, o gatilho "No aniversário de um contato" já pode ser escolhido, e
  a ação de mandar WhatsApp é a mesma das outras regras. A mensagem sai às 9h no
  fuso da organização, uma vez por pessoa, e só para quem configurou a regra.

- **A instalação pode aceitar só quem foi convidado** Em **Admin › Cadastro** há um interruptor novo: **cadastro apenas por convite**. Ligado, `/signup` deixa de aceitar quem chega sem convite — e quem chega com um convite válido entra igual.

  **Nada muda para quem não ligar.** O padrão é o comportamento de sempre: qualquer pessoa cria conta e abre a própria empresa. Instalações que já existem não precisam fazer nada.

  **Por que isto é do produto, e não do proxy.** Fechar `/signup` no nginx era a única saída até aqui, e ela erra por construção: proxy não sabe o que é um convite. Medido numa instalação real em 2026-09-10 — a regra que bloqueava `/signup` bloqueou junto o `/signup?invite=…`, ou seja, exatamente quem deveria passar, e o convidado ficou sem conseguir entrar.

  **A recusa tem tela.** Quem abre o cadastro sem convite numa instalação fechada vê uma página com a marca e o idioma da instalação, explicando que o acesso é por convite e oferecendo o login — não um `403 Forbidden` cru do servidor.

  **Fecha nas quatro portas, não só na tela.** A tela é adulterável e a server action é chamável direto, então a recusa acontece também em `signUp()`, em `/auth/confirm` (que é quem provisiona a organização, e pega inclusive conta nascida fora da tela) e na recuperação de organização. Uma porta só seria outro capacho.

  **Se o banco parar de responder, a instalação fechada continua fechada.** A leitura guarda o último valor conhecido em vez de cair no padrão — senão um soluço do banco reabriria o cadastro sem ninguém ver. E instalação que ainda não aplicou esta versão do schema continua aberta, como sempre esteve.

- **Automação externa agora consegue abrir a primeira conversa com um cliente novo** Até aqui, uma automação de prospecção (por exemplo, um fluxo que acabou de captar um lead) não
  tinha como abrir a primeira conversa com esse cliente pela chave de integração: só dava para
  mandar mensagem numa conversa que já existia. Agora existe uma nova capacidade de integração
  ("Iniciar conversa com cliente novo e enviar mensagem") que cadastra o cliente se precisar, abre
  a conversa no número de WhatsApp escolhido — o próprio fluxo decide qual, em vez de o sistema
  escolher sozinho — e manda a primeira mensagem. Crédito: @hamiltonviana.

- **O lembrete de compromisso pode avisar mais de uma vez** Um tipo de agendamento tinha um lembrete só. Quem queria avisar o cliente com um
  dia de antecedência **e de novo poucas horas antes** não tinha como: ligar o
  segundo aviso exigiria apagar o primeiro.

  Em Configurações › Agenda, cada tipo ganhou o campo "E de novo, quantos minutos
  antes", que aceita até três avisos adicionais. Vazio é o comportamento de
  sempre, um lembrete só — nada muda para quem não mexer no campo.

### Corrigido

- **O acompanhamento que já encerrou deixa de derrubar o banco** O banco da instalação podia ir a 100% de processador sem ninguém usando o produto. A causa era um acompanhamento (follow-up) que já tinha acabado: o sistema tentava atualizá-lo, o banco recusava, e o recuso era do tipo que o próprio banco pede "tente de novo". Ele tentava de novo — milhares de vezes por minuto — e o processador não saía do teto.

  Isso não muda tela, fluxo nem configuração. Na próxima atualização o recuso deixa de pedir retry, e o banco volta a respirar.

  Nada para fazer na VPS além de atualizar quando o aviso aparecer.

- **O primeiro pareamento de chamada de voz recebe o código QR** Com o serviço de voz configurado, a tela prepara a sessão antes de abrir a conexão de eventos e pedir o QR. A conexão do pareamento e a ponte que acompanha as chamadas passam a enviar a credencial já usada nas demais operações. Falhas ao receber o código aparecem na tela e permitem tentar novamente.

## [1.24.0] — 2026-09-14

### Adicionado

- **Você passa a ver, por cliente, qual agente está publicado** Se você administra a instalação, agora dá para saber se cada cliente está sendo atendido sem abrir cliente por cliente: a tela de Uso ganhou a coluna com o agente publicado (e o mesmo campo no CSV), e cada cliente ganhou a aba **Agente**, com a versão que o motor executa, o provedor e o modelo. A leitura fica registrada na auditoria com o seu usuário e a organização visitada. Nada precisa ser feito na VPS. Crédito: @jostoz.

### Corrigido

- **O agente para de dizer que a mensagem veio vazia quando ela tem texto** Quando chegava um áudio ou uma foto sem legenda, o agente lia a coluna crua da
  mensagem e recebia o corpo vazio — mesmo com a transcrição já gravada e o texto
  à vista na tela da conversa. Com isso ele respondia ao cliente dizendo que a
  mensagem tinha vindo em branco, e a trava que impede exatamente essa frase
  ficava desarmada, porque aos olhos dele não havia texto nenhum. Agora a
  mensagem que acorda o agente é lida pela mesma função que monta o histórico da
  conversa: com texto, com transcrição ou com o marcador da mídia, ele nunca mais
  anuncia vazio.

  Achado e corrigido por @webtecnica.

- **O hub de IA respeita o idioma escolhido** Ao abrir a área de IA em espanhol, títulos, seções e descrições agora acompanham o idioma escolhido em vez de aparecerem em português. Crédito: @alexneverland.

- **Grafo corrompido deixa de passar no schema** O schema do fluxo validava cada nó e cada aresta isoladamente, então um grafo corrompido passava no salvamento: aresta apontando para nó que não existe mais (o estrago que o editor produz ao excluir um nó), dois nós com o mesmo id e duas arestas com o mesmo id. O `flowGraphSchema` agora tem uma catraca de integridade que rejeita os três casos com mensagem explícita dizendo o id a corrigir — `aresta "e-3" aponta para nó inexistente: "no-9"`, `id de nó repetido: "no-1"`, `id de aresta repetido: "e-2"`.

  Esses grafos só quebravam longe do defeito: no meio de um disparo, quando uma aresta não resolvia para nó nenhum. Como salvar o rascunho e carregar a versão usam a mesma porta, o erro passa a aparecer na hora de salvar, com o id na mensagem, em vez de virar um caso de suporte.

  Quem já tem rascunho corrompido passa a ver o erro ao abrir e salvar o fluxo e precisa corrigir a aresta — não há migração automática, decisão registrada na issue #699. Grafo íntegro e campo desconhecido seguem como antes, com controle nos testes.

- **Material .txt e .md salvo no Windows entra na base de conhecimento sem mojibake** Arquivo de texto salvo no Bloco de Notas — que grava em cp1252 (ANSI) por padrão, e é assim que quem monta a base de conhecimento no Windows escreve os `.txt` e `.md` — entrava no conhecimento do agente com cada acento virando U+FFFD — "Ação" entrava como "A��o". Não dava erro, não dava aviso: o material aparecia como pronto na tela, o índice era construído, e o agente passava a citar o texto corrompido para o cliente.

  Agora a leitura dos bytes usa a mesma decisão de codificação que a importação de planilhas já usava (lê como UTF-8 e só troca para windows-1252 quando o arquivo prova não ser UTF-8), e material que não é texto — um `.xlsx` renomeado para `.md`, ou um `.txt` salvo como "Unicode" (UTF-16) — é recusado no envio com uma frase dizendo o que fazer, em vez de entrar como lixo. Material que já era UTF-8 entra exatamente como antes.

- **O canal não volta sozinho para o modo de teste depois de aberto ao público** O modo de acesso da IA de um canal mora em três chaves de metadata: uma diz se o
  canal está aberto, em allowlist por origem ou em lista de testadores; outra diz
  se ele está em pré-go-live. Ao abrir o canal ao público, a segunda chave era
  gravada sempre com o mesmo valor — "em teste" — mesmo quando o canal já não
  estava em teste. Sozinha, a chave errada não mudava nada. Na volta, sim: o script
  que liga o allowlist POR ORIGEM gravava só a primeira chave, então o canal
  reaparecia em modo de teste com a lista de testadores antiga, em vez de atender
  quem tem autorização por origem. A IA parava de responder a quem deveria atender
  sem erro nenhum na tela, e o próprio simulador do script prometia que o contato
  seria atendido.

  Agora as duas chaves andam juntas nas duas pontas: abrir ao público tira o canal
  do teste, e o script escreve o alvo nos dois campos — recusando a gravação se o
  motor continuaria lendo modo de teste. O simulador do script passou a prometer o
  mesmo veredito que o motor executa.

  Canais que hoje estão abertos com a chave velha continuam abertos: ela sai na
  próxima gravação da tela ou do script. Você não precisa fazer nada para adotar.

  Achado e corrigido por @webtecnica.

## [1.23.0] — 2026-09-14

### Adicionado

- **A navegação responde na hora, e a atualização para quando o backup falha** Clicar numa aba do menu deixou de parecer que a tela travou. Uma barra fina
  aparece no topo no instante do clique e acompanha o carregamento, então você
  sabe que o sistema ouviu — antes, entre o clique e a página aparecer não havia
  sinal nenhum, e a reação natural era clicar de novo.

  As telas de dentro do sistema também abrem mais rápido: as consultas que toda
  página precisa fazer (quem é você, de qual empresa, quais conexões estão fora do
  ar) passaram a ser feitas ao mesmo tempo em vez de uma esperando a outra, e
  deixaram de ser repetidas dentro da mesma página. No banco, as buscas de
  histórico por contato e por conexão ganharam índices — quem tem muita mensagem
  guardada sente a diferença nas telas de conversa e no expurgo de dados da LGPD.

  O `update.sh` ficou mais cuidadoso com os seus dados. Quando o backup preventivo
  falha, a atualização agora PARA: se você estiver acompanhando pelo terminal, ela
  pergunta e só segue se você digitar `CONTINUAR`; se for o agente do servidor
  atualizando sozinho, ela cancela e avisa. Antes ela esperava oito segundos e
  seguia sem backup. O `restore.sh` passou a devolver também as sessões do
  WhatsApp guardadas no backup, não só o banco — restaurar deixou de exigir parear
  o QR Code de novo.

  E duas portas ficaram mais firmes: subir imagem para cabeçalho de modelo do
  WhatsApp agora confere o conteúdo do arquivo, não o rótulo que o navegador
  mandou (um SVG renomeado para `.png` entrava e agora é recusado), e passou a
  exigir permissão de atendente; as rotas internas de manutenção comparam a senha
  de acesso em tempo constante.

  Contribuição de @maugarciasa.

- **As automações agora enxergam a agenda** O motor de automações já sabia mandar WhatsApp, esperar, checar condição e
  registrar o que fez. O que ele não enxergava era a agenda: nenhum dos gatilhos
  disponíveis vinha de um horário marcado. Quem queria avisar a cliente que o
  horário foi confirmado tinha o motor, tinha o envio, e não tinha o fato.

  Quatro gatilhos novos aparecem no seletor de automações:

  - Quando um horário for marcado
  - Quando um horário pendente for confirmado
  - Quando um horário for remarcado
  - Quando um horário for cancelado

  As condições podem filtrar pelo tipo de atendimento (com "contém", então
  "Manutenção" pega todas as manutenções) e pelas tags do contato. As ações são as
  mesmas de sempre, a de mandar mensagem no WhatsApp inclusive.

  Quem já tem automações não precisa fazer nada: as regras existentes continuam
  como estavam.

- **Outro sistema já pode enviar mensagem pelo seu WhatsApp, usando um token** Até agora, enviar uma mensagem pela API exigia estar logado no navegador. Um
  sistema externo não conseguia, mesmo com um token válido: a porta respondia
  "não autenticado" antes de olhar o token.

  Enviar uma mensagem e abrir uma conversa a partir de um telefone passam a
  aceitar também um token de servidor, o mesmo que já era usado para consultar
  contatos. A organização continua saindo do token, nunca do que foi enviado no
  pedido, então um token de uma empresa não alcança a conversa de outra. Token
  de leitura continua sem poder enviar.

  Quem usa o sistema pela tela não vê diferença nenhuma.

- **O atendimento aberto pelo assistente diz do que trata** Na lista de atendimentos, cada item agora começa dizendo o assunto: horário,
  dúvida, algo deu errado, pagamento, acesso. O assistente classifica ao abrir.

  Serve para quem abre a fila separar antes de ler — "alguém quer marcar horário"
  e "alguém está reclamando" pedem pessoas e pressas diferentes.

  A lista de assuntos é curta de propósito. O detalhe do pedido continua no título
  e no resumo, escritos com as palavras do próprio cliente; o assunto é só para
  triar.

  Atendimentos abertos antes desta versão aparecem como "Outro".

- **O pedido que ninguém confirmou solta o horário** Quando um tipo de atendimento pede confirmação, o pedido do cliente já reserva o
  horário: ele some da lista de horários livres e ninguém mais consegue marcar ali.
  É o que faz o modo "o cliente pede, uma pessoa confirma" funcionar.

  Faltava o outro lado disso. Um pedido que ninguém abriu segurava a agenda para
  sempre, e o efeito era igualzinho ao de agenda cheia: o próximo cliente ouvia
  "não tenho horário" por causa de um pedido esquecido.

  Agora existe um prazo. Passado ele sem decisão, o horário volta a ser oferecido.
  O padrão é 24 horas, e dá para mudar em Agenda, no mesmo lugar dos outros prazos.

  Duas coisas que **não** acontecem quando o prazo vence: o cliente não recebe
  nenhum aviso, e o pedido dele continua na fila para ser atendido. O que expira é
  a reserva do horário, não o pedido.

### Corrigido

- **"Novo agendamento" deixa de vir com o cliente da vez anterior, e a lista de horários volta a rolar** Duas coisas na tela de agendamento, medidas numa instalação real.

  **O compromisso podia nascer no nome da pessoa errada.** Quem abrisse "Marcar compromisso" de dentro de uma conversa e depois fosse à **Agenda pelo menu** encontrava o campo **Quem será atendido** já preenchido com aquele cliente. O campo parece preenchido de propósito; não há o que estranhar na tela. Agora o painel abre com o cliente que a **página** carrega: vindo do menu, ele abre em **"Compromisso pessoal, sem cliente"**; vindo do link da conversa, ele continua abrindo com aquele cliente, mesmo que você feche o painel para navegar o calendário até a semana certa.

  **A lista de horários voltou a rolar.** Numa correção anterior, o painel perdeu o limite de altura para que a janela parasse de **cortar os botões** em telas baixas — e, sem limite, a lista de horários passou a crescer sem fim: um tipo de 45 minutos rende treze horários e uma janela maior que a tela. Agora a lista tem limite próprio, proporcional à altura da janela, e rola dentro de si em telas de computador. No celular nada muda: quem rola continua sendo a janela inteira.

  Nada muda para quem opera: sem passo manual, sem mexer em configuração.

- **A agenda no celular abre no dia, e dá para criar cliente sem sair da marcação** Quem abre a agenda no celular via a semana inteira espremida: sete colunas em
  uma tela de 360 pixels davam cerca de 44 pixels por dia, e errar o toque era o
  normal. Agora o celular abre no dia, com a coluna ocupando a tela toda — o alvo
  do toque ficou quase cinco vezes mais largo. No computador nada muda: a semana
  continua inteira.

  Duas coisas que não funcionavam passam a funcionar:

  Tocar num compromisso abre o detalhe dele. Antes o toque não fazia nada, e só
  dava para abrir vindo do histórico ou do radar.

  Quando você busca um cliente que ainda não está cadastrado, aparece um "Criar"
  com o nome que você digitou. O cadastro abre ali mesmo e o cliente volta já
  escolhido. Antes era preciso abandonar a marcação, ir até Contatos, cadastrar,
  voltar e começar de novo.

- **Token de servidor não alcança mais a conversa de outra empresa** A porta de saída de mensagem do sistema conferia só o número da conversa, nunca
  a empresa dona dela. Para quem envia pela tela isso nunca foi problema: o banco
  já filtra por empresa nesse caminho. Mas quem envia por token de servidor — o
  agente de IA por MCP, e agora as integrações — entra por um caminho em que esse
  filtro do banco não existe, e o único cuidado possível é o do próprio sistema.
  Ele faltava.

  Na prática: um token de uma empresa, com o número de uma conversa de outra,
  gravava e disparava a mensagem pelo WhatsApp da segunda. Agora a conversa de
  outra empresa responde "não encontrada", e nada é gravado.

  Quem usa o sistema pela tela não vê diferença nenhuma.

- **Gravar espera o servidor em vez de dizer "Erro inesperado"** Ação que grava e passava de 10 segundos virava "Erro inesperado" na tela
  enquanto o servidor terminava e gravava. Agora espera 30. Leitura segue em 10.

- **O sistema não fica mais preso em "Algo deu errado" quando o Supabase repete requisições antigas** Uma instalação inteira ficou dois dias mostrando "Algo deu errado" em todas as
  telas. O banco estava saudável; o que travou foi a camada de API do Supabase: o
  gateway dela repetia sem parar oito requisições antigas do motor de follow-up
  que terminavam em erro, e essas repetições ocuparam todas as conexões da API.
  Sem conexão livre, a API não conseguia nem se preparar para atender, e passou a
  responder "indisponível" para tudo, inclusive para a tela inicial.

  Agora o banco reconhece uma requisição que o gateway está repetindo há mais de
  cinco minutos e a recusa de um jeito que o gateway não repete. O loop morre na
  hora e a API volta sozinha. Nada muda para quem usa o sistema, e você não
  precisa fazer nada ao atualizar: a proteção entra com o próprio `update.sh`.

- **Logo escuro/colorido não some mais no tema escuro** Um logo pensado para fundo claro (a maioria do que se sobe em `/admin/marca`
  e `/app/settings/marca`) ficava ilegível no tema escuro: o fundo da barra
  lateral e da tela de entrada é quase preto (`--color-surface` escuro), e um
  logo escuro sobre quase-preto não tem contraste nenhum.

  Agora a barra lateral, a tela de entrada e a prévia da própria tela de marca
  mostram o logo sobre um chip branco arredondado quando o tema é escuro — a
  mesma lógica que já existe para o texto dos botões, aplicada ao logo. No tema
  claro nada muda: o chip só aparece quando o fundo por trás dele é escuro.

  Quem já tinha um logo pensado para fundo escuro (raro, mas possível) passa a
  ver uma moldura branca de sobra em vez de nada — troca aceita, porque o pior
  caso "moldura desnecessária" é sempre melhor que o pior caso "logo invisível".

- **O identificador da conexão de WhatsApp nasce num lugar só e cabe no limite** O botão "Conectar novo WhatsApp", na Central de Conexões, falhava sempre com "Falha na comunicação
  com o WhatsApp (WAHA)". O identificador interno que o sistema manda para o WhatsApp saía com 69
  caracteres, e o WhatsApp recusa acima de 54, então a conexão nem chegava a ser criada do outro lado
  e o card ficava em "Parado" pedindo reparo. O onboarding escapava porque montava o identificador
  curto por conta própria, num segundo lugar do código.

  A versão anterior já corrigiu o identificador no banco e arrumou as conexões paradas que ainda
  tinham o nome longo. Agora o formato curto é um só, usado pelas duas telas — onboarding e
  Conexões —, e o sistema confere o limite antes de falar com o WhatsApp: se o identificador ainda
  estiver longo, ele é trocado na hora **apenas** quando o número nunca chegou a ser pareado; num
  número que já pareou, a conexão para com um aviso próprio em vez de trocar o identificador — trocar
  ali desligaria o sistema do WhatsApp que está no ar e exigiria um QR novo.

  Nada muda para quem já tem número conectado.

## [1.22.0] — 2026-09-14

### Adicionado

- **O atendimento que espera decisão volta a pedir passagem** Quando o assistente precisa que alguém da equipe destrave algo, ele abre um
  atendimento e continua conversando com o cliente. Se ninguém abre esse
  atendimento, ele ficava lá — e nada avisava. O cliente esperava, e a única
  evidência era uma linha numa tela que talvez ninguém tivesse aberto naquele dia.

  Agora, passado um dia sem ninguém encostar, aparece um aviso na Central (e no
  sino) dizendo que um atendimento espera decisão. Clicar no aviso abre o
  atendimento certo, não a lista.

  O aviso não se repete enquanto não for resolvido, e o sistema cobra no máximo
  três vezes: alarme que nunca cala ensina a ignorar o alarme certo.

- **Dá para fechar um dia da agenda** Feriado, férias, viagem: agora existe onde dizer "neste dia não atendo". Fica em
  Configurações › Agenda, e a partir dali o sistema deixa de oferecer horários
  naquele dia — para você, para o cliente que consulta e para o assistente de IA.

  O que já estava marcado **continua marcado**. Fechar o dia impede o novo; o que
  fazer com quem já tinha horário é decisão sua, compromisso por compromisso.

  Até agora a única saída era marcar um compromisso falso de dia inteiro, que
  suja a agenda, conta como atendimento e aparece no histórico do cliente.

### Alterado

- **Criar resposta rápida duas vezes com a mesma chave não cria duas** Quem chama a API pode repetir com segurança uma criação que não chegou a receber resposta: enviando o cabeçalho `Idempotency-Key` num `POST /api/v1/message-templates`, a segunda chamada com o mesmo conteúdo devolve a resposta da primeira em vez de criar outra resposta rápida, e a mesma chave com conteúdo diferente é recusada com `409`. Nada muda na tela e não há nada a fazer na VPS: a garantia alcança os clientes que mandam a chave, que o cliente HTTP do próprio produto já injeta em toda mutation.

  A corrida entre duas chamadas simultâneas com a mesma chave continua aberta — a tabela de recibos só sabe guardar resultado terminal, então fechar essa janela exige mudança de schema, levada como pergunta na issue #778.

### Corrigido

- **O agente para de se apresentar como assistente virtual contra as instruções dele** O texto de base que o sistema coloca antes das instruções de todo agente
  mandava ele "se apresentar como assistente virtual" na primeira interação. Quem
  escrevia na tela do agente um nome próprio e pedia para não usar esse termo via o
  agente repetir "assistente virtual" mesmo assim, porque as duas ordens chegavam
  juntas. A apresentação agora fica com as instruções do agente; continua valendo
  que ele nunca afirma ser humano e responde com honestidade se perguntarem.

  Vale para instalações novas. Em instalação existente o texto de base já gravado
  no banco não é trocado sozinho. Crédito: @rafaelbatistazz.

- **A proteção da agenda passa a valer para o agente que só consulta horários** O produto tem uma garantia dura: o agente não pode dizer "vou verificar o
  horário e te aviso" — nem "está confirmado" — sem ter consultado a agenda de
  fato. Ela estava armada só para agentes que podem MARCAR sozinhos.

  Quem configura o agente para apenas consultar, deixando a confirmação com uma
  pessoa da equipe — o arranjo normal de clínica, salão e consultório —, tinha um
  agente sem essa proteção e sem as instruções de agenda. Ele prometia verificar e
  não verificava, e nada no sistema acusava.

  Agora a proteção vale para qualquer agente com ferramenta de agenda, e o texto
  que corrige o agente nomeia só as ferramentas que ele realmente tem: mandar
  "chame crm_book_appointment" para quem não a tem fazia o modelo tentar uma
  ferramenta inexistente.

  Nada muda para quem já tinha o agente marcando sozinho.

- **O campo de busca do Inbox passa a dizer o que realmente procura** O campo de busca do Inbox dizia "Buscar por nome, telefone ou mensagem", mas
  procura apenas na ÚLTIMA mensagem de cada conversa — não no histórico. Quem
  buscava uma frase dita no meio do atendimento não encontrava nada, sem qualquer
  aviso de que aquela parte da conversa estava fora do alcance.

  O texto do campo agora diz "última mensagem". Nada mudou no que a busca encontra:
  ela continua achando por nome, por telefone (em qualquer formato) e pela última
  mensagem. O que mudou é que a tela parou de prometer o que não entrega.

  Buscar dentro do histórico inteiro está no plano, como melhoria à parte.

  Crédito: @paulolimajr77

- **A busca do Inbox acha o contato mesmo quando o nome é digitado diferente** Procurar um contato pelo nome exigia digitar exatamente como estava gravado. Num
  contato salvo como "Paulo Lima Jr", buscar "Paulo Jr" não achava nada — e
  "Paulo  Lima", com dois espaços por engano, também não. Só achava quem digitasse
  o nome inteiro e na ordem certa.

  Agora espaço, vírgula e ponto e vírgula são tratados igual: "Paulo Jr",
  "Paulo  Lima" e "Paulo, Jr" encontram o mesmo contato. Buscar pelo sobrenome
  primeiro ("Lima Paulo") continua não achando — isso é uma mudança maior, para
  outra versão.

  A busca por telefone não mudou: continua achando com ou sem DDD, com ou sem
  pontuação, e pelos últimos dígitos.

  Você não precisa fazer nada para adotar. Crédito: @paulolimajr77

- **O cabeçalho para de se sobrepor no celular** Em telas estreitas, o nome da organização ficava por baixo do campo de busca, e
  a busca por cima do sino de avisos. Quanto mais longo o nome, pior.

  No celular o seletor de organização passa a mostrar só o ícone da loja. O nome
  completo continua a um toque, dentro do menu que ele já abre, e quem usa leitor
  de tela continua ouvindo o nome normalmente.

  No computador nada muda.

- **Botões que dependem do banco param de travar a instalação inteira quando o atendimento está ocupado** Medido numa instalação real. O botão **Enviar link ao cliente** (do Google Meet) parecia não funcionar: aparecia *"Erro inesperado. Tente novamente."*, sem nenhuma pista, e clicar de novo não resolvia.

  O que acontecia por baixo: a operação pede uma reserva no banco para não atropelar um atendimento em curso — e essa espera **não tinha prazo**. O navegador desistia em 10 segundos e mostrava o erro, mas **o pedido continuava vivo no banco**, segurando a fila. Como o botão voltava a funcionar, cada clique empilhava mais um pedido atrás do anterior.

  Com dez pedidos empilhados, o banco de dados da instalação foi a **357% de processador** — e nada mais respondia bem, inclusive telas que não tinham nada a ver com aquilo.

  Agora toda chamada da aplicação desiste de esperar em 4 segundos e diz o motivo: *"Este atendimento está ocupado neste instante. Aguarde alguns segundos e tente de novo."* Nada fica pendurado, e a frase diz o que fazer.

  O conserto vale para **toda** a aplicação, não só para esse botão: sete operações tinham a mesma forma, incluindo **Aprovar e enviar** (da sugestão de resposta), **mesclar contatos**, **conectar canal** e **anonimizar contato** da LGPD. O trabalho de fundo (filas e agendadores) continua podendo esperar o tempo que precisar — lá não há ninguém olhando a tela.

  Nada muda para quem opera: sem passo manual, sem mexer em configuração.

- **Modelo padrão em IA → Provedores volta a ser salvável quando o catálogo do provedor ainda não sincronizou** O catálogo que alimenta o combo de modelo da tela IA → Provedores nasce de uma sincronização
  que só alguns provedores já têm semeada na instalação: quem escolhia um provedor cujo catálogo
  ainda não tinha sido baixado encontrava a lista vazia. Combo vazio, nada para escolher, e o
  botão de gravar o modelo padrão desabilitado — a tela existia justamente para configurar essa
  escolha, mas não oferecia nenhum caminho para fazê-lo, e não dizia por quê.

  Agora, quando não há nenhum modelo conhecido para o provedor selecionado, o campo deixa de ser
  uma lista e passa a aceitar o identificador digitado, com uma nota explicando que a lista
  completa aparece sozinha depois da primeira sincronização. A gravação avisa que não deu para
  conferir o identificador contra o catálogo, em vez de dizer apenas que salvou: com o catálogo
  presente, um nome de modelo errado continua sendo recusado como antes.

  Para quem opera uma VPS, nada muda: é conserto de tela, sem comando novo, sem variável nova e
  sem migração. Ninguém precisa fazer nada ao atualizar.

- **Os números das abas do Inbox passam a respeitar os filtros, e "Fechadas" ganha número** Os números ao lado das abas do Inbox ignoravam os filtros ligados na barra. Com
  "Não lidos" marcado, a lista podia mostrar nenhuma conversa enquanto a aba
  continuava estampando o total — mandando o atendente procurar um trabalho que
  não estava lá.

  Agora as contagens aplicam os mesmos filtros que a lista: etiqueta, número de
  WhatsApp e não lidos. E a aba "Fechadas", que não tinha número nenhum, passa a
  ter.

  A busca continua fora da conta: sob busca, o número da aba pode ficar maior que
  a lista. Contar a busca exigiria uma segunda maneira de procurar, e duas maneiras
  acabam discordando uma da outra.

  Você não precisa fazer nada para adotar. Crédito: @paulolimajr77

- **Importação de contatos contabiliza repetições sem perder linhas válidas** Ao importar contatos por CSV, cada linha repetida agora aparece no total de
  duplicados do relatório. Uma linha rejeitada na validação ou na gravação não
  impede a importação de outra linha válida com o mesmo telefone ou e-mail. Se
  uma linha é pulada por ter um e-mail já cadastrado, seu telefone ainda não
  gravado continua disponível para as linhas seguintes. Crédito: @Tong-bit-art.

- **Credencial ainda não configurada deixa de derrubar a leitura** Toda credencial que ainda não foi preenchida — o segredo de webhook de uma
  sessão nova, por exemplo — era gravada como um byte de enfeite só para
  satisfazer a coluna. E o CRM, ao ler qualquer credencial, tentava decifrar esse
  byte como se fosse uma cifra de verdade: a leitura estourava toda vez, no mesmo
  registro, sem parar.

  O efeito prático não estava na tela — quem lê uma credencial já tratava o erro
  como "não configurada". Estava no log, que enchia de erro permanente e
  indistinguível de uma chave mestra trocada, que é o único caso em que esse erro
  diz a verdade. Agora a leitura só tenta decifrar o que pode ser uma cifra: valor
  ausente, curto demais ou sem cara de pacote devolve "não configurada". Cifra de
  verdade que não abre continua aparecendo.

  Você não precisa fazer nada para adotar: aplicar a atualização basta, e as
  credenciais já gravadas seguem onde estão.

- **Quem cria uma organização para outra pessoa sai dela quando essa pessoa assume** Ao criar uma organização pelo painel de plataforma, quem cria entra nela como
  administrador. Isso é necessário: sem ninguém dentro, a organização nasceria
  inacessível e nem daria para configurá-la antes de entregar.

  O que faltava era a saída. Nada nunca tirava o criador de lá — a aba "Equipe" do
  painel de plataforma está desativada, a tela da organização recusa que alguém
  revogue o próprio acesso, e a jornada de convite não sabia da existência do
  criador.

  Na prática, quem instala o sistema para clientes ficava dentro da empresa de cada
  um deles, para sempre. O cliente abria Equipe › Membros e encontrava o e-mail
  pessoal de quem instalou listado como se fosse um colega da equipe: ocupando uma
  vaga, aparecendo como responsável possível na Agenda, e podendo ser removido por
  ele — enquanto quem estava lá não tinha como sair.

  Agora, quando a organização é criada para outra pessoa,
  **o vínculo de quem cria nasce marcado como provisório.** Ele existe só para a empresa não nascer vazia, e
  sai sozinho no momento em que a entrega se completa: quando o dono aceita o
  convite. Até lá o criador continua dentro, então a organização nunca fica sem
  ninguém.

  Quem cria uma organização **para si mesmo** não é afetado — nem quem criou
  a sua pelo cadastro normal. O vínculo dessas pessoas não recebe a marca e nada nesta
  versão volta a tocá-lo.

  **Organizações criadas antes desta versão não mudam.** Vínculos antigos não têm a
  marca, e o sistema não tenta adivinhá-la: se numa instalação existe um criador
  que deveria ter saído, a remoção é feita à mão, com alguém olhando o caso. Essa
  escolha é deliberada — uma versão anterior desta correção tentou deduzir quem
  deveria sair e acertou o alvo errado.

  Você não precisa fazer nada para adotar.

- **Excluir contato não destrói mais o histórico quando a ficha não sai** Excluir um contato que tinha compromisso na agenda nunca funcionava — e, na
  tentativa, levava junto as mensagens e as conversas dele. O CRM apagava o
  histórico primeiro e só então esbarrava no vínculo que barra a exclusão da
  ficha: a tela dizia "Erro interno", o contato continuava lá e as conversas
  tinham ido embora sem volta.

  Antes de apagar qualquer coisa, o CRM agora confere os vínculos que barram a
  exclusão e devolve o mesmo aviso de vínculo pendente, com o histórico intacto.
  E toda tentativa que não completa passa a ficar registrada na auditoria, com o
  que chegou a ser apagado antes do erro — "ninguém excluiu" e "tentei e barrou"
  deixam de ser a mesma linha em branco.

  Você não precisa fazer nada para adotar.

- **Excluir nó ou aresta no builder de follow-up agora pede confirmação** O botão de excluir a seleção no builder de follow-up dividia o mesmo assento da barra com o
  botão que apaga o fluxo inteiro: mesmo ícone de lixeira, mesma cor destrutiva, mesma posição.
  Os dois eram confundidos justamente porque só um deles perguntava antes — quem aprendeu que a
  lixeira daquele canto pede confirmação clicava no outro com a mesma confiança e perdia o
  trabalho do canvas sem aviso.

  Agora os dois se comportam igual: clicar em Excluir (nó ou aresta) abre uma confirmação que diz
  o que vai embora. O título nomeia o alvo — "Excluir este nó?" ou "Excluir esta aresta?", conforme
  a seleção — e a frase explica a consequência: apagar um nó leva junto as arestas ligadas a ele,
  e não há como desfazer. A exclusão só acontece no clique de confirmação; cancelar não muda nada.

  Para quem opera uma VPS, nada muda: é conserto de tela, sem comando novo, sem variável nova e
  sem migração. Ninguém precisa fazer nada ao atualizar.

- **O filtro de etiqueta do Inbox passa a oferecer as etiquetas que existem** O seletor de etiqueta do Inbox só listava as etiquetas cadastradas à mão em
  Configurações. Se alguém etiquetava uma conversa com algo fora daquela lista, a
  etiqueta aparecia na conversa mas não havia como filtrar por ela — e numa
  instalação recém-configurada o seletor oferecia oito etiquetas de exemplo,
  nenhuma delas em uso, todas devolvendo lista vazia.

  Agora o seletor mostra as duas coisas juntas: as etiquetas cadastradas e as que
  estão realmente em uso nas conversas. E se você já estiver filtrando por uma
  etiqueta que saiu da lista, o seletor continua na tela mostrando qual é, em vez
  de sumir deixando a lista filtrada sem explicação.

  O histórico de atendimentos encerrados, no painel lateral, passa a mostrar a data
  de cada um ao lado do desfecho.

  Você não precisa fazer nada para adotar. Crédito: @paulolimajr77

- **O gate que exige conferência de organização passa a cobrir todas as funções privilegiadas** Nada muda na tela nem na operação: é proteção do próprio desenvolvimento.

  O banco tem funções privilegiadas que rodam **por cima** das regras de isolamento entre organizações. Quando uma delas recebe a organização como argumento, ela precisa conferir se quem chamou pertence de fato àquela organização — senão um usuário logado numa organização a chama com o identificador de outra.

  O teste que cobrava isso verificava **duas** funções, escritas à mão numa lista. Função nova nascia fora da lista, e nenhum gate a alcançava: em 2026-09-12 uma função escrita nesta mesma semana nasceu exatamente com esse defeito e a suíte inteira ficou verde — só apareceu porque quem a escreveu sabotou o próprio código de propósito.

  Agora a pergunta é feita ao catálogo do Postgres, para **todas** as funções que têm a forma do risco: privilegiada, alcançável por usuário logado e recebendo a organização por argumento. Quem confere por delegação — chamando outra função que confere — é reconhecido, para o gate não acusar quem já faz a coisa certa.

  O mesmo caminho já tinha sido percorrido pela pergunta vizinha ("quem pode executar esta função?"): ela também era lista fixa, virou varredura, e naquele dia 8 de 25 funções estavam expostas com todos os gates obrigatórios verdes.

- **A régua de recuperação para de correr para o contato anonimizado** Quando alguém pedia para ser esquecido (anonimização por LGPD), os dados eram
  redigidos — mas a régua de recuperação de falta continuava correndo por baixo. As
  mensagens de reengajamento seguiam sendo enviadas, e, quando a régua esgotava,
  nascia um aviso novo na Central apontando justamente para o compromisso que a
  anonimização tinha desligado: o aviso ressuscitava o vínculo que a LGPD mandou
  cortar.

  Agora a cascata de anonimização cancela a régua do contato no mesmo movimento em
  que redige os dados — tanto pelo botão da tela quanto pelo varredor diário de
  retenção —, e a porta que abria aquele aviso passou a recusar contato
  anonimizado, como as outras três já faziam.

  Você não precisa fazer nada para adotar. Contatos anonimizados antes desta versão
  que ainda tenham resíduo de redação são alcançados pelo varredor diário, que
  agora corta a régua deles também.

- **O botão "Limpar filtros" agora limpa também a caixa de busca** No Atendimento, "Limpar filtros" desligava os filtros e a lista voltava — mas o texto digitado continuava escrito na caixa de busca. A lista voltava cheia com um termo visível que já não valia, e quem olhasse leria aquela lista como resultado daquela busca.

  Agora o botão limpa as duas coisas: o filtro e o campo.

- **O assistente para de dizer "confirmado" num horário que ainda espera aprovação** Quando um tipo de atendimento exige que alguém da equipe aprove, o horário
  marcado pelo assistente nasce **reservado**, não confirmado: ninguém mais
  consegue pegá-lo, mas ele ainda pode ser recusado.

  O assistente não sabia disso. As instruções que ele recebia mandavam dizer que o
  horário estava confirmado logo depois de marcar — então o cliente ouvia uma
  confirmação que ninguém tinha dado, e podia aparecer num horário que a equipe
  ainda ia recusar.

  Agora o assistente é avisado quando o horário apenas ficou reservado, e diz isso
  ao cliente: que separou o horário e que a equipe confirma.

  Nada muda em atendimentos que não exigem aprovação.

- **O filtro "Não lidos" do Inbox passa a procurar em todas as conversas** O botão "Não lidos" só escondia as conversas já lidas da parte da lista que
  estava carregada na tela — ele não consultava o sistema. Numa caixa com muitas
  conversas, se as primeiras estivessem todas lidas, a tela mostrava "Sem conversas
  por aqui" e nem oferecia carregar o resto, dando a entender que não havia nada
  não lido quando havia.

  Agora o filtro consulta todas as conversas da organização, e o botão passa a
  poder ser combinado com as abas e com os demais filtros.

  Você não precisa fazer nada para adotar. Crédito: @paulolimajr77

- **O painel do Google Meet para de dizer que o envio "não foi autorizado"** Com o link pronto e ainda não enviado, o painel dizia "O envio do link ainda não foi autorizado" — que lê como recusa, quando era só o estado inicial. E logo abaixo estava o botão "Enviar link ao cliente", ativo.

  Agora diz o fato: **"Link não enviado ainda."** O botão continua o mesmo.

  "Autorizar" ficou onde é verdade: quando o atendimento muda de conversa e o sistema precisa de uma nova decisão sua.

- **PDFs recebidos pelo WhatsApp voltam a ser lidos pela IA** Todo PDF recebido falhava na extração de texto com "Extração de PDF
  indisponível: o binário nativo @napi-rs/canvas não foi instalado nesta
  plataforma" — mesmo a dependência estando instalada. O `next build`
  gera o `.next/standalone` copiando só o que o file-tracing consegue seguir
  por `import`/`require` estático, e o `@napi-rs/canvas` resolve seu binário
  nativo com um `require()` computado em runtime (por `process.platform` e
  detecção de musl/glibc); o tracer não segue isso e o binário ficava de fora
  da imagem — o mesmo defeito que já havia sido corrigido para o
  `@swc/helpers`. `next.config.ts` agora inclui o `@napi-rs/canvas` (e suas
  variantes de plataforma) na mesma lista.

  De quebra, o log do cron `attendant-heartbeat` (AT-08) passou a registrar
  `code`/`details`/`hint` do erro do Postgres/PostgREST, não só a mensagem —
  uma falha observada em produção só mostrava "column ... does not exist"
  sem informação suficiente para diagnosticar a causa real.

- **Proteção de envio abre depois de mexer nos canais — e nunca mais em silêncio** Quem criava, reconectava ou excluía uma conexão e logo abria a **Proteção de envio** encontrava o painel sem os dados daquela conexão. A lista de conexões era atualizada, mas a ficha de limites anti-ban (`pacing-knobs`) ficava com o cache velho. As duas andam juntas — agora qualquer mexida nos canais invalida as duas, e o painel abre com os números certos.

  Pior era o outro lado: quando a conexão já não estava mais na lista (excluída em outra aba ou máquina), o painel simplesmente **não aparecia** e o botão morria mudo. Agora a mesma folha abre com uma mensagem honesta — a proteção desta conexão não pôde ser carregada, ela pode ter sido removida ou a lista está desatualizada — e duas saídas: **Tentar de novo**, que recarrega a lista (quando a conexão reaparece, o formulário volta sozinho), e **Fechar**.

  Nada muda para quem abre a proteção de uma conexão que está na lista: o painel é o mesmo de sempre.

- **O indexador RAG para de ativar versão com trechos faltando** Ao reindexar uma fonte de conhecimento (uma FAQ, um documento, o catálogo), cada
  trecho do material é gravado um a um. Quando a gravação de um trecho falhava, o
  erro ia só para o log do servidor e a indexação seguia em frente: bastava que
  algum outro trecho tivesse gravado para a versão nova ser dada como pronta e
  entrar no ar. Quem conversava com o agente passava a receber respostas apoiadas
  num acervo furado, e a versão anterior, completa, saía de cena sem aviso — a
  pessoa só descobria o buraco ao perguntar exatamente o que faltou.

  Agora falha de gravação derruba a indexação inteira. Se qualquer trecho não
  gravar, a versão nova é registrada como falha, com o motivo (quantos trechos
  faltaram e em quais posições), e a versão anterior continua ativa e respondendo.
  O registro da falha também aponta o detalhe `trechos_nao_gravados:N`, para a
  triagem dizer de bate-pronto se o problema foi parcial. Quando nada grava, o
  detalhe segue sendo o `nenhum_trecho_gravado` de sempre.

  Não muda nada quando tudo grava: a versão nova é marcada como pronta e ativada
  como antes, e o caminho de erro de embedding (chave ausente ou provedor
  recusando) continua igual, derrubando a indexação sem ativar. Quem nunca viu um
  buraco no índice não vê diferença nenhuma.

- **O rascunho do agente de IA salva antes de haver WhatsApp conectado** Numa instalação nova, quem escrevia o prompt do atendente e tentava salvar não conseguia: o
  editor exigia escolher "por qual número ele atende" — e, sem nenhum aparelho pareado, o seletor
  abria vazio. Não havia opção a escolher, e o texto recém-escrito não tinha como ser guardado.
  Escrever quem o agente é e conectar o celular são dois dias diferentes na vida de quem instala.

  Agora o número é requisito para PUBLICAR, não para rascunhar. Sem ele o rascunho salva, e o
  botão "Publicar" explica o que falta e para onde ir (Conexões). Publicar sem número continua
  recusado em três camadas independentes — o botão, a função do banco
  (`fn_publish_ai_agent_version`) e o próprio runtime, que só executa versão publicada.

  No mesmo passo, o botão "Publicar" deixa de travar para quem usa a chave de IA da instalação
  (a do `.env`): a régua pedia uma linha na tela de Credenciais, e essa escolha não é uma linha —
  quem instalou pelo kit via o botão desabilitado para sempre, mandando escolher a chave que
  tinha acabado de escolher.

- **O log de eventos para de encher de pendências que ninguém ia atender** O registro de eventos alimenta o painel de diagnóstico. Só que **parte dos eventos nasce só para ficar registrada** — mensagem enviada, lead alterado, sessão de canal mudou de estado — e nenhum consumidor de fila foi feito para eles: ninguém ia atendê-los mesmo.

  Esses eventos nasciam marcados como **pendentes** igual a um pedido que ainda não foi processado, e assim ficavam para sempre. Numa instalação real havia **626 linhas assim, em 8 tipos de evento**, todas com cara de trabalho parado na fila — e nenhuma delas ia sair dali, porque não existia quem as pegasse.

  Agora o evento que é só registro nasce já fechado, e o que era acúmulo antigo foi fechado de uma vez. O que continua aparecendo como pendente é o que realmente **precisa** ser atendido: pedido de envio, pedido de disparo, e qualquer evento de um tipo que espere um consumidor que não exista. A fila volta a significar fila.

  Não há nada a fazer na sua VPS: a correção entra junto com a atualização e o acúmulo antigo é limpo por ela.

- **\"Testar agente\" devolve a resposta, e para de gastar crédito em triplo** Testar um agente gastava crédito e não mostrava nada. O painel de resultado
  ficava em "Nenhum teste executado ainda" mesmo com o modelo tendo respondido.

  A espera do navegador era de 10 segundos, e um teste de agente leva mais que
  isso: ele roda o motor inteiro, com as ferramentas e as verificações. Passados
  os 10 segundos o navegador desistia — mas o servidor não: ele terminava o
  trabalho e devolvia para ninguém.

  Pior, ao desistir o navegador tentava de novo, até três vezes. Cada clique em
  "Executar teste" podia virar três execuções completas do modelo, as três
  cobradas, nenhuma aparecendo na tela.

  Agora o teste espera o tempo que precisa, e a resposta aparece.

  A regra vale para o produto inteiro, não só para essa tela: quando uma operação
  que ESCREVE fica sem resposta, o sistema não a repete mais. Ficar sem resposta
  não quer dizer que não aconteceu — quer dizer que não se sabe, e repetir uma
  escrita nessa dúvida é o que cobra duas vezes. Buscas e listagens continuam
  sendo tentadas de novo normalmente, porque ler de novo não custa nem duplica
  nada.

- **O teste do agente termina de verdade, e quando falha diz por quê** Cada execução da aba Teste de um agente deixava uma linha de execução presa em
  "rodando", para sempre. Numa instalação com 16 testes, eram 16 linhas paradas.
  O motivo era um estado que o banco não reconhecia, gravado sem ninguém conferir
  se a gravação tinha dado certo.

  Agora a execução fecha como concluída ou falhada, com o tempo que levou.

  E quando o teste falha, a causa passa a existir em algum lugar. Antes o erro era
  descartado sem deixar rastro: a tela dizia uma frase genérica sobre modelo e
  credencial, e não havia nada no log nem na execução para dizer o que realmente
  aconteceu. Agora o erro vai para o log do servidor e fica guardado na própria
  execução. A mensagem para quem opera continua a mesma, porque o texto do erro é
  técnico.

  Os contadores de passos e tokens da execução de teste seguem em zero: esse dado
  não chega até ali, e preenchê-lo com um palpite seria pior que o zero.

- **Trocar de aba logo depois de digitar na busca para de voltar à aba anterior** Quem digitava na busca do Inbox e trocava de aba em seguida, rápido, era devolvido
  à aba anterior sem ter pedido. A busca continuava a valer, mas a aba voltava
  sozinha — e quem não sabia do problema não tinha como adivinhar a causa.

  Acontecia porque o envio da busca esperava um instante depois da última tecla, e
  nesse instante ele guardava também qual aba estava aberta na hora da digitação.
  Ao ser enviado, levava a aba velha junto.

  Agora ele envia apenas o que foi digitado.

  Você não precisa fazer nada para adotar. Crédito: @paulolimajr77

## [1.21.0] — 2026-09-14

### Adicionado

- **Quem publica o CRM atrás de um Nginx Proxy Manager sobrevive a atualizações** Instalações que já tinham um Nginx Proxy Manager nas portas 80/443 (em vez do
  Caddy do próprio kit, ou de um Traefik) precisavam plugar o contêiner `app` na
  rede do NPM à mão (`docker network connect`). Isso sumia na primeira
  atualização: `update.sh` recria o `app`, a conexão manual se perde, e o
  domínio volta a responder 502 — foi o que aconteceu numa VPS real em
  2026-09-11.

  Agora `REVERSE_PROXY=npm` no `.env` (junto de `PROXY_NETWORK_NAME` e
  `PROXY_NETWORK_APP_IP`, se a rede ou o IP do seu Proxy Host não forem os
  padrões) mantém o `app` sempre na rede certa, entra automaticamente em toda
  atualização e no cron de auto-update, e nunca sobe o Caddy por engano por
  cima do NPM. Se a rede do NPM sumir (`docker network prune`, por exemplo), a
  atualização para com uma mensagem explicando o que fazer, em vez de travar no
  erro opaco do Docker.

  Configurar pela primeira vez continua sendo manual — o NPM não anuncia sua
  configuração como o Traefik faz por labels — mas está documentado no
  cabeçalho de `docker-compose.npm.yml`.

### Corrigido

- **A foto do contato volta a aparecer nos números com nono dígito** A tarefa que busca as fotos de perfil pedia a imagem pelo telefone. Em número
  de celular brasileiro com nono dígito, o telefone que o CRM guarda e o que o
  WhatsApp usa internamente podem divergir, e a busca voltava vazia — o contato
  ficava sem foto sem que nada indicasse erro. Agora a tarefa pede primeiro pela
  identidade interna do WhatsApp e só recorre ao telefone se ela não existir.

  Achado e corrigido por @HigorLira.

- **A tela de atualização passa a dizer em que pé está, do começo ao fim** Ao clicar em "Atualizar agora", a tela mostrava a lista dos quatro passos com
  todos eles vazios e o título "Atualizando para a versão X" — e ficava assim,
  sem mexer nada, por vários minutos. Não era travamento: o clique só registra o
  pedido, e o servidor confere se há algo a fazer de poucos em poucos minutos. Mas
  não havia como saber disso olhando, e a tela afirmava um trabalho que ainda nem
  tinha começado.

  Agora a espera tem nome próprio ("Pedido enviado — esperando o servidor pegar"),
  diz por que demora, avisa que ficar parada nesse tempo é normal e mostra um
  relógio contando desde o pedido. A lista de passos só aparece quando existe um
  passo de verdade. Você pode fechar a página: o pedido não se perde.

  Do outro lado acontecia o inverso, e era pior. Terminada a atualização, o
  sistema voltava e a tela oferecia de novo o botão "Atualizar agora" para a
  versão que **acabava de ser instalada** — quem clicava refazia tudo, ou concluía
  que não tinha funcionado. Isso durava até o servidor reportar a versão nova, o
  que leva alguns minutos. Agora a tela reconhece o fim na hora e diz "Pronto —
  você está na versão X", sem oferecer nada.

  Você não precisa fazer nada para adotar.

- **Cada tela passa a dizer o próprio nome na aba do navegador** Dezessete telas do aplicativo caíam no título padrão do produto, então quem
  trabalha com várias abas abertas via a mesma legenda em todas elas e só
  descobria qual era qual clicando. Agora cada uma nomeia a si mesma.

  Achado e corrigido por @AnditecDev.

- **O WhatsApp oficial conectado pela tela volta a enviar — sem depender do .env** Uma instalação que conectou o número oficial pela **Central de Conexões** guarda a credencial **cifrada no banco** e não escreve nada no `.env` — e as mensagens ficavam paradas na fila, sem erro, com o canal conectado e funcionando na tela.

  A pergunta "dá para tentar enviar?" era respondida só pelo `.env`, num ponto que não consegue consultar o banco. Agora quem decide é o próprio envio, que resolve a credencial da sessão primeiro — e o `.env` continua valendo como fallback para instalações antigas de número único. Sem credencial nenhuma, a mensagem fica na fila com o motivo nomeado (em vez de nunca ser tentada); falha na consulta da credencial vira erro visível na mensagem, em vez de silêncio.

  Quem já tinha a chave no `.env` não vê diferença nenhuma.

- **A instalação deixa de exigir chave de IA — dá para cadastrar depois pela tela** O instalador exigia uma chave de IA que **passasse numa chamada real** ao
  provedor: sem ela, a instalação morria na Fase 2/4. Só que a documentação
  (`docs/deploy-selfhost`) sempre prometeu outra coisa — *"deixe vazio e cadastre
  a chave depois"* —, e o próprio sistema concorda com a doc: faltar todas as
  chaves é um aviso, não um erro.

  Agora o campo é opcional de verdade: dá para instalar sem abrir conta em
  provedor de IA e cadastrar a chave depois pela tela, em **IA › Credenciais**,
  onde ela fica cifrada no banco. A tela final da instalação lembra quem pulou o
  passo, com o caminho exato.

  Quem digita uma chave continua com ela validada na hora — o que mudou é que
  pular deixou de ser erro.

- **As duas verificações opcionais de segurança agora ligam de verdade** Em Agentes › Confere antes de enviar, ligar "Detectar tentativa de manipular o
  assistente" ou "Conferir promessas em texto livre" não gravava nada: o pedido
  era recusado e o interruptor voltava sozinho, sem explicação na tela. As duas
  verificações ficavam no que o servidor definia, e quem quisesse ligá-las por
  organização não conseguia — em nenhuma instalação.

  Agora o interruptor grava a escolha. Se você tentou ligar alguma das duas e
  achou que o clique não pegava, era isto; tente de novo. Crédito: @rafaelbatistazz.

- **O botão "Reativar" de tipo de agendamento passa a funcionar** Em Configurações › Agenda, um tipo de agendamento desativado mostra o botão
  "Reativar" — e ele **nunca funcionou**, desde que a tela existe. Clicar devolvia
  sempre o mesmo erro: "Nenhum campo para alterar." Quem tinha desativado um tipo
  por engano ficava sem saída pela tela: só criando outro com nome diferente, já
  que o nome original continuava ocupado pelo tipo desligado.

  A causa era um campo que o servidor descartava em silêncio. A tela pedia para
  ligar o tipo de volta usando a mesma porta que altera nome, duração e
  responsável — e essa porta não conhece o campo "ativo", então recebia um pedido
  que, do lado dela, não mudava nada.

  Agora reativar tem porta própria no servidor, com a mesma exigência de papel do
  desativar (gerente ou administrador), e fica registrado na trilha de auditoria
  como "tipo reativado" — separado de uma alteração comum de campo, para que um
  tipo religado não se confunda com um tipo que teve a duração mudada.

  Você não precisa fazer nada para adotar. Desativar continua igual, e nenhum
  compromisso já marcado é afetado.

- **Revogar e devolver acesso aparecem na hora na lista de Equipe** Em Equipe, revogar o acesso de alguém — ou devolvê-lo — deixava a linha da
  pessoa parada até recarregar a página. Quem clicava não via nada acontecer e
  clicava de novo, sem saber se o primeiro clique tinha valido.

  O servidor sempre fez a parte dele; era a tela que só se atualizava depois. E o
  problema só apareceu agora porque antes o membro revogado sumia da lista: some
  ou não some era resposta suficiente. Desde que ele passa a ficar na lista com o
  estado mudado, uma linha que não muda é uma tela que mente sobre o que acabou de
  acontecer.

  Agora a linha muda no clique e, se o servidor recusar, ela volta ao que era e o
  erro aparece — nunca fica dizendo "ativo" para quem não foi reativado. Devolver
  acesso também passou a confirmar que deu certo, como revogar já fazia: é
  justamente a ação que se faz com receio de ter errado.

  Você não precisa fazer nada para adotar.

  Crédito: @paulolimajr77.

- **Sentry para de derrubar um coletor de Web Vitals no console de quem usa o DSN da comunidade** A integração `BrowserTracing` do Sentry instrumenta Web Vitals (CLS/LCP/TTFB) mesmo sem enviar
  nenhum trace — a amostragem decide se o dado é enviado, não se o coletor roda. Numa instalação
  real (2026-09-09), uma extensão do navegador mexendo na Performance API da página derrubava
  esse coletor com um erro no console (`TypeError: Cannot read properties of undefined (reading
  'startTime')`), sem nenhum trace chegando a existir para explicar o motivo. Quem está no DSN da
  comunidade não tinha telemetria nenhuma sendo enviada por essa integração — só o risco do
  crash. Ela deixa de ser carregada para essa população; quem aponta para o próprio Sentry
  mantém o tracing normalmente.

- **A sugestão de resposta diz por que falhou, e a rejeitada sai da tela** Duas coisas na caixa de entrada, medidas numa instalação real.

  **A sugestão rejeitada não saía da tela.** O painel mostrava a sugestão mais recente sem olhar a situação dela — e uma rejeitada continua sendo a mais recente. O texto ficava ali, numa caixa desabilitada, sem botão de fechar (não havia nenhum). Pior no caso comum: quem rejeita costuma pedir outra em seguida; se essa segunda falha, nada substitui a primeira e a tela **trava** naquele texto.

  Agora a sugestão rejeitada — e também a obsoleta e a já enviada — solta o painel, que volta ao botão **Sugerir resposta**. A sugestão que falhou continua aparecendo de propósito: a frase dela é a única pista que sobra.

  **O erro não dizia nada.** Qualquer falha ao gerar virava a mesma frase — "Confira a publicação e a configuração do agente" —, mesmo quando o problema era outro, e **o motivo real era descartado sem ser registrado**. A tela ainda mostrava o identificador da requisição junto, o que fazia a mensagem parecer rastreável: não era, porque não havia nada gravado para procurar.

  Agora a tela diz qual dos motivos foi — nenhum agente publicado atende o canal, ou a conversa não pode receber sugestão (contato que pediu para não receber mensagens, contato anonimizado, histórico ilegível) — e, quando a causa é outra, admite que é outra e **registra** no servidor, onde o identificador finalmente encontra alguma coisa.

  Nada muda para quem opera: sem passo manual, sem mexer em configuração.

## [1.20.0] — 2026-09-12

### Adicionado

- **Falta sem retorno depois da régua de recuperação vira aviso na Central** Quando um cliente falta a um compromisso e a equipe confirma a falta, o sistema já matricula
  esse contato num fluxo de recuperação — as mensagens de reengajamento que tentam remarcar. Até
  agora, se a régua inteira era enviada e o cliente **nunca respondia**, o fluxo simplesmente
  terminava: o card ficava parado na mesma etapa e ninguém era avisado de que a recuperação tinha
  esgotado.

  Agora, quando isso acontece, abre um aviso na Central de avisos apontando para o compromisso —
  "Cliente faltou e não respondeu à recuperação" —, para alguém decidir o próximo passo e mover o
  card no funil. É um aviso por falta (o mesmo compromisso remarcado gera uma falta nova, e um
  aviso novo); reprocessar não duplica.

  O construtor de fluxo não move etapa por conta própria de propósito — faltar a uma visita não é
  o negócio esfriando, e quem decide isso continua sendo uma pessoa.

- **A aba Membros mostra os convites enviados, com status e ações** A tela **Equipe › Membros** ganhou uma seção **Convites**. Antes, um convite pendente só aparecia numa lista efêmera dentro do modal "Convidar membros", que sumia ao fechar — não havia onde ver se um convite foi enviado, se o e-mail saiu, se expirou ou se foi ignorado.

  Agora cada convite mostra e-mail, papel e perfil de interface; o status (**Pendente / Aceito / Expirado / Revogado**); a data de envio e a de expiração; e quem enviou o convite. Quando o e-mail **não saiu** — instalação sem serviço de e-mail configurado, por exemplo — a linha avisa e oferece o link do convite para copiar ali mesmo, em vez de o admin achar que enviou.

  Administradores podem **reenviar**, **copiar o link** e **revogar** cada convite; gerentes veem a lista. Revogar passa a impedir o aceite mesmo com o link ainda dentro da validade.

  Tudo escopado por organização (RLS). Nada muda para quem já roda: a atualização cria a tabela `team_invites` sozinha, sem edição de `.env` nem de compose.

- **O modelo de IA padrão da organização passa a ter tela** O padrão de IA da organização decide o modelo de **todo ponto que não tem escolha própria** — numa instalação nova, 24 dos 25.

  Ele existia no banco e já era usado para decidir cada ponto, mas não aparecia em
  lugar nenhum: não dava para ver qual era, e muito menos trocar sem mexer no
  banco à mão.

  Agora ele aparece em **Agente de IA › Provedores**, junto com os pontos, e pode
  ser trocado ali. A troca confere se o modelo existe no catálogo daquele provedor
  antes de gravar — um erro de digitação viraria o padrão da organização e
  derrubaria todos os pontos que herdam dele de uma vez.

  A escrita preserva o resto das configurações da organização (a marca e a
  política de verificação em duas etapas moram no mesmo lugar) e fica registrada
  no histórico de auditoria.

  Você não precisa fazer nada para adotar. Quem nunca mexeu continua no padrão de
  sempre; o que muda é que agora dá para ver e escolher.

### Corrigido

- **O instalador não para mais em "Ativando as automações" numa VPS nova** Numa VPS recém-criada o root ainda não tem agendamento nenhum, e o instalador parava logo depois de **"chave de cifra ativa no banco"**, sem mensagem de erro, mostrando **"A instalação parou"** — com o CRM já no ar e os contêineres saudáveis. Rodar o instalador de novo contornava, o que fazia o problema parecer fantasma.

  O que acontecia: o comando que lê as tarefas agendadas "reclama" quando não há nenhuma, e essa reclamação derrubava o script inteiro. A ironia é que a tarefa **já tinha sido gravada** nesse ponto — a instalação estava correta e parecia ter quebrado.

  Agora ele agenda as automações e o agente de atualização direto, na primeira rodada. Quem já instalou não precisa fazer nada.

  **Achado por duas pessoas no mesmo dia, sem que uma soubesse da outra: @luiscgc91 e @rafaelbatistazz**, as duas instalando numa VPS limpa. As duas escreveram exatamente a mesma correção. A descrição acima é a do @rafaelbatistazz, que nomeia o que se vê na tela.

- **Áudio, foto, vídeo e documento recebidos pelo WhatsApp oficial agora aparecem** Quem usa o canal **oficial do WhatsApp** (a API da Meta) recebia a mensagem, mas
  **não o arquivo**: o áudio, a foto, o vídeo ou o documento simplesmente não
  apareciam na conversa — e nada na tela dizia que havia algo ali.

  A causa: o aviso que a Meta manda não traz o arquivo, traz um código para
  buscá-lo. O sistema guardava a mensagem e descartava o código, então não havia
  como ir atrás do arquivo depois.

  Agora o código é guardado, o arquivo é baixado em segundo plano e passa a
  aparecer na conversa como qualquer outra mídia. O download só aceita o endereço
  de mídia da própria Meta, por conexão segura.

  Você não precisa fazer nada para adotar. Mensagens novas passam a trazer a mídia
  a partir desta versão; as antigas, que perderam o código, não têm como ser
  recuperadas.

  Achado e corrigido por um contribuidor de fora.

- **O aviso de risco da chamada de voz deixa de ser pulável** A tela de **Configurações › Segurança** pede, com uma caixa obrigatória, que quem administra declare que leu o aviso e **aceita o risco de o WhatsApp bloquear a conta** antes de ligar a chamada de voz.

  Só que dava para pular: quem fosse direto a **Conexões** e escaneasse o código conectava o segundo aparelho **sem passar pelo aviso**. Desligar sempre funcionou de verdade — desconecta o aparelho na hora; o que não existia era a exigência de **ligar**.

  Agora conectar o aparelho e fazer uma ligação exigem que a chamada de voz esteja ligada para a empresa. Quem tentar antes recebe uma mensagem clara dizendo que um administrador precisa ligá-la na tela — e não um erro técnico.

  Quem já tinha ligado pela tela não vê diferença nenhuma.

## [1.19.0] — 2026-09-11

### Adicionado

- **Chamada de voz pelo WhatsApp — desligada por padrão, e com botão de desligar de verdade** O sistema passa a poder fazer e receber **chamadas de voz pelo WhatsApp**, e ela chega
  **desligada**. Atualizar não liga nada: nenhum número seu é conectado a nada, nenhum serviço
  novo sobe na sua VPS, e nada muda na sua tela até você decidir.

  A razão de tanto cuidado está escrita na própria tela, antes do botão: para fazer chamadas, o
  sistema precisa conectar **um segundo aparelho** ao mesmo número de WhatsApp que você já usa
  para atender — e essa conexão não é feita pelo caminho oficial do WhatsApp. Se ele entender
  isso como uso indevido, quem é bloqueada é a **conta**, não só a chamada: você perde também as
  mensagens desse número. Por isso ligar é decisão de quem administra a empresa, exige marcar
  que leu o aviso, e fica registrado quem aceitou e quando.

  E desligar desliga mesmo. Antes, o único botão que existia era o de conectar — não havia
  caminho de volta: apagar a configuração escondia a tela e deixava o aparelho vinculado ao seu
  número para sempre, do lado do WhatsApp. Agora, ao desligar, o sistema **desconecta o aparelho**
  de verdade e só então marca como desligado; se a desconexão falhar, ele avisa e mantém tudo
  como estava, em vez de dizer que acabou com o aparelho ainda lá.

  No servidor, o serviço de chamada de voz também nasce desligado: ele só é criado quando quem
  administra a instalação o liga no arquivo de configuração. Quem não usar a chamada de voz não
  paga por ela — nem em memória da VPS, nem em superfície exposta. O serviço usado é o oficial
  do projeto WaCalls, fixado por versão exata e com login obrigatório; ele não é acessível pela
  internet, apenas pelo próprio sistema.

  Trabalho original de @eudanielhenrique.

- **Os e-mails de acesso passam a funcionar (e a ter marca) num Supabase próprio** Quem roda **Supabase self-hosted** ganha o que só existia na nuvem: e-mail de confirmação de conta e de redefinição de senha com a marca da instalação, e — o que importa mais — com o link que **fecha a sessão**.

  O app passa a servir os dois moldes em `/email-templates/confirmation` e `/email-templates/recovery`. Aponte o GoTrue para eles:

  ```bash
  GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://SEU_DOMINIO/email-templates/confirmation
  GOTRUE_MAILER_TEMPLATES_RECOVERY=https://SEU_DOMINIO/email-templates/recovery
  GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Confirme seu e-mail · SUA MARCA"
  GOTRUE_MAILER_SUBJECTS_RECOVERY="Redefinir sua senha · SUA MARCA"
  ```

  **Nada muda para quem não apontar**, e nada muda na nuvem do Supabase — lá o caminho continua sendo o `marca-emails.sh` pela Management API.

  **O kit ensina e confere, mas não escreve — e o motivo é honesto.** O GoTrue não é serviço deste compose: o kit sobe `app`, `worker`, `scheduler`, `waha`, `redis`, `srh` e `caddy`, e o Supabase próprio é outra stack, que pode nem estar na mesma máquina. Escrever nela seria o instalador editar instalação de terceiro. Então o `install.sh` passa a imprimir as quatro linhas exatas quando a topologia é própria (antes ele mandava o self-hoster para `supabase.com/dashboard`, que ele não tem), e `bash hostgator-setup-kit/healthcheck.sh` ganhou uma seção que **mede o estado**: se o app serve o molde, se algum GoTrue desta máquina aponta para ele, e se o valor configurado é URL — acusando em vermelho o caminho de arquivo que falha calado.

  **Por que isso conserta e não só embeleza.** O modelo padrão do GoTrue linka para `/auth/v1/verify`, que devolve um `code` PKCE. O verificador desse code vive num cookie `SameSite=Strict`, e clique vindo de webmail é navegação cross-site: o cookie não viaja e a sessão nunca fecha. A conta é confirmada, a pessoa entra pela senha, e fica sem organização e sem menu. Os moldes do app linkam com `token_hash`, que não depende de cookie nenhum.

  **A marca passa a seguir o banco.** O `marca-emails.sh` lê o `.env`, então trocar nome ou cor em **Configurações › Marca** não reescrevia os e-mails de acesso. Servindo pelo app, a marca é resolvida a cada busca e o GoTrue re-busca sozinho a cada 10 minutos (`GOTRUE_MAILER_TEMPLATE_MAX_AGE`) — sem reiniciar nada e sem rodar script.

  **Se você seguiu a receita antiga, troque as variáveis.** Até esta versão, `docs/deploy-selfhost/README.md` e o `marca-emails.sh` mandavam apontar `GOTRUE_MAILER_TEMPLATES_*` para um **caminho de arquivo**. Isso não funciona e falha calado: o GoTrue cola o que não começa com `http` no fim do `SITE_URL` e faz um GET, então ele busca `https://SEU_DOMINIO/opt/.../confirmation.html`, recebe o HTML da tela de login e manda **isso** para a caixa de entrada do cliente. Medido em 2026-09-09; o Gmail marcou como phishing.

  Achado instalando numa VPS com Supabase próprio, seguindo a documentação do produto do começo ao fim.

- **Guias do assistente para quem instala, opera e contribui com um CLI de IA** Com o repositório aberto no Claude Code, Codex, Cursor, OpenCode ou Antigravity, cinco guias carregam sozinhos na hora certa: instalar e consertar a instalação, montar um cliente por nicho (agentes, roteadores, follow-ups, base de conhecimento), analisar as métricas sem expor dado pessoal, afinar o prompt de um agente com dados, e contribuir com um PR que passa na triagem de primeira. O roteiro do kit de instalação foi corrigido (a verificação em duas etapas é opcional; três provedores de IA; token do Supabase) e o banner final do instalador passa a refletir a escolha de telemetria.

- **Chamada de voz pelo WhatsApp — ligar e atender de dentro do CRM** O CRM passa a fazer e receber ligações de voz pelo WhatsApp. Quem administra pareia um
  segundo aparelho no mesmo número, em **Configurações › Conexões**, e o botão **Chamar**
  aparece na ficha de todo contato com telefone. Chamada recebida toca para o time inteiro,
  como um telefone de escritório; o painel da ligação em andamento, com mudo e desligar, é só
  de quem está na linha.

  O que o sistema faz por conta própria enquanto isso acontece:

  - **O assistente se cala durante a ligação** naquela conversa e volta a falar quando você
    desliga. Ele não responde por cima de alguém que está ao telefone com o cliente.
  - **Ligação atendida conta como contato feito.** O negócio deixa de aparecer como parado no
    Radar de Risco, e o assistente para de propor "retomar contato" com quem você acabou de
    atender.
  - **Ligação atendida conta como trabalho seu** no relatório de atendentes.
  - **Chamada perdida vira aviso na Central**, com o número de quem ligou, o motivo em
    português e um botão para ligar de volta.
  - **A linha do tempo do negócio diz quem atendeu**, não "Sistema".

  Três recusas deliberadas, porque o certo é não fazer:

  - **Contato que pediu para não ser incomodado não recebe ligação.** Quem mandou "PARAR" já
    não recebia mensagem; agora também não recebe telefonema.
  - **Só quem está na linha desliga.** Ninguém derruba a ligação de um colega.
  - **Apagar o canal não apaga o histórico de ligações** — a exclusão vira arquivamento, e o
    diálogo diz quantas chamadas estão penduradas antes de você confirmar.

  Quem exercer o direito de ser esquecido tem o telefone das chamadas apagado junto com o
  resto; quem pedir seus dados recebe o registro das ligações no relatório.

  Nada muda para quem não parear o recurso: ele é opcional e nasce desligado.

  Trabalho original de @eudanielhenrique.

### Alterado

- **A marca do produto ganha símbolo e logotipo** Instalação que não configurou marca própria passa a mostrar o logotipo do
  Deskcomm no menu lateral, na tela de entrada e no ícone da aba do navegador —
  no lugar do nome em texto e da letra "D" sobre a cor de destaque. Quem já
  definiu nome ou logo próprio em Marca não vê nenhuma diferença: a marca
  configurada continua valendo em todos esses lugares.

- **No editor de follow-up, dá para organizar o fluxo e excluir um nó ou uma aresta** Montar um follow-up no canvas exigia arrastar cada bloco à mão, e o único botão de
  apagar era o do fluxo inteiro. Quem errava uma ligação tinha que desfazer o rascunho
  ou começar de novo.

  Agora, no editor, **Organizar** empilha o fluxo conectado de cima para baixo;
  **Excluir nó** e **Excluir aresta** saem no painel do item selecionado e na barra de
  cima — sem apagar o fluxo. As ligações passam a ser em degrau (não diagonais por
  cima dos blocos), e os botões de zoom do canvas seguem o tema escuro em vez de
  sumirem no fundo branco da biblioteca.

### Corrigido

- **Webhook de captação agora reconhece o formato de lead do RD Station** Ao apontar um webhook do RD Station para uma fonte de captação de leads, os
  envios reais não viravam lead: o RD Station empacota os dados dentro de uma
  lista (`leads: [...]`), e o leitor de campos do webhook só olhava o nível de
  cima, então nome, e-mail e telefone chegavam "em branco" e a captação era
  recusada. O botão interno "Enviar lead de teste" funcionava porque manda os
  campos soltos — o que escondia o problema.

  Agora o webhook reconhece esse formato: extrai o nome, o e-mail e o telefone
  (inclusive quando o telefone vem no campo de celular do RD, e não no campo de
  telefone comercial, que costuma vir vazio) e cria o lead na fonte/funil/etapa
  configurados. Reenvio do mesmo evento pelo RD Station não gera lead duplicado.

  Os formatos que já funcionavam (campos soltos, Respondi) continuam iguais. Você
  não precisa fazer nada para adotar — a partir desta versão os leads do RD
  Station passam a entrar sozinhos.

- **Preferências de aviso param de divergir entre o servidor e o navegador** A tela de configurações de notificação abria com o navegador discordando do HTML que o servidor tinha mandado. Quem havia desligado o push de mensagem via, por um instante, o interruptor ligado — e o React reagia a essa discordância descartando e refazendo a árvore da tela no cliente.

  O valor era lido dentro do inicializador de `useState`, que roda de novo na hidratação. Sem `window`, essa leitura devolve o padrão (tudo ligado); com `window`, devolve o que está no `localStorage`. Os dois lados não tinham como concordar para quem tivesse mudado qualquer preferência — em dez interruptores e no identificador que a tela de alertas procura.

  A tela passou a ler as preferências por `useSyncExternalStore`, o mesmo mecanismo que o seletor de tema já usa desde o #666: existe um valor determinístico para a comparação de hidratação, e só depois do commit o React troca para o valor real. O interruptor continua respondendo na hora, sem recarregar a página.

  Sem mudança de configuração: nada a editar no `.env` e nenhum passo a mais na atualização.

  Achado a partir do relato de que a divergência reaparecia a cada conserto — a leitura do navegador voltava para dentro de um inicializador novo. Junto vem a guarda que reprova esse padrão, para que a terceira instância não nasça igual.

- **Quem é convidado entra na empresa ao confirmar o e-mail, sem mais um clique** Confirmar o e-mail vindo de um convite passa a **criar o vínculo** e abrir o CRM já dentro da empresa. Antes, a confirmação levava a uma tela com um botão "Aceitar convite" — e quem não o apertava terminava autenticado, sem organização e sem menu, num CRM vazio.

  Três consertos, todos no ciclo de vida do vínculo:

  - **O convite é aceito na própria confirmação.** A rota já sabia tudo o que o botão exigia, e com garantia mais forte: o e-mail do convite é comparado com o que o provedor de autenticação acabou de confirmar. Se o vínculo falhar (convite revogado, banco fora), a tela de aceite continua existindo e recebe a pessoa — nada fica sem saída.
  - **Clicar duas vezes no link do e-mail não desloga mais ninguém.** O token é de uso único: o segundo clique falhava e mandava para a tela de login **quem já estava logado pelo primeiro**, com o cookie de sessão intacto. A pessoa reentrava pela senha e perdia o fio do convite. Agora a rota reconhece a sessão que já existe e segue.
  - **Acesso revogado deixa de virar convite para abrir empresa.** Quem tinha o vínculo retirado caía numa tela vazia oferecendo "Configure sua organização" — uma revogação virando criação de tenant. Agora vê uma tela que nomeia o que aconteceu, e a ação de recuperação recusa com o motivo certo, em vez da mensagem sobre convite pendente que aparecia por acaso.

  Nada muda na configuração: não há variável nova, passo de atualização nem mudança de schema.

  Achado instalando numa VPS com Supabase self-hosted, com dois convidados reais que não conseguiram entrar.

- **Conectar um número de WhatsApp voltou a funcionar** Conectar um número de WhatsApp novo — no onboarding ou pela Central de Conexões — e reconectar
  um número que caiu falhavam com "Falha na comunicação com o WhatsApp (WAHA)" (`waha_create_400`),
  e o canal ficava preso em "Parado" pedindo reparo.

  A causa: o identificador interno que o sistema gera para a sessão no WAHA tinha 69 caracteres, e
  a versão do WAHA que o kit usa recusa identificadores com mais de 54 — então nenhuma sessão nova
  chegava a ser criada do outro lado. O identificador passou a ter 45 caracteres.

  Canais que já ficaram presos por causa disso são consertados na atualização (o identificador é
  regravado no formato novo); nenhum número já pareado é tocado. Depois de atualizar, quem estava
  travado é só clicar em Conectar/Reconectar de novo.

- **Revogar um membro deixa de ser uma porta que só abre por fora** Revogar sumia com a pessoa. Ela desaparecia da lista de Equipe, e a única forma de devolver o acesso era emitir um convite novo — um caminho longo, com três becos, todos medidos numa instalação real com alguém de verdade preso neles.

  **O que muda:**

  - **O membro revogado continua na lista**, com o estado `Revogado`, e quem administra devolve o acesso pelo menu da própria linha. Antes ele simplesmente sumia.
  - **Quem já tem conta e clica num convite** deixa de receber *"Não foi possível criar a conta. Tente novamente."* — instrução impossível, porque tentar de novo nunca funciona. Passa a ler que já tem conta, com um botão que entra **e** cai direto no aceite.
  - **A tela de acesso revogado deixa de ser beco:** ela diz que, se chegou convite novo, o link do e-mail funciona mesmo dali.

  **Nada disso mudou o banco.** O comando que aceita convite já sabia reativar quem foi revogado, desde que o convite seja posterior à revogação — e foi exatamente isso que a prova em tela confirmou. O que faltava era caminho até ele.

  **Reativar não promove.** Ela devolve o papel que a pessoa tinha; trocar papel continua sendo outra ação, com outra rota. Juntar as duas faria uma reativação distraída virar promoção silenciosa.

  **Quem devolveu o acesso fica registrado** (`member.reactivated`). A coluna que guarda a revogação volta a ficar vazia e não conta história nenhuma — a trilha é a única resposta para "quem readmitiu esta pessoa, e quando?".

- **Uma requisição que demora demais não vira mais um erro genérico na tela** Quando uma chamada à API não respondia a tempo, o navegador mostrava um erro genérico ("signal is aborted without reason") em vez de dizer que foi um tempo esgotado. Agora o motivo do cancelamento vem explícito, com o mesmo nome que o resto do produto já usa para timeout — quem lida com o erro consegue reconhecê-lo, e quem só vê a tela entende o que aconteceu.

- **A chamada de voz avisa quando não há áudio, em vez de contar o tempo em silêncio** O painel da ligação em andamento mostrava o cronômetro correndo assim que o WhatsApp
  atendia — e o cronômetro continuava correndo mesmo quando o som não chegava ao navegador.
  Uma ligação muda tinha exatamente a mesma aparência de uma ligação perfeita: nenhum aviso,
  nenhum sinal, só o relógio. Quem instalou numa VPS ficava sem saber se o problema era o
  microfone, a rede do escritório ou o produto.

  Agora o painel escuta a conexão de áudio de verdade. Enquanto ela está abrindo, ele diz
  **"Abrindo o áudio…"**. Se ela não abrir, ele diz **"Sem áudio: o canal de voz não abriu"**
  — e o cronômetro continua, porque a ligação existe mesmo e o outro lado está esperando. O
  silêncio deixa de se disfarçar de normalidade.

  Se o servidor de voz demorar demais para responder, o aviso aparece em até 12 segundos, em
  vez de "Abrindo o áudio…" para sempre. E se a conexão se restabelecer depois de um soluço
  de rede, o aviso some sozinho.

  Nada muda para quem não usa chamada de voz.

  Trabalho original da chamada de voz de @eudanielhenrique.

- **O laço rápido do worker volta a montar o admin client** `@react-pdf/hyphenate` é ESM puro e não expunha a condição `require` no seu `exports`. Como o worker roda via `tsx` (CommonJS), qualquer import de `@react-pdf/renderer` (usado pela exportação de dados LGPD) derrubava `carregarDeps()` do drain loop com `ERR_PACKAGE_PATH_NOT_EXPORTED` — e como `register-handlers.ts` registra os 12 handlers do `event_log` num só import chain, isso tirava o laço rápido de TODOS eles, não só do LGPD, caindo pro cron de 1×/min como única rede de segurança.

  Patch (`patches/@react-pdf__hyphenate.patch`) acrescenta a condição `require` ao exports map — Node 22.12+/24 já sabe carregar ESM via `require()` quando o mapa permite. Provado no worker real: o warning "event-log drain OFF" some do log de boot.

## [1.18.1] — 2026-09-11

### Corrigido

- **Campo de múltipla escolha volta a ser editável nas configurações do funil** Um campo do funil do tipo "múltipla escolha" abria em Configurações → Funis com o seletor de tipo em branco e sem a lista de opções, como se estivesse corrompido — não dava para editá-lo, e trocar o tipo para tirar o branco rebaixava a escolha múltipla para escolha única. Agora a tela oferece todos os tipos que o sistema aceita e mostra as opções de qualquer campo de lista fechada.

- **A letra volta a aparecer sobre o destaque colorido da agenda** Na agenda, o que estava selecionado — a aba do histórico, o dia de hoje na grade, o horário escolhido na marcação — pintava o fundo com a cor da marca e deixava a letra na cor do texto da página. Em instalação com marca escura, isso era escuro sobre escuro. A letra agora recebe a cor de contraste que a marca calcula, nos dois temas.

- **O seletor de tema não gera mais erro de hidratação no console** Quem tinha o tema escuro (ou claro) salvo via, no console do navegador, um aviso de "hydration mismatch" ao abrir qualquer tela — o React reclamando que o HTML do servidor e o do navegador não batiam no ícone e no texto do botão de tema. O visual não quebrava, mas o erro aparecia sempre. Agora a primeira renderização do navegador bate com a do servidor, e o tema salvo é aplicado logo em seguida, sem gerar aviso nenhum.

## [1.18.0] — 2026-09-10

### Adicionado

- **A IA espera e mostra "digitando…" antes da primeira resposta** O atendimento automático deixa de responder no mesmo instante em que termina de pensar. Antes da primeira mensagem de cada resposta, ele acende o "digitando…" no WhatsApp do cliente e espera um tempo proporcional ao tamanho do texto — entre 1,2 e 7,5 segundos.

  A pausa acontece uma vez por resposta. O intervalo entre as mensagens seguintes continua sendo o mesmo de sempre, o que protege o número contra bloqueio.

  Nada muda na configuração: não há variável nova para preencher nem passo de atualização.

  Trabalho original de @w4rlockem, a partir do relato de um dono de instalação de que a IA "responde rápido demais, parece robô".

- **Central de avisos ganha o botão "Marcar todos resolvidos"** A Central de avisos (`/app/ai/inbox`) só resolvia aviso por aviso. Com a lista acumulando —
  144 abertos numa instalação real — a única saída era clicar item a item. Agora, na aba
  "Abertos", o botão **Marcar todos resolvidos** fecha todos de uma vez: uma única atualização
  escopada à sua organização, registrada na auditoria com a contagem. Se o lote falhar, a tela
  avisa e pede para conferir a lista — nada é fechado em silêncio.

  No mesmo passe, o título e o texto de cada aviso deixaram de passar pelo tradutor da
  interface. Eles são escritos no momento do evento e carregam nome de cliente, número e o que
  você cadastrou; quem usa o sistema em espanhol passa a ler o aviso exatamente como ele foi
  gravado. Os rótulos da tela seguem traduzidos.

  Trabalho original de @rafaelbatistazz.

- **A IA passa a preencher os campos que você criou no funil** Você pode declarar até 50 campos por funil — prescritor, metragem do imóvel,
  convênio, o que o seu negócio precisa — e a ficha do lead desenha todos eles.
  Só que nenhum agente de IA conseguia escrever num campo desses: ele lia a
  conversa, entendia o dado e não tinha onde guardar.

  Agora tem. Quando o agente descobre uma informação que você declarou como campo
  do funil, ele grava ali — e a mudança aparece na linha do tempo do lead como
  qualquer outra edição, com o autor identificado.

  Nada muda para quem não usa campos personalizados, e nada muda no que os agentes
  já faziam. Quem instrui o agente a preencher um campo passa a ser obedecido; quem
  não instrui, segue igual.

  Contribuição de **@rafaeskytrabalho**.

- **O balão do atendimento mostra de onde saiu cada mensagem** O balão de uma mensagem enviada agora identifica a origem dela: **Celular** para
  a resposta dada pelo WhatsApp do telefone (fora do CRM), **IA** para o agente,
  **Você** para o que você mesmo digitou no CRM e **Atendente** para o que outra
  pessoa da equipe digitou.

  Antes, só a IA era identificada. A resposta dada pelo celular chegava à conversa
  sem rótulo e parecia ter sido digitada no CRM — enquanto o painel de atividade já
  contava esse atendimento como feito por fora. Agora a conversa mostra o que o
  painel sempre soube.

- **O aviso de compromisso ganha quem o dispare — e quem o ligue** O tipo de agendamento sempre teve "avisar o cliente antes" e quantos minutos
  antes avisar. Não havia quem lesse nem quem ligasse: a configuração existia no
  banco, nenhuma parte do sistema olhava para ela, e não havia controle nenhum na
  tela.

  Agora existe o par inteiro. Em **Configurações › Tipos de agendamento**, cada
  tipo tem "Avisar o cliente antes do compromisso, pelo WhatsApp" e quantos
  minutos antes — de 15 minutos a 7 dias. A lista mostra quem está ligado, sem
  precisar abrir nada: quem olha a tela sabe de que tipo vai sair mensagem.

  A cada cinco minutos o sistema procura compromisso confirmado que está chegando,
  cuja antecedência já venceu e que ainda não foi avisado, e manda para a pessoa
  vinculada uma mensagem no WhatsApp com o que é, quando e onde.

  Só chega a quem está vinculado ao compromisso: agendamento sem pessoa vinculada
  continua sendo só uma linha na sua agenda, como era. O aviso respeita a janela
  de envio do canal — ninguém é acordado às seis da manhã por causa de uma
  retirada às dez —, e sai uma vez só por compromisso.

  Quem recusou receber campanha **continua recebendo** o aviso do próprio
  compromisso: dizer a alguém que o pedido dele está pronto não é propaganda.

  **Nada começa a sair sozinho.** O aviso nasce desligado em todo tipo de
  agendamento, e atualizar não liga nada em lugar nenhum: mandar mensagem para o
  telefone de um cliente é irreversível, e ninguém deve ser inscrito nisso por um
  valor padrão. Enquanto ninguém marcar a caixa, nenhuma instalação envia lembrete.

  Desligar o aviso guarda a antecedência escolhida — religar amanhã não faz
  começar de novo.

  Contribuição de **@rafaeskytrabalho**.

### Corrigido

- **A barra lateral volta a acompanhar a página** Em tela com conteúdo longo — a agenda, o kanban cheio, a lista de contatos — a
  barra de navegação rolava junto com a página: você descia, o menu subia e sumia,
  e sobrava uma faixa vazia no lugar dele. Para trocar de tela era preciso voltar
  ao topo.

  Ela agora fica parada enquanto o conteúdo rola, que é como sempre foi a intenção.

  Nada muda no que você faz nem na configuração; é comportamento de tela.

  Contribuição de **@rafaeskytrabalho**.

- **A IA não envia falso aviso de mensagem vazia** Antes de enviar uma resposta, o atendimento automático bloqueia a afirmação de que a mensagem chegou vazia quando o texto recebido está confirmado no CRM.

  Trabalho original de @CristianoFF43, medido na instalação dele.

- **Abrir uma conversa por link direto para de esperar a lista carregar** Quem chega ao Inbox por um link direto para uma conversa — `/app/inbox/<id>`, o clique num
  aviso, o retorno de uma tela de IA — via a coluna do contato (demandas, memória, negócios)
  demorar vários segundos a mais que o resto da tela, sobretudo quando a conversa não aparece na
  aba aberta (por exemplo, uma conversa já encerrada).

  A causa era ordem, não peso: a busca da conversa por id só começava depois de a lista de
  conversas terminar de carregar — e a lista carrega **duas vezes** por abertura de tela, porque
  o filtro da aba Fila muda quando o sistema descobre se a organização tem atendimento automático
  de pé. Eram quatro idas ao servidor em fila indiana antes de o painel do contato poder começar.

  Agora a busca da conversa sai junto com a lista, e não atrás dela.

- **A IA para de perder os horários da noite quando o cliente pede um dia** Quando o cliente nomeava uma data ("pode ser dia 13?"), o atendimento automático
  montava o dia de meia-noite a meia-noite no relógio de Londres. Em quem atende no
  Amazonas, esse dia terminava às 19h59 — e um horário das 21h que o próprio
  atendimento tinha acabado de oferecer sumia da consulta seguinte, como se a agenda
  estivesse cheia. Agora o dia pedido é o dia do fuso da agenda, do começo ao fim.

  Achado e corrigido por @CristianoFF43, na instalação dele, no PR #612.

- **A IA passa a responder à última mensagem recebida** O atendimento automático deixa de tratar como vazia uma mensagem que chegou com texto quando um resumo anterior estiver incorreto.

  Trabalho original de @CristianoFF43, medido na instalação dele.

- **Conectar um número de WhatsApp voltou a funcionar** Conectar um número de WhatsApp novo — no onboarding ou pela Central de Conexões — e reconectar
  um número que caiu falhavam com "Falha na comunicação com o WhatsApp (WAHA)" (`waha_create_400`),
  e o canal ficava preso em "Parado" pedindo reparo.

  A causa: o identificador interno que o sistema gera para a sessão no WAHA tinha 69 caracteres, e
  a versão do WAHA que o kit usa recusa identificadores com mais de 54 — então nenhuma sessão nova
  chegava a ser criada do outro lado. O identificador passou a ter 45 caracteres.

  Canais que já ficaram presos por causa disso são consertados na atualização (o identificador é
  regravado no formato novo); nenhum número já pareado é tocado. Depois de atualizar, quem estava
  travado é só clicar em Conectar/Reconectar de novo.

## [1.17.0] — 2026-09-08

### Adicionado

- **Acompanhar uma organização com acesso temporário de verdade** A administração abre a organização escolhida com a identidade real de quem
  presta suporte. É possível escolher edição ou somente leitura, sem adicionar
  um membro permanente à equipe. O banner identifica a organização e oferece a
  saída; ao encerrar, os dados da organização anterior são carregados novamente.

  O modo somente leitura também impede alterações feitas por chamadas diretas.
  Quando o prazo ou a permissão terminam, a tela pede encerrar o acompanhamento
  antes de continuar.

  As atualizações em tempo real aguardam a autenticação antes de abrir os canais,
  inclusive ao trocar de organização ou acompanhar em mais de uma aba.

- **Crie o Google Meet e acompanhe a entrega do link na conversa** Compromissos com local Google Meet solicitam o link na agenda Google escolhida. O detalhe mostra criação pendente, link pronto ou falha com nova verificação. Quando pronto, você pode abrir e copiar o link.

  O envio na conversa tem autorização e estado próprios. Escolha o atendimento e use “Enviar quando ficar pronto” ou “Enviar link ao cliente”. Marcar pelo assistente no atendimento atual agenda essa entrega. Se o atendimento mudar, a equipe recebe um aviso e pode autorizar uma nova entrega. Criar o link não significa que a mensagem já foi enviada.

  Autorizar somente o link em um atendimento humano não ativa a IA nem muda o responsável ou o silêncio configurado. Bloqueios de mensagens e restrições do canal continuam valendo, com orientação no detalhe.

  Depois de encerrar e reabrir o atendimento, uma nova entrega exige outro clique de autorização. Avisos da Central abrem o compromisso correspondente. O PDF de acesso aos dados também inclui entregas de links e avisos sobre compromissos, com seus estados e datas.

- **Escolha suas agendas e resolva mudanças entre a Agenda e o Google** Em Configurações → Agenda, escolha quais agendas Google ocupam seus horários e um destino gravável para novos compromissos. Os já publicados continuam na agenda original. Mudanças de horário e cancelamento são reconciliadas; quando ambos os lados mudam, o detalhe mostra a comparação e pede uma decisão. Alterar só o horário preserva os campos modificados diretamente no Google.

  A tela informa erro, última sincronização, leitura parcial e retentativa. Comparecimento e falta continuam sendo fatos registrados pela equipe; mudanças no Google preservam o contato, a conversa e o histórico daqui.

  Retentativas conservam a identidade do compromisso. Uma edição concorrente continua pendente até ser reconciliada; corrigir uma série no Google permite retomar a comparação. A anonimização encerra a sincronização daquele titular sem impedir outros compromissos.

- **Confirme presença e acompanhe faltas pela Agenda** Compromissos podem ser ligados ao contato e à conversa. A equipe registra comparecimento, falta ou cancelamento; a Central lembra quando falta confirmar, com prazos ajustáveis em Configurações. A agenda protege o cliente de cobranças de silêncio indevidas. Faltas confirmadas podem iniciar um fluxo configurado, e o compromisso mostra quando outro acompanhamento ou a configuração impedem o início. Resposta do cliente, cancelamento e remarcação interrompem a recuperação antiga.

  As datas do detalhe seguem o idioma escolhido e o fuso do compromisso, inclusive quando ele termina no dia seguinte.

- **Testar o agente e revisar suas respostas antes de enviar** O agente pode preparar sugestões automaticamente para revisão humana. É possível editar,
  aprovar ou rejeitar o texto na conversa, acompanhar o envio e informar o que deve melhorar.
  Uma conversa alterada exige nova revisão. A aprovação do texto não executa mudanças no CRM
  ou na agenda.

  Pausar o atendimento automático preserva a versão publicada e mantém a assistência
  à equipe. O teste usa o motor e o conhecimento do agente, apresenta propostas sem
  aplicá-las ao cliente e fica disponível antes da publicação. Agentes antigos podem
  concluir a configuração pela própria tela, preservando instruções e conhecimento.

- **Abra o contexto dos avisos sem perder o acompanhamento** A Central oferece acesso à conversa, ao contato, ao negócio ou à configuração correspondente quando seu acesso permite. Contextos removidos ou indisponíveis recebem orientação sem link quebrado. Abrir o contexto mantém o aviso aberto; resolver e reabrir continuam sendo escolhas separadas.

- **Encerre a conversa e registre o resultado da demanda separadamente** O atendimento agora diferencia fechar uma conversa de concluir a demanda do cliente. O painel mostra a demanda vigente, permite registrar seu resultado e mantém os fatos duráveis do contato e o histórico encerrado.

  Uma nova mensagem após o fechamento reabre a fila com uma nova demanda. Trabalhos automáticos de um atendimento encerrado deixam de executar ações ou enviar respostas antigas depois da reabertura.

- **Escolha as áreas visíveis para cada pessoa da equipe** Quem administra pode escolher uma interface completa, simplificada ou personalizada por membro, inclusive antes de enviar o convite. A escolha vale em cada organização e atualiza a navegação de quem já está trabalhando sem fechar sua tela.

  A interface simplificada mantém as áreas de trabalho e Conexões quando o papel permite. A seleção muda o menu, a busca e a página inicial; permissões e links das conversas continuam seguindo o papel da pessoa.

- **Criar organizações já entrega acesso e convite ao responsável** Quem administra a instalação encontra Gerenciar organizações no seletor, mesmo
  quando só participa de uma empresa. A nova organização já inclui seu criador
  como administrador e oferece um convite copiável ao responsável, inclusive sem
  e-mail configurado. Falhas de criação não deixam empresas sem administrador.

  A troca de empresa reinicia os dados da tela e aceita somente acessos ativos.
  Reabrir um convite antigo não restaura privilégios removidos.

  Se a resposta da criação se perder, tentar novamente recupera a mesma organização
  e o link. O recibo dessa operação é protegido contra alterações por membros.

- **Escolha quem atende cada número e recupere conexões com segurança** Em Configurações › Atendimento, escolha os responsáveis de cada número. A capacidade da pessoa continua compartilhada entre canais; uma lista vazia deixa as conversas na fila, com aviso e novas tentativas. Conexões mostra o resumo e o caminho para ajustar a equipe.

  Conectar um número preserva a identidade em falhas e permite reparar a tentativa. Conflitos do serviço só contam como sucesso depois da confirmação da sessão correta. A versão padrão mantém a possibilidade de mais de uma sessão sem bloqueio por tier; a prova local cobre duas sessões aguardando QR, sem pairing ou envio real.

### Corrigido

- **A instalação não para mais no passo de criar o primeiro administrador** Instalar numa VPS podia falhar bem no fim, ao criar o primeiro administrador,
  com uma mensagem de erro do banco de dados. Quando acontecia, o banco já estava
  montado e as configurações já estavam gravadas — a instalação parava com tudo
  quase pronto e a tela oferecendo recomeçar do zero.

  O passo foi corrigido e o instalador passa a verificar isso sozinho antes de
  publicar uma versão nova, para que a falha não volte.

- **O endereço responde mesmo quando a hospedagem usa nomes próprios de porta** Em hospedagens com painel próprio (EasyPanel, entre outras), a instalação podia
  terminar com tudo no ar por dentro e o endereço mostrando a página de erro do
  painel: o instalador supunha os nomes que a hospedagem dá às portas 80 e 443, e
  quando eles eram diferentes o roteamento simplesmente não acontecia — sem erro
  em lugar nenhum.

  Agora o instalador lê esses nomes da própria hospedagem e mostra quais
  encontrou. Quem já tinha escolhido os nomes à mão continua com a escolha; quem
  instalou antes e ficou com o endereço mudo pode rodar a instalação de novo para
  que ela os detecte.

## [1.16.1] — 2026-09-07

### Corrigido

- **A conferência de imagens do instalador passa a olhar o registro que a instalação usa** Antes de baixar as imagens, o instalador confere se as três existem e são
  públicas. Essa conferência olhava sempre para o registro do projeto, mesmo em
  instalações configuradas para usar outro — então ela dizia "está tudo publicado"
  depois de conferir pacotes que não eram os que a instalação ia baixar, e o erro
  só aparecia mais tarde, na hora de subir. Agora ela olha o mesmo registro que a
  instalação usa.

  Nada muda para quem não trocou o registro: continua conferindo os mesmos
  pacotes, com o mesmo resultado.

## [1.16.0] — 2026-09-07

### Adicionado

- **Teste a IA no WhatsApp antes de abrir o atendimento ao público** Em Conexões, administradores podem ativar o modo de teste e cadastrar números
  de confiança por canal. Lista vazia bloqueia respostas automáticas; as mensagens
  continuam chegando ao Inbox para atendimento humano. Após validar, a abertura
  ao público exige confirmação e preserva a lista para uma futura rodada de testes.

  Novos canais começam em teste, sem números autorizados. Canais existentes e
  reconexões preservam a configuração atual. A atualização inclui a migration
  0218 no baseline; não é preciso editar variáveis de ambiente.

  Muda também para quem não vai usar o modo de teste: o follow-up automático por
  silêncio passa a usar a mesma regra do atendimento de entrada, e num canal com
  acesso da IA restrito ele deixa de inscrever contato cuja autorização já venceu
  (o prazo é o de sempre, `AI_ALLOWLIST_TTL_DAYS`). Antes bastava ter sido
  autorizado um dia; agora a autorização precisa estar valendo.

### Corrigido

- **A avaliação automática do atendimento volta a rodar em quem não usa Anthropic** A rodada que revisa os atendimentos e sugere melhorias pedia um modelo pelo nome
  fixo `claude-haiku-4-5`. Esse nome só existe no vocabulário da Anthropic, então
  em instalação apontada para outro provedor (OpenRouter, por exemplo) o provedor
  recusava a chamada e a rodada morria a cada disparo, sem sugestão nenhuma
  chegando à tela de Propostas. Agora os dois pontos do flywheel usam o modelo
  escolhido no painel de provedores e, na falta dele, o padrão da organização — o
  mesmo caminho de todos os outros pontos de IA.

- **A chave de IA cadastrada pela organização passa a valer também na medição de clima e na resposta do bot** Dois pontos de IA — "Medir o clima da conversa" e a resposta do bot — só usavam
  a credencial cadastrada em IA › Credenciais quando havia uma escolha explícita
  no painel de provedores. Sem essa escolha, eles iam direto para a chave que veio
  na instalação (`.env`), ignorando a chave que a organização cadastrou e validou
  na tela. Numa instalação cuja chave de `.env` estava revogada, isso aparecia
  como classificação de clima falhando com erro de autenticação enquanto o agente,
  que já usava a credencial da organização, respondia normalmente no mesmo minuto.

  Agora os dois seguem a mesma ordem do resto do produto: a escolha do painel,
  depois a credencial ativa e validada do provedor da organização e, só então, a
  chave da instalação. Nada a fazer — quem já tem credencial cadastrada passa a
  usá-la na próxima chamada.

- **O rodapé volta a mostrar a versão que está no ar, e não a de um rollback antigo** Quando uma atualização pela tela falha e o app volta sozinho para a versão
  anterior, o sistema passa a mostrar essa versão anterior — o que está certo:
  naquele momento o código baixado no servidor já é o novo, mas o app que subiu é
  o velho, e quem sabe qual dos dois está no ar é o registro da tentativa.

  O que faltava era o fim dessa validade. O app troca de versão por outros
  caminhos que não passam por essa tela — um deploy automático, um comando no
  terminal, a atualização feita à mão —, e nenhum deles registra uma tentativa
  nova. Sem isso, a tentativa que falhou continuava sendo a última notícia, para
  sempre: numa instalação real, o rodapé anunciou por oito dias uma versão de 28
  de agosto, atravessando vários deploys, enquanto a versão no ar era outra.

  Agora a tentativa antiga só nomeia a versão no ar enquanto for a notícia mais
  recente. Se o servidor reportou a versão depois de a tentativa ter terminado, é
  o servidor que vale. Isso conserta junto duas coisas que bebiam da mesma fonte:
  o aviso de "atualização disponível", que comparava contra a versão errada, e as
  notas de versão, que começavam a listar de um ponto errado do histórico.

  Nada muda para quem opera: nenhuma configuração nova, nenhum passo de
  atualização, nenhuma mudança no banco.

- **O espanhol cobre mais telas e mais mensagens de erro** Várias telas e mensagens de erro apareciam em português mesmo com a
  organização configurada para espanhol: o badge de status de um agente de
  IA, o painel de Segurança (STOP, LGPD, ritmo de envio…), os avisos de
  provedores de IA, os erros de verificação em duas etapas, os avisos de
  número/conta do WhatsApp na Central, o resumo de impacto ao excluir um
  número, e toda a mensagem de erro do módulo de Tarefas. Numa tela de
  Agenda da organização, o nome que o próprio operador deu a um tipo de
  atendimento chegou a ser traduzido por engano, trocando "Retorno" por
  "Seguimiento". Todos os casos foram corrigidos.

- **O botão de importar planilha volta a funcionar, e os leads entram na primeira etapa aberta do funil** O botão *Importar planilha*, no quadro do funil, estava morto. Quem escolhia o
  funil e mandava a planilha recebia sempre o mesmo aviso de erro — *"Escolha o
  funil e a etapa de destino"* — mesmo tendo escolhido o funil. Nenhum lead era
  criado, e não havia nada que o operador pudesse fazer para contornar: a tela não
  tem, nem deveria ter, um campo de etapa. A capacidade foi anunciada na 1.14.0 e
  seguiu assim nas duas atualizações seguintes — quem instalou a 1.14.0, a 1.15.0
  ou a 1.15.1 nunca conseguiu importar uma planilha.

  A causa era essa incompatibilidade mesmo: a tela pergunta só o funil, porque
  planilha traz gente nova e gente nova entra no começo do funil; o servidor, por
  outro lado, exigia que a etapa viesse junto. Agora o servidor resolve a etapa
  sozinho, que é o que a tela sempre prometeu.

  E ele resolve a etapa **aberta** de menos avançada — pulando as etapas de ganho
  e as de perda. Isso importa para quem reorganizou o próprio funil: numa
  instalação onde uma etapa do tipo *Pago* ou *Cancelado* foi arrastada para a
  primeira coluna, a importação teria feito a planilha inteira nascer como negócio
  já ganho, ou teria recusado todas as linhas devolvendo *"0 leads criados"* sem
  explicar por quê. Quem nunca mexeu na ordem das etapas não estava exposto a
  isso, porque o funil que vem pronto já começa com uma etapa aberta.

  Nada muda no dia a dia de quem opera a instalação: nenhuma configuração nova,
  nenhum passo de atualização, e nenhum lead já importado é tocado.

  O achado é de @JowaniOrantes, que encontrou o problema usando o sistema pela
  tela enquanto conferia a tradução para o espanhol — não lendo código.

## [1.15.1] — 2026-09-05

### Corrigido

- **Quem se cadastra numa instalação que não pede confirmação de e-mail para de ser mandado esperar um e-mail que não chega** Quem administra a instalação pode desligar a confirmação de e-mail no provedor
  de autenticação — é uma escolha comum, e às vezes é o estado em que uma VPS
  recém-montada já vem. Nesse modo, criar a conta **já entra no sistema**: não
  existe link nenhum para clicar, porque e-mail nenhum é enviado.

  A tela do cadastro não sabia disso e dizia assim mesmo: *"Enviamos um link de
  confirmação para o seu e-mail. Abra o e-mail e clique no link para ativar sua
  conta."* A pessoa fazia o que a tela mandou — esperava. O e-mail nunca chegava.
  Ela estava, o tempo todo, do lado de dentro, com a conta pronta e sem empresa
  nenhuma configurada, sem nenhuma razão para descobrir sozinha que bastava
  continuar.

  Agora, quando o sistema percebe que a pessoa já entrou, ele a leva direto ao
  passo seguinte, em vez de mandá-la esperar: quem se cadastrou por conta própria
  vai concluir a configuração da empresa, com o nome que ela mesma digitou no
  cadastro já preenchido; quem se cadastrou a partir de um convite vai aceitar o
  convite, e continua sem ganhar uma empresa própria por engano.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização. Quem já usa o sistema com confirmação de
  e-mail ligada não vê diferença nenhuma — a tela do e-mail continua igual, porque
  nesse caso o e-mail realmente vai chegar.

  O achado é de @KIRAzinx566, que instalou o sistema para um cliente e o encontrou
  parado nessa tela.

## [1.15.0] — 2026-09-05

### Adicionado

- **Meta Ads — o desempenho das campanhas dentro do CRM** Análise ganhou uma tela de Meta Ads: as campanhas da conta de anúncios com
  resultado, custo por resultado, gasto, alcance, CPM, CTR, CPC e mais, lidos da
  plataforma quando se clica em Atualizar.

  Nada é armazenado — só a credencial de leitura, criptografada, conectada em
  Configurações › Meta Ads. A conexão é só de leitura: nada é alterado na conta de
  anúncios.

- **A venda fechada no CRM volta para o anúncio que a trouxe** Quem paga tráfego não tinha como contar à plataforma quais leads viraram
  dinheiro, então o algoritmo otimizava por conversa iniciada, não por venda.

  Agora, marcar um negócio como ganho reporta a venda, com o valor. Configura-se
  em Configurações › Conversões, com token criptografado, botão de pausa e a lista
  do que falhou. Sem credencial, nada muda.

- **O compromisso da agenda agora convida o cliente por e-mail** Não havia onde escrever o e-mail do cliente, então o convite do Google nunca era
  enviado a ninguém.

  O novo agendamento ganhou um campo de convidado: ele recebe o convite e a
  resposta aparece no evento. Em branco, tudo segue como antes.

- **Juntar contatos duplicados** A mesma pessoa cadastrada duas vezes agora vira uma só, pela tela. Em
  **Contatos**, o botão "Duplicados" mostra os cadastros que parecem ser da mesma
  pessoa, lado a lado; você escolhe qual fica e junta.

  O sistema encontra os pares que o cadastro sozinho não vê: o mesmo celular
  escrito de dois jeitos (com e sem o nono dígito), o mesmo e-mail, e o número que
  o WhatsApp encontrou repetido e deixou marcado esperando alguém decidir.

  **Nada de histórico se perde.** Mensagens, negócios do funil, atividades,
  tarefas e anexos passam todos para o cadastro que fica — inclusive o que ainda
  não existia quando isto foi escrito: a lista do que precisa ser movido é lida do
  próprio banco na hora, não de uma lista fixa. O WhatsApp do cadastro antigo passa
  a cair no que ficou, então a mensagem seguinte não recria a duplicata.

  Quando os dois cadastros já conversavam pelo **mesmo número de WhatsApp**, a
  *conversa* do cadastro antigo não pode ser transferida — o sistema guarda uma
  conversa por pessoa em cada número, e o cadastro que fica já tem a dele. As
  mensagens vão todas para quem ficou; a conversa antiga permanece registrada, e
  a tela avisa **quantos** registros ficaram para trás em vez de dizer só
  "pronto".

  O cadastro absorvido **não é apagado** — ele sai da lista de contatos e fica
  como registro da fusão, e é isso que libera o telefone e o e-mail para o
  cadastro que ficou herdar o que faltava nele. Campos que o cadastro vencedor já tinha preenchidos nunca são
  sobrescritos; CPF e consentimento de contato não são herdados de propósito, por
  serem registro legal de uma pessoa específica.

  Junção fica com quem tem papel de **gerente** ou acima, aparece no histórico do
  negócio e é registrada na auditoria. **Não há como desfazer**, então a escolha
  de qual cadastro fica é sempre sua — o sistema apenas sugere o de atividade mais
  recente — e antes de juntar aparece uma confirmação dizendo, pelo nome, qual
  cadastro fica e qual é absorvido. Contato anonimizado por pedido de LGPD nunca entra numa junção.

  Nada muda para quem não usar: sem clicar em "Duplicados", tudo segue como antes.

  Isto veio da contribuição de James, da Clínica Centro do Sorriso
  (**@clinicacentrodosorrisosc-code**), que resolvia o mesmo problema no nível do
  card do funil; aqui a peça é o contato, que é a mesma em todo tipo de negócio.

- **Selecionar vários cards do funil e agir neles de uma vez** Mover trinta negócios de etapa deixou de ser trinta arrastes. No quadro do
  funil, cada card ganhou uma caixa de seleção, e o cabeçalho de cada etapa ganhou
  outra que marca a etapa inteira de uma vez. Segurando **Shift**, um clique
  seleciona tudo entre o card anterior e o que você clicou; **Ctrl** (ou **⌘**)
  continua marcando um a um. O clique simples segue abrindo o negócio, como sempre.

  Com algo selecionado, a barra que aparece no rodapé faz o resto: mover para
  outra etapa, aplicar ou tirar etiqueta, excluir — e agora também
  **trocar o responsável para qualquer atendente da equipe**, não só para você.
  Redistribuir a carteira de quem saiu de férias virou uma operação de dois
  cliques.

  Três detalhes que só se percebe usando:

  - A contagem no alto da etapa mostra quantos você marcou dela ("7/23"), para não
    ser preciso conferir card a card.
  - Seleções grandes não esbarram mais num limite invisível: acima de cinquenta, o
    sistema divide sozinho. Se algo falhar no meio, ele diz **quantos** já haviam
    sido alterados, em vez de só "deu erro".
  - A ordem dos cards movidos é preservada na etapa de destino, e eles entram no
    fim dela. Antes, um lote inteiro caía na mesma posição — o quadro se
    reorganizava sozinho a cada atualização, e o primeiro arraste depois disso
    podia jogar um card para um lugar imprevisível. Isso acabou.

  A barra também passou a falar o vocabulário do funil: quem renomeou "Lead" para
  "Cliente" ou "Pedido" vê a própria palavra.

  Nada precisa ser ligado, e nada muda para quem prefere arrastar um por um.

  Isto veio da contribuição de James, da Clínica Centro do Sorriso
  (**@clinicacentrodosorrisosc-code**).

- **Relatório de atividades — o que aconteceu no período, e quem fez** Uma tela nova, **Atividades**, dentro de Análise: o que aconteceu na operação
  nos últimos 7, 30 ou 90 dias. Até aqui o histórico só existia dentro de cada
  negócio — responder "o que a equipe fez esta semana" obrigava a abrir negócio
  por negócio.

  A tela abre com a resposta em três números: quanto do trabalho foi **da equipe**,
  quanto foi **dos agentes de IA**, e quanto foi **automático** — regra, sistema,
  ou a própria pessoa atendida. Um mês inteiro atendido pela IA e um mês inteiro
  atendido pela equipe têm o mesmo resultado no funil e histórias opostas; esta é
  a tela que separa as duas.

  Abaixo, o período em barras por dia (dia parado aparece como buraco, que é a
  informação), o ranking de quem trabalhou, o ranking do que foi feito, e a lista
  dos acontecimentos mais recentes — cada linha com um atalho para o negócio de
  onde ela veio. Quando a lista é cortada, a tela diz que cortou e quantos houve
  no total: período movimentado não vai parecer calmo.

  O dia é agrupado no fuso de quem lê, não no do servidor: o atendimento das 21h
  conta no dia em que aconteceu.

  Cada pessoa vê o que já podia ver — quem atende em modo "só os meus" continua
  vendo só os próprios negócios, e o relatório de uma organização nunca conta a
  atividade de outra.

  Isto veio da contribuição de James, da Clínica Centro do Sorriso
  (**@clinicacentrodosorrisosc-code**).

- **Tarefas com prazo, no CRM** "Ligar de volta na terça" agora tem onde morar. Uma tela nova, em
  **CRM › Tarefas**, guarda o que o time combinou fazer — com prazo, prioridade
  e a opção de prender a tarefa a um negócio.

  A lista separa o que já venceu do que vence hoje, desta semana e mais tarde. E
  há um calendário do mês para quem prefere ver o prazo no lugar dele: clicar num
  dia abre a tarefa já com aquela data.

  Tarefa presa a um negócio deixa uma linha na história dele. Quem abre o card vê
  que há um retorno combinado, em vez de encontrar uma conversa que parou sem
  explicação — e a conclusão fica registrada também.

  Quem só acompanha (papel "visualizador") enxerga o que o time combinou; criar,
  editar e apagar é a partir do papel de atendente.

  Isto veio da contribuição de James, da Clínica Centro do Sorriso
  (**@clinicacentrodosorrisosc-code**), que usou o sistema numa operação real por
  seis semanas e construiu o módulo do zero.

- **Recomeçar do zero os dados de teste da organização** Quem passou dias experimentando — mandando mensagem para o próprio número,
  criando contato de mentira, arrastando negócio no funil — agora limpa tudo antes
  de atender cliente de verdade.

  Em **Configurações › Organização** há a **Zona de perigo**: ela apaga de vez as
  mensagens, conversas, negócios, contatos, agendamentos e pedidos daquela
  organização. Continuam de pé a equipe, as configurações, os funis, os agentes de
  IA e os canais de WhatsApp — o que deu trabalho para configurar não se refaz.

  Só quem administra enxerga o botão, e ele não dispara no clique: é preciso
  digitar o nome da empresa como está cadastrado. O sistema confere esse nome de
  novo no servidor e registra na auditoria quem apagou, quando e quanto.

  Contribuição de Mauricio Garcia (**@maugarciasa**).

### Alterado

- **Nuvemshop sai do menu lateral** A Nuvemshop saiu do menu, por decisão do dono do produto. Nada é apagado: quem
  tem a loja conectada continua conectado, e a tela segue alcançável pela busca.

- **Análise ganhou uma tela de visão geral, e o menu voltou a caber** Com a chegada de **Atividades**, o grupo Análise da barra lateral passou a ter
  cinco telas — e o menu inteiro deixou de caber num notebook comum, obrigando a
  rolar para ver o fim da lista. Grupo que só aparece se você rolar é grupo que
  ninguém sabe que existe. É a mesma história que o CRM viveu com a chegada de
  Tarefas, e tem a mesma resposta.

  Agora a Análise tem sua própria tela de visão geral, igual à que o CRM e o
  Agente de IA já tinham: **Análise › Ver tudo em Análise**. Ela lista as cinco
  telas do grupo com a frase que explica cada uma, separadas entre os números que
  se olham toda semana e o histórico que se consulta quando alguém pergunta por
  quê.

  No menu ficam **Desempenho**, **Meta Ads** e **Atividades** — as três perguntas
  que se refazem toda semana: como foi o mês, quanto custou trazer quem chegou, e
  o que a equipe e a IA fizeram no período. **Evolução da IA** e **Audit Log**
  passaram a morar dentro da visão geral: são visitas de propósito — revisar o
  agente, ou descobrir quem mexeu em quê depois que algo deu errado —, não telas
  de passagem. As duas continuam alcançáveis pela busca (Ctrl/⌘ + K) pelo nome de
  sempre, e nenhum endereço mudou: link salvo continua funcionando.

  Nada muda para quem opera a instalação: nenhuma configuração nova, nenhum passo
  de atualização.

- **O CRM ganhou uma tela de visão geral, e o menu voltou a caber** Com a chegada de **Tarefas**, o grupo CRM da barra lateral passou a ter cinco
  telas — e o menu inteiro deixou de caber num notebook comum, obrigando a rolar
  para ver os últimos grupos. Grupo que só aparece se você rolar é grupo que
  ninguém sabe que existe.

  Agora o CRM tem sua própria tela de visão geral, igual à que o Agente de IA já
  tinha: **CRM › Ver tudo em CRM**. Ela lista as cinco telas do grupo com a frase
  que explica cada uma, separadas entre o que se usa todo dia e o que se define
  uma vez.

  No menu ficam **Funis**, **Contatos** e **Tarefas** — o que se abre toda manhã.
  **Produtos** e **Etapas do funil** passaram a morar dentro da visão geral: são
  telas de montagem (cadastrar o catálogo, desenhar as colunas do funil), não de
  uso diário. As duas continuam alcançáveis pela busca (Ctrl/⌘ + K) pelo nome de
  sempre, e nenhum endereço mudou — link salvo continua funcionando.

  Nada muda para quem opera a instalação: nenhuma configuração nova, nenhum passo
  de atualização.

### Corrigido

- **O aviso de "canal calado" para de ficar preso aberto na Central** Quando a janela de envio do WhatsApp fechava (fora do horário anti-banimento,
  por padrão 7h–22h), a Central mostrava um aviso avisando que as respostas
  estavam esperando a janela abrir. O aviso deveria desaparecer sozinho assim
  que a janela reabrisse — e não desaparecia. Ele ficava aberto o dia inteiro,
  mesmo com o agente respondendo normalmente, dando a impressão de canal (ou
  loja) fechado quando não estava.

  A causa era uma coluna que o código esperava e o banco não tinha:
  `agent_inbox_items.resolved_at`. Toda tentativa de fechar o aviso falhava
  silenciosamente. Agora a coluna existe, e o aviso fecha sozinho no mesmo
  turno em que a janela é encontrada aberta, como sempre foi a intenção.

## [1.14.0] — 2026-09-04

### Adicionado

- **A organização escolhe a própria moeda** Até aqui, todo catálogo era em reais, sem essa escolha aparecer em lugar
  nenhum — mesmo para quem opera em outro país. Em **Configurações › Organização**,
  ao lado de Idioma e Fuso horário, agora há um campo Moeda com real brasileiro,
  peso mexicano e dólar americano.

  O que você escolher ali passa a valer para todo produto cadastrado a partir de
  agora — pelo formulário ou pela importação por planilha — e o preço aparece na
  tela exatamente como o comerciante daquela moeda espera ler: peso mexicano com
  ponto decimal e cifrão na frente, por exemplo, em vez de sair com vírgula e o
  código da moeda colado no número.

  Produto que já estava cadastrado mantém a moeda com que nasceu.

- **Conta confirmada que ficou sem empresa agora tem como terminar o cadastro** Quando a criação da empresa falhava após a confirmação do e-mail, a conta ficava
  sem saída e só destravava pelo banco. Agora cai numa tela que pede o nome da
  empresa e conclui o cadastro. Tela de @prevprocesso-maker.

- **A IA pode ser limitada a atender só leads de origem conhecida** Num número de WhatsApp que também é usado para falar com clientes, fornecedores
  e contatos pessoais, a IA respondia todo mundo assim que um agente era
  publicado. Agora dá para ligar, por canal, o modo "só atende quem eu autorizei":
  a IA fica em silêncio por padrão e só assume a conversa quando o lead veio de
  uma origem elegível — uma submissão nova de formulário, uma campanha
  identificada, ou uma liberação manual pela tela. Histórico antigo, existência do
  contato, conversa anterior ou reinício de um worker nunca autorizam sozinhos.

  Esse limite vale para TODOS os caminhos de resposta automática — o motor do
  agente, o follow-up, o texto fixo de fluxo, o worker de resposta legado e a
  passagem para humano por sentimento. Não há atalho: nenhum deles envia mensagem
  de IA para uma conversa não autorizada.

  Além disso, e independentemente desse modo: quando você responde um cliente à
  mão pelo próprio WhatsApp (celular, ou outra plataforma na mesma conta), a IA
  para naquela conversa para não responder junto.
  **Essa pausa dura uma hora, e se renova a cada mensagem sua.**
  Enquanto você estiver atendendo, a IA continua calada; quando você para, a hora
  corre e ela volta a atender aquela conversa sozinha. Você não precisa lembrar de
  religar nada.

  Se quiser a IA de volta antes da hora, é o botão "devolver ao automático" na
  conversa. E se quiser que ela fique parada por tempo indeterminado, é o mesmo de
  sempre: assumir a conversa pela tela — aí ela só volta quando você devolver.
  Nenhuma dessas coisas apaga a origem do lead.

  Quem não ligar o modo "só atende quem eu autorizei" mantém o comportamento de
  antes para todo o resto.

- **Importar leads de uma planilha** A lista de clientes que já está no Excel agora entra no funil sem digitação. Em
  **Funis**, o botão "Importar planilha" pede um arquivo CSV e cria um negócio por
  linha, na primeira etapa do funil escolhido.

  O importador reconhece os cabeçalhos usuais — nome, telefone, e-mail, valor,
  origem, tags, observação — em português, com ou sem acento, e aceita o
  ponto-e-vírgula que o Excel brasileiro usa. Valor escrito como "R$ 1.200,00"
  entra certo.

  Quando a planilha traz telefone, o contato é criado junto e ligado ao negócio —
  e o mesmo número repetido em várias linhas vira um contato só, não vários.

  Nada é aceito no escuro: ao terminar, a tela mostra quantos negócios entraram,
  quantos contatos foram criados, quais colunas o importador não reconheceu e
  quais linhas foram recusadas, com o motivo e o número da linha como você a vê na
  planilha. Uma linha com erro não derruba as outras.

  Há uma planilha modelo para baixar, para quem prefere começar do formato certo.

  Isto veio da contribuição de James, da Clínica Centro do Sorriso
  (**@clinicacentrodosorrisosc-code**).

- **O contato ganha campos personalizados do seu nicho** Os campos que você define em Funis › Campos personalizados passam a aparecer em
  Contatos › Editar, e são apagados quando o contato é anonimizado. Campos de
  @prevprocesso-maker.

### Alterado

- **A conferência de código que roda antes de cada versão para de ser interrompida pelo relógio** Nada muda na sua instalação: nenhuma configuração nova, nenhum passo de
  atualização, nenhuma tela diferente. O que mudou fica do nosso lado — e é o
  mesmo tipo de conserto que a conferência de tela já tinha recebido, agora feito
  onde ele ainda faltava.

  Antes de qualquer correção entrar no produto, uma bateria confere o código
  inteiro: tipos, estilo e sete mil verificações automáticas. Ela tem um tempo
  máximo, e vinha sendo **cortada no meio** — não porque a conferência tivesse
  crescido, mas porque o preparo da máquina que a roda ficava esperando um
  servidor de terceiros. Medido em 95 execuções: a conferência em si nunca passou
  de 10 minutos, e a espera do preparo chegou a 7.

  Corte por tempo não distingue "quebrou" de "demorou". Quando ele acontece, a
  correção não é reprovada nem aprovada: ela volta para a fila, e o conserto que
  você espera chega mais tarde sem que nada tivesse dado errado. Pior: quem
  contribui de fora vê a própria proposta marcada como reprovada sem ter feito
  nada errado.

  O preparo passa a guardar o que baixou e não depende mais daquele servidor no
  caminho normal. O limite de tempo continua onde estava — é ele que avisa, da
  próxima vez, que a conferência cresceu de verdade.

- **A conferência de tela que roda antes de cada versão para de ser interrompida pelo relógio** Nada muda na sua instalação: nenhuma configuração nova, nenhum passo de
  atualização, nenhuma tela diferente. O que mudou fica do nosso lado — e vale
  escrever porque é ele que decide quando um conserto chega até você.

  Antes de qualquer versão sair, uma bateria abre o sistema num navegador de
  verdade e refaz as telas uma a uma: login, funil, agenda, atendimento,
  follow-up. Ela roda em duas metades ao mesmo tempo, e as duas metades vinham
  crescendo desequilibradas — uma terminava com folga de sobra e a outra chegava
  ao tempo máximo e era **cortada no meio**.

  Corte por tempo não distingue "quebrou" de "demorou". Quando ele acontece, a
  correção não é reprovada nem aprovada: ela volta para a fila, e o conserto que
  você espera chega mais tarde sem que nada tivesse dado errado.

  As duas metades foram redistribuídas pelo tempo medido de cada teste, e não pelo
  número deles. A folga voltou, e o limite de tempo continua onde estava — é ele
  que avisa, da próxima vez, que a bateria cresceu de novo.

- **O Inbox e a barra lateral ficaram mais fáceis de ler** A coluna da esquerda do Inbox empilhava quatro controles em caixa — busca,
  filtro de número, filtro de tag, abas espremidas num quadro cinza e uma linha
  inteira só para o interruptor "Apenas não lidos". E cada conversa tinha uma
  altura diferente da vizinha, porque o contador de não lidas vivia numa terceira
  linha que às vezes existia e às vezes não.

  Agora a busca é uma pílula com o filtro "Não lidos" ao lado, na mesma linha; as
  abas viraram uma faixa sublinhada que cabe na largura da coluna; e cada conversa
  tem duas linhas fixas — nome e hora em cima, prévia e contador embaixo. A
  conversa não lida vem em negrito, e a que está aberta ganha uma barra lateral na
  cor da marca. Selos de tag, de bloqueado e de número de entrada só ocupam uma
  terceira linha quando existem de fato.

  O ícone de robô na prévia passou a seguir a mesma regra: só aparece quando
  distingue alguma coisa. Na aba "Automático", onde toda conversa já é do robô,
  ele parou de se repetir em cada linha.

  Os rótulos em CAIXA ALTA espalhados pelo Inbox — cabeçalhos do painel do
  contato, remetente na bolha, nota interna, divisor de dia — viraram texto normal
  em negrito. Mesma hierarquia, menos esforço para ler.

  Os filtros de número e de tag agora são pílulas na mesma linguagem da busca, e
  ganham cor de destaque quando estão filtrando alguma coisa. Antes eram duas
  caixas de formulário empilhadas, iguais entre "filtrando" e "sem filtro".

  A tela de quando nenhuma conversa está aberta ganhou um ícone e o lembrete de
  que dá para andar pela lista com as teclas J e K.

  Na barra lateral, cada grupo — Atendimento, CRM, Agente de IA, Canais, Análise —
  agora se recolhe clicando no título, e o navegador lembra quais você fechou.

  Nada muda para quem opera a instalação: nenhuma configuração nova, nenhum passo
  de atualização.

  Isto veio da contribuição de Maurilio Garcia (**@maugarciasa**), no PR #556.

### Corrigido

- **Buscar no Inbox por um nome com vírgula ou parêntese deixa de derrubar a tela** Quem tem clientes cadastrados como "Sobrenome, Nome" — que é como boa parte das
  agendas importadas vem — não conseguia buscá-los: a tela dava erro em vez de
  lista.

  E não era preciso ter a vírgula no cadastro. Bastava o atendente digitá-la na
  busca.

- **Buscar um nome comum no Inbox deixa de derrubar a tela** Numa base com muitos contatos, buscar um nome comum — "ana", "silva" — fazia o
  Inbox **parar de abrir**, com erro de servidor. Buscar por DDD tinha o mesmo
  efeito, porque quatro dígitos casam todos os celulares de uma cidade.

  Não era lentidão nem lista incompleta: era a tela quebrando, e justamente onde
  quem atende passa o dia.

  Agora a lista de contatos que casam é cortada pelo tamanho que cabe na consulta.
  Numa busca muito ampla o resultado pode não trazer todos — mas a tela **abre**,
  e a busca pelo conteúdo da conversa continua rodando ao lado.

- **A chave da OpenRouter passa a ser conferida de verdade antes de a tela dizer que está validada** Ao cadastrar uma chave da OpenRouter em **Agente de IA › Credenciais**, o sistema conferia
  a chave contra o catálogo de modelos do provedor — um endereço que responde a
  qualquer um, com chave errada ou sem chave nenhuma. Na prática, qualquer texto
  colado ali era gravado como credencial validada, e o cartão passava a mostrar
  "Validada" com o final da chave ao lado.

  O erro só aparecia depois, na primeira mensagem que o agente tentava responder,
  e aparecia como "User not found." — um texto que não fala em chave nem em
  credencial. Quem procurava a causa olhava o modelo, o provedor, o próprio
  atendimento; a tela, enquanto isso, afirmava que a peça quebrada estava boa.

  Agora a prova é feita contra o endereço que exige a credencial. O catálogo
  continua sendo lido em seguida, porque é dele que sai a lista de modelos que a
  tela mostra — ali ele é dado, não prova. E catálogo fora do ar não recusa mais
  uma chave que já provou ser válida: seria trocar um erro de credencial por um de
  indisponibilidade, e mandar quem opera caçar defeito na chave certa.

  Uma ressalva sobre em que versão isto entrou: a correção já está no ar desde a
  **1.13.0**. O que chega atrasado é esta nota — a mudança foi publicada sem ela,
  e por isso não apareceu na lista daquela versão.

  Chave boa continua sendo aceita do mesmo jeito, e não há passo de atualização.
  A única coisa que vale conferir é o que foi cadastrado antes: se a sua chave da
  OpenRouter é anterior à 1.13.0 e o atendimento falha sem motivo aparente, abra
  **Agente de IA › Credenciais** e use o botão de revalidar — as setas em círculo, no
  cartão da credencial. A resposta que ele dá agora é real.

  Isto veio da contribuição de **@Elevstudio-Dev**.

- **O aviso de erro da importação de planilha volta ao raio de borda do produto** A caixa de aviso da tela de importar leads estava com o canto arredondado pela
  metade — 4px em vez dos 8px que o resto do produto usa. É pequeno e é visível:
  ela fica ao lado de outros blocos com o raio certo.

  A causa é da migração para o Tailwind 4, que mudou o significado de `rounded`
  puro. Quem escreveu a tela usou o nome que valia antes.

- **O bloco "Ocupado" da agenda do Google sai da lista de próximos, onde os botões não funcionavam** Os horários ocupados na sua agenda pessoal do Google apareciam também na lista
  **Próximos**, com **Remarcar** e **Cancelar** ligados — como se fossem
  compromissos da empresa. Não eram, e os botões não tinham como funcionar:
  clicar em Cancelar dava erro e nada acontecia.

  Agora esses blocos aparecem **só na grade**, que é onde servem: mostram o
  horário tomado, não abrem e não arrastam. A lista de próximos volta a ter só o
  que sua equipe pode remarcar ou cancelar de verdade.

  O nome do compromisso particular continua não aparecendo em lugar nenhum.

- **A troca de senha pela linha de comando volta a encontrar o usuário** Quem perde o acesso a uma instalação sem SMTP — o estado normal de um self-host
  recém-instalado — só tem um caminho de volta: o `reset-password.sh` do kit. Ele
  não funcionava para **ninguém**. Não era intermitente nem dependia do e-mail:
  qualquer endereço, existente ou não, recebia a mesma resposta seca de "usuário
  não encontrado", e a pessoa ficava trancada do lado de fora do próprio sistema.

  A causa era uma consulta escrita na sintaxe errada. O script pedia ao servidor de
  autenticação um filtro no formato do banco (`email.eq.<endereço>`), e esse
  servidor não fala esse formato — ele usa a expressão inteira como texto de busca.
  Como nenhum e-mail contém o pedaço `email.eq.`, a busca não achava nada, sempre.

  Agora a consulta vai no formato que o servidor entende. E, como a busca dele é por
  trecho do endereço, o script passou a exigir o e-mail **inteiro** antes de aceitar
  o resultado: pedir `ana@empresa.com` também traz `mariana@empresa.com`, e entregar
  a pessoa errada a um comando que TROCA SENHA seria pior que não achar ninguém. Na
  dúvida ele não devolve nada — quem chama vê "não encontrado", que é ruim mas se
  resolve; a senha de outra pessoa trocada, não.

  Quem opera uma VPS não precisa fazer nada além de atualizar. Nenhuma configuração
  muda, nenhum arquivo precisa ser editado à mão.

- **O compromisso marcado aqui passa a aparecer na Agenda do Google — e o que está ocupado lá aparece aqui** Quem conectou a Agenda do Google tinha a integração **ligada e sem efeito nenhum**.
  Valia nas duas direções, e nada na tela dizia isso.

  **Nada saía daqui.** O compromisso era marcado, o sistema tentava criá-lo lá a
  cada cinco minutos, e o Google recusava todas as vezes — por um detalhe de
  formato. O erro era registrado só como "HTTP 400", sem o motivo que o Google
  mandava junto. Por isso a falha durou tanto: dava para ver que não funcionava, e
  não dava para saber por quê. Isso nunca funcionou em instalação nenhuma; os
  compromissos já marcados sobem na próxima sincronização.

  **E o que estava ocupado lá não era desenhado aqui.** O horário já era
  respeitado — ninguém conseguia marcar em cima —, mas o bloco não aparecia na
  grade. O dono via a agenda vazia e o horário indisponível ao mesmo tempo. Agora o
  bloco aparece, marcado como *Ocupado*.

  O **nome** do evento particular continua não aparecendo, de propósito: a agenda
  conectada é pessoal de quem atende, e esta tela é vista pela gestão.

  **Quando o Google recusa o acesso**, a tela deixa de mandar "tente de novo" —
  conselho que não funcionaria, porque a causa costuma ser a API do Google Agenda
  desligada no projeto do Google Cloud. Agora ela diz onde ligar.

  Para quem opera, nada muda no dia a dia.

  O conserto é de @Clalber, que diagnosticou os três defeitos e provou a correção
  com tráfego real.

- **Anonimizar um contato retoma de onde parou, em vez de dizer que já foi** A anonimização de um contato remove os dados pessoais em três lugares: o
  cadastro do contato, os títulos dos negócios dele e o histórico de atividades.
  Se a operação era interrompida no meio — o navegador desistindo, o servidor
  reiniciando —, o primeiro lugar ficava pronto e os outros dois não.

  E não havia como terminar: clicar em "Anonimizar" de novo respondia **"já anonimizado"**
  e não fazia mais nada. O contato ficava para sempre com nome de
  cliente visível dentro dos negócios e do histórico — que é exatamente o dado que
  a anonimização existe para remover, e que a lei dá prazo para remover.

  Pior: nesse estado a tela **não mostra botão nenhum** — assim que o contato
  consta como anonimizado, o botão dá lugar a um aviso. Não havia como pedir a
  retomada nem sabendo que ela era necessária.

  Agora a verificação diária do sistema encontra sozinha as anonimizações que
  ficaram pela metade e termina o serviço, sem ninguém precisar procurar contato
  por contato. Como a lei dá prazo, esse conserto não podia depender de alguém
  lembrar de clicar. Rodar de novo num contato já inteiro não escreve nada, e o
  registro de auditoria mostra o que foi realmente feito, em qual contato e em que
  dia — separado da execução original, para a data em que o titular exerceu o
  direito não ser sobrescrita.

- **Configuração de fila malformada deixa de ser confundida com serviço fora do ar** Aspas coladas no endereço da fila eram acusadas como "serviço fora do ar",
  mandando reiniciar um serviço que estava de pé. A página de saúde agora aponta a
  configuração. Achado de @prevprocesso-maker.

- **O agente para de achar que está fechado por causa do fuso** O agente recebia o horário de cada mensagem do histórico em UTC, e não no fuso
  da sua organização — três horas à frente, para quem está no horário de
  Brasília. Uma mensagem enviada às 15:45 chegava até ele como 18:45.

  Isso só doía em agentes instruídos a conferir o relógio antes de responder:
  eles concluíam que já era fora do expediente e respondiam "estamos fechados",
  citando na mesma frase o horário de atendimento dentro do qual o cliente ainda
  estava. O erro passou despercebido porque o resto do agente já mostrava a hora
  certa — só o horário das mensagens do histórico saía errado. Foi visto em
  produção em dois dias diferentes, com clientes reais recebendo "estamos
  fechados" em pleno horário comercial.

  Agora o horário de cada mensagem chega ao agente já no fuso da sua organização,
  o mesmo que ele usa para saber que dia e que horas são.

- **A proteção de envio volta a aceitar a data de hoje** Em **Conexões › Proteção de envio**, informar hoje em "este número é usado
  desde" era recusado durante a manhã inteira: até as 9h no relógio de quem
  opera no Brasil, salvar devolvia *"Campos inválidos."* e não gravava nada — nem
  a janela de horário, nem o intervalo entre envios, nem o teto diário que você
  tinha acabado de mudar na mesma tela.

  O motivo: o campo pergunta um DIA, mas a verificação o comparava com a hora
  exata em Londres. Um dia não tem hora — ele começa em horários diferentes em
  cada parte do mundo —, e por isso "hoje" só era aceito depois do meio-dia
  londrino. Agora a verificação compara dias com dias, e só recusa a data que
  ainda não chegou em canto nenhum do planeta.

  O calendário do campo também parou de oferecer o dia errado: depois das 21h ele
  mostrava amanhã como escolha possível.

  Data futura continua recusada, e data antiga continua sendo o caso normal — é
  informando a data antiga que um número usado há meses deixa de ser tratado como
  recém-criado e sai do teto de 20 envios por dia.

- **A mensagem de erro do WhatsApp deixa de repetir a resposta crua do serviço** Ela vinha com um pedaço da resposta crua do WhatsApp colado no fim — texto de
  outro programa, que pode trazer telefone de cliente ou o endereço do servidor.
  Agora diz só a operação e o código do erro. Achado de @prevprocesso-maker.

- **O painel de IA para de avisar que um modelo não enxerga imagens quando ele enxerga** Duas informações erradas no painel de provedores, e as duas faziam quem opera
  tomar decisão contra o que o sistema realmente faz.

  **A primeira:** o painel avisava que um modelo "não enxerga imagens" e que fotos
  e comprovantes do cliente seriam ignorados — sobre modelos que enxergam, e num
  sistema onde a leitura estava funcionando. Na mesma instalação em que o aviso
  aparecia, o print que o cliente enviou virou descrição correta para o atendente.

  O painel lia uma tabela de catálogo; o atendimento lia outra coisa. Agora os
  dois respondem pela mesma fonte, e o painel não pode mais discordar do que
  acontece de verdade. Onde o sistema não conhece o modelo — o seu, ou um de um
  serviço próprio —, o catálogo continua sendo a resposta, e a falta de informação
  continua sendo dita como falta de informação, não como "não funciona".

  **A segunda:** quem usa a OpenRouter tinha o problema INVERTIDO — e ele é pior,
  porque não tem sintoma. Ali o sistema não sabia dizer se um modelo enxerga: ele
  olhava só o começo do nome. Como `openai/gpt-4o` enxerga e `openai/gpt-3.5-turbo`
  não, e os dois começam igual, um palpite pelo começo do nome erra metade das
  vezes — e a OpenRouter já informa a resposta certa, modelo por modelo, quando o
  catálogo é sincronizado na instalação.

  O efeito prático era duplo. O painel deixava de avisar quando o aviso era
  verdadeiro, então quem opera achava que o comprovante do cliente estava sendo
  lido e não estava. E o atendimento chegava a enviar a imagem para um modelo que
  não a aceita, o que fazia a resposta daquela mensagem falhar. Agora, quando a
  OpenRouter informa a capacidade, é ela que vale — e quando não informa, o
  sistema volta a dizer que não sabe, em vez de afirmar.

  **A terceira:** o ponto "Ouvir o áudio do cliente" mostrava um modelo de
  conversa, com "usando o padrão da organização" — ao lado do próprio texto do
  ponto, que diz que a transcrição usa o padrão da OpenAI. A mesma tela afirmava
  duas coisas incompatíveis, e modelo de conversa não transcreve áudio.

  Agora ele mostra o que de fato transcreve. Trocar o modelo de conversa nunca
  mudou nada ali; o que muda é a tela parar de sugerir que mudaria.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização. O que muda é que o painel volta a descrever
  o sistema que está rodando.

- **Salvar o rascunho de um agente para de escrever por cima de um rascunho antigo** Na tela de um agente, "Salvar rascunho" podia gravar numa versão **diferente**
  da que estava aberta na tela — e apagar, no caminho, um rascunho antigo que a
  própria tela prometia estar guardado.

  O estado que produzia isso é comum e tem um gatilho conhecido: quem tinha
  trabalho em andamento num rascunho e usou o botão **Reverter**, na aba
  Histórico. Reverter cria uma versão nova e a publica na hora; o rascunho que
  existia fica, a partir dali, "atrás" da versão publicada. A tela sabe disso e
  avisa, no selo ao lado do nome do agente: *"o rascunho v5 é anterior a esta
  versão e foi superado por ela — ele continua no Histórico."*

  Só que o servidor não sabia. Ele procurava "o rascunho de maior número" e
  gravava ali. Duas consequências, nenhuma delas com mensagem de erro:

  - **O trabalho parecia sumir.** O aviso verde dizia "Rascunho v5 salvo.", a
    página recarregava, e a tela voltava a mostrar o texto anterior — porque ela
    não reabre um rascunho superado, e o botão de publicar também não o oferece.
    Quem estava editando via "salvo" e nada mudando, sem ter o que fazer a
    respeito.
  - **O Histórico perdia conteúdo, em silêncio.** Aquele rascunho v5 é um
    retrato: a linha dele no Histórico existe para mostrar o que estava escrito
    ali. Regravá-lo trocava esse conteúdo por um texto que ninguém rascunhou
    naquele momento, sem aviso e sem volta.

  Agora o servidor decide em qual versão escrever pela **mesma regra** que a tela
  usa para decidir qual versão abrir. Quando o rascunho existente está superado,
  a gravação nasce numa versão nova — que é a que a tela reabre e o botão publica
  — e o rascunho antigo fica intacto no Histórico, como estava prometido.

  Junto vem um cuidado que não aparece na tela mas decide o resultado: quem é a
  versão publicada passa a ser sempre o **ponteiro que o atendimento executa**, e
  não o rótulo "publicada" gravado na linha da versão. Os dois já se contradizem
  em instalações reais, e a resposta otimista era a errada.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização, nenhuma mudança no banco. O que muda é que
  "salvei" volta a significar "está salvo onde você está vendo".

- **Os e-mails de acesso deixam de apontar para um endereço que não existe** Numa instalação feita pelo caminho documentado, os e-mails de recuperação de
  senha, de confirmação de cadastro e de aceite de convite chegavam com um link
  para `localhost:3000` — um endereço que só existe na máquina de quem programa.
  O e-mail chegava, a pessoa clicava, e o navegador dizia que a página não existe.
  Na prática, **ninguém conseguia redefinir a própria senha.**

  O endereço certo mora no painel do Supabase, e o instalador já sabia configurá-lo
  sozinho — só que precisava de um token que ele nunca pedia. O aviso existia, mas
  saía no meio de um registro de dez minutos, logo antes de uma tela verde dizendo
  "Instalação concluída". Ninguém voltava para ler.

  Agora o instalador pergunta esse token. Ele é opcional e **não fica salvo** —
  abre a conta inteira do Supabase, então é usado uma vez e descartado, e nem
  sequer entra no rascunho que guarda suas respostas para o caso de a instalação
  ser interrompida. Por isso, se você recomeçar uma instalação, ele é a única
  pergunta que volta a ser feita; a tela diz isso na hora, e apertar Enter pula.

  Quem preferir pular continua podendo: a instalação termina repetindo o passo que
  falta, com o seu domínio já preenchido, em vez de deixar a descoberta para o dia
  em que alguém esquecer a senha. E quando o passo automático roda mas o endereço
  não fica como este sistema precisa — porque o seu projeto já tinha outro
  endereço escolhido, por exemplo —, ele passou a dizer isso em vez de terminar
  com um "pronto" verde.

  **Se você já tinha instalado antes desta versão**, a próxima atualização mostra
  esse mesmo passo uma vez, com o seu domínio preenchido, e não repete depois.

- **Sete alertas de segurança em bibliotecas de terceiros foram fechados** O GitHub apontava sete alertas de segurança em bibliotecas que o DeskcommCRM não
  usa diretamente — elas chegam junto com outras que ele usa. São quatro em
  `fast-uri` (confusão de endereço ao normalizar uma URL malformada), dois em `qs`
  (contorno do limite de tamanho de lista e travamento por entrada preparada) e um
  em `browserslist`.

  As três entraram no piso de versão que o projeto já mantém para casos assim, sem
  subir de versão maior: `fast-uri` 3.1.7, `qs` 6.16.0 e `browserslist` 4.28.8.

  Nada muda para quem opera a instalação: são correções de bibliotecas internas,
  sem migration e sem passo de atualização.

  Isto veio da contribuição de Maurilio Garcia (**@maugarciasa**), no PR #556.

- **A quebra de mensagem em bolhas não corta mais um valor em reais no meio** Com "quebrar resposta em várias mensagens" ligado, o agente tratava qualquer "." como fim de
  frase — inclusive o "." que separa milhar num preço em reais ("R$ 10.990"). O valor virava
  duas "frases" ("R$ 10." e "990 no cartão…"), que às vezes iam para bolhas de WhatsApp
  SEPARADAS (o cliente que via só a primeira lia "R$ 10" como o preço fechado de um produto de
  R$ 10.990) e às vezes eram remendadas com um espaço a mais ("R$ 7. 990").

  Agora um "." só conta como fim de frase quando não está entre dois dígitos.

## [1.13.0] — 2026-09-04

> **Esta versão não tem imagens publicadas** — o build da tag foi cancelado, e as três imagens não
> existem no registro. Nada para fazer: quem atualiza chega à 1.14.0 ou superior.

### Alterado

- **O CRM instala em Postgres 15, não só em 17** Até agora a instalação exigia Postgres 17. Quem tentasse usar um banco 15 ou 16
  — o padrão de boa parte dos painéis de VPS e dos templates prontos de Supabase
  — via a montagem do banco parar no meio, e a instalação terminava sem as
  tabelas.

  A exigência nunca foi uma decisão de projeto. O arquivo que monta o banco é
  gerado automaticamente a partir de um servidor de referência, e esse servidor
  rodava a versão 17; ao ser gerado, o arquivo levou junto nove linhas com uma
  permissão que só existe nessa versão. Nenhuma parte do sistema usa essa
  permissão. Bastava o banco não reconhecê-la para o arquivo inteiro ser
  recusado — e um arquivo recusado é um banco vazio, não um banco incompleto.

  As nove linhas saíram. A permissão que sobrou em cada uma é exatamente a mesma
  de antes, então nada muda no comportamento nem na proteção das tabelas de
  auditoria, que continuam não aceitando alteração nem exclusão.

  Quem já roda o CRM não precisa fazer nada: o Postgres 17 segue funcionando
  igual. O que mudou é que 15 e 16 passaram a funcionar também.

### Corrigido

- **A busca do Inbox passa a achar pelo nome e pelo telefone do cliente** Digitar o nome de um cliente na caixa de busca do Inbox não trazia a conversa
  dele — a busca olhava só o texto das mensagens. Na prática, achar uma conversa
  pelo nome só funcionava por acidente: se o nome tivesse sido escrito dentro de
  alguma mensagem.

  Para quem atende, procurar pelo nome é o caso mais comum — bem mais frequente
  que lembrar um trecho exato de mensagem. E com alguns milhares de contatos
  importados, a única alternativa era rolar a lista.

  Agora a busca cobre nome, telefone e o texto das mensagens ao mesmo tempo. O
  campo passa a dizer isso, em vez de prometer só mensagens.

  Contato anonimizado continua fora da busca por nome — anonimizar é definitivo.

- **A inteligência artificial não se cala mais por três horas depois de responder** Sempre que o CRM enviava uma mensagem pelo WhatsApp, o próprio WhatsApp
  devolvia um eco dela de volta. O sistema lia esse eco como se um atendente
  humano tivesse respondido pelo celular, e **desligava a IA por três horas.**

  Ou seja: a IA se calava por ter falado. O cliente ficava sem resposta e a tela
  mostrava **"Automático pausado"** — estado legítimo, que ninguém investiga,
  porque é exatamente o que aparece quando alguém assume a conversa de propósito.

  Atingia qualquer instalação e qualquer conversa, sem depender de configuração.

  Agora o sistema distingue o eco do próprio envio de uma digitação de verdade. E
  a distinção só protege o silêncio: a mensagem continua sendo gravada como
  sempre, porque perder uma mensagem é pior do que registrar uma a mais.

  Quando o atendente responde mesmo pelo celular, a IA continua se calando — essa
  parte não mudou.

- **A proteção de envio volta a salvar sem a data do número** Em **Conexões › Proteção de envio**, ajustar o horário de envio e salvar sem
  preencher "este número é usado desde" devolvia *"Falha ao salvar os knobs."* e
  não gravava nada — nem os campos que você tinha acabado de mudar.

  Isso atingia toda instalação nova, porque essa data começa em branco. E a
  armadilha era dupla: sem os limites salvos, o sistema trata o número como
  recém-criado e libera pouco por dia — exatamente o teto que a pessoa abriu a
  tela para corrigir.

  Agora o campo em branco significa o que a tela sempre prometeu: em número novo,
  ele é tratado como recém-criado. E, se você já tinha informado uma data antes,
  limpar o campo não a apaga — para trocá-la, informe outra. O texto de ajuda da
  tela passa a dizer isso.

  Junto vai um conserto de diagnóstico: quando o banco recusa um campo, o motivo
  passa a viajar junto do erro em vez de virar um "falha ao salvar" sem dono.

- **A atualização volta a chegar quando alguém aprova outra coisa durante o fechamento da versão** Uma versão do sistema é fechada em duas etapas: primeiro o time monta a lista do
  que entrou, depois aprova essa lista. Entre uma coisa e outra, qualquer outra
  melhoria aprovada no meio do caminho fazia o fechamento **desistir em silêncio**
  — a versão aparecia na lista de novidades, mas nunca era publicada de verdade.

  O efeito para quem tem o sistema instalado era o pior tipo: nada de errado
  aparecia em lugar nenhum. O painel não acusava, o histórico de versões mostrava
  a versão nova como se existisse, e a atualização simplesmente nunca chegava. Foi
  o que aconteceu com a versão 1.11.1: ela consta no histórico desde 31 de agosto e
  nunca existiu como pacote — nenhuma instalação a recebeu.

  Agora o fechamento reconhece a si mesmo por outro sinal, que não depende de o
  resto do time parar de trabalhar enquanto a versão fecha. E, se alguma coisa
  estranha acontecer nesse momento, o processo **falha alto** em vez de passar
  batido — que é o que teria feito alguém perceber a 1.11.1 no mesmo dia, e não
  duas semanas depois.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização. O que muda é que "a versão saiu" volta a
  significar que ela saiu.

- **Áudio que demora para transcrever não faz mais o agente dizer "não entendi"** Um cliente mandou um áudio perguntando sobre troca de peça de uma moto elétrica. A
  transcrição terminou certinha — mas 18 segundos tarde demais: o agente já tinha
  respondido "recebi seu áudio, mas não consegui identificar o conteúdo", e o cliente
  teve que digitar a pergunta de novo.

  A causa era um teto fixo de 45 segundos de espera pela transcrição antes de o turno
  seguir sem o texto. Medindo as transcrições reais desta instalação, 45s não é raro
  de estourar em áudios normais — só é curto demais para a cauda longa (minutos, quando
  há retry por falha transitória), que nenhum teto razoável cobre sem o cliente esperando
  minutos pela primeira resposta.

  O teto passou para 120 segundos, o suficiente para cobrir esse tipo de atraso comum sem
  impor uma espera longa em todo áudio. Para quem opera uma instalação, nada muda no dia
  a dia.

- **Uma instabilidade passageira do provedor de IA deixa de matar o atendimento na primeira rajada** Quando o provedor de IA responde "calma, você está mandando rápido demais" — um
  limite temporário que costuma passar sozinho em menos de um minuto —, o sistema
  tenta de novo. Ele tinha direito a cinco tentativas, e usava as cinco no mesmo
  segundo: a conversa voltava para a fila já liberada, era pega outra vez na
  mesma volta, e assim por diante. O limite não teve um instante sequer para
  ceder, e a conversa ia para a lista de casos que precisam de gente com um aviso
  crítico na Central.

  Medido numa instalação real em 31/08: 49 atendimentos descartados em rajadas de
  poucos segundos, todos pelo mesmo motivo passageiro.

  Agora cada nova tentativa espera mais que a anterior — 10 segundos, depois 20,
  depois 40, depois 80 —, o que dá ao provedor tempo de se recuperar antes da
  próxima. Na prática, a instabilidade que antes queimava as cinco chances em um
  segundo agora tem mais de dois minutos para passar, e o atendimento continua
  sozinho quando ela passa.

  Para quem opera, nada muda: não há configuração nova, nenhum passo de
  atualização e nenhum ajuste no arquivo de ambiente. O que muda é a Central
  ficar com os avisos que importam, em vez de encher de casos que se resolveriam
  sozinhos.

- **O endereço interno do seu servidor deixa de aparecer na página pública de saúde** O sistema tem um endereço público que responde se ele está de pé — usado por
  monitoramento e pelo suporte. Ele já era cuidadoso: escondia de quem não tem a
  chave interna o endereço da conexão do WhatsApp e do serviço de fila, porque
  esse endereço é justamente o que alguém precisaria para tentar bater na porta
  deles.

  O cuidado tinha um furo. Quando o arquivo de configuração ficava com o endereço
  numa forma inválida — sem o `https://` na frente, ou com aspas sobrando, que são
  os dois erros mais comuns de quem instala —, a mensagem técnica da falha vinha
  com o endereço dentro, e essa mensagem **saía por inteiro** para qualquer pessoa
  que abrisse a página. O sistema fechava a porta da frente e deixava a mesma
  informação na janela do lado.

  Agora quem não tem a chave interna vê apenas que a consulta falhou, e **por quê**:
  se não achou o servidor, se foi recusado, se demorou demais, se a
  credencial não passou. Isso é o que serve para monitorar. O texto técnico
  completo continua saindo inteiro para quem tem a chave, que é quem precisa dele
  para consertar.

  Para quem opera, nada muda: nenhuma configuração nova, nenhum passo de
  atualização. Se você tinha algum alerta lendo o texto da mensagem de erro, ele
  passa a ler o motivo em vez do texto.

  O achado é de @prevprocesso-maker, que percebeu o furo instalando o sistema para
  um cliente.

- **Instalar pelo canal padrão não mistura mais versões entre os serviços** O DeskcommCRM roda três serviços que saem do mesmo código — o aplicativo, o
  trabalhador de fundo e o agendador. Quem instala pelo canal padrão espera os
  três na mesma versão.

  Até agora cada um deles avançava o canal por conta própria, ao terminar de ser
  publicado, sem saber se os irmãos tinham conseguido. Quando a publicação de um
  falhava por um problema de infraestrutura, os outros dois seguiam em frente — e
  quem instalasse naquela janela recebia uma instalação **misturada**, com peças
  de versões diferentes. Aconteceu de verdade no fechamento da versão anterior.

  Agora o canal só avança depois que as três imagens estão publicadas e o
  aplicativo provou que sobe. Se qualquer uma falhar, o canal fica onde estava —
  uma versão inteira e velha, em vez de uma nova pela metade.

  E o fechamento de cada versão passa a conferir isso antes de dar por concluído:
  não basta as imagens existirem, o canal precisa apontar para elas.

  Nada muda para quem já tem uma instalação funcionando.

- **Loja com catálogo grande volta a achar o próprio produto** Numa loja com muitos produtos cadastrados, o atendente de IA podia responder
  **"não temos"** para um produto que a loja tem. E não havia como perceber: a
  resposta era educada, o sistema não registrava erro nenhum, e o mesmo produto às
  vezes aparecia na busca seguinte.

  A causa é que a busca consultava um lote do catálogo sem definir a ordem. Sem
  ordem, o banco devolve as linhas que quiser — e o produto pedido podia
  simplesmente não estar no lote que veio. O limite real também era metade do que
  o sistema pedia.

  Agora a busca percorre o catálogo em páginas, na ordem do código, até encontrar
  ou terminar. E, se o catálogo for grande demais para varrer inteiro, o atendente
  **para de dizer que a loja não tem**: ele diz que não encontrou no que
  conseguiu consultar e que vai confirmar com a equipe.

  A diferença importa para quem está comprando: "não temos" encerra a conversa,
  "vou confirmar" não.

- **Fechar um negócio parou de avisar duas vezes, e o card não some mais numa coluna arquivada** Toda vez que alguém marcava um negócio como ganho ou perdido, o sistema
  registrava o acontecimento **duas vezes**: uma pelo banco, que já fazia isso
  sozinho, e outra pelo aplicativo, que não sabia que o banco já tinha feito.
  Enquanto ninguém escutava esse registro, a duplicata era só ruído guardado. Ela
  deixou de ser inofensiva quando as notificações no navegador passaram a escutar
  exatamente esse aviso — daí em diante, um único negócio fechado tocava duas
  vezes no celular de quem estava acompanhando.

  Junto vinham duas coisas menores e do mesmo tipo, do jeito silencioso que
  incomoda mais do que erro barulhento:

  - Um funil cujo estágio de fechamento tinha sido **arquivado** continuava sendo
    usado. O negócio era fechado numa coluna que ninguém mais vê, sem aviso
    nenhum. Agora o sistema recusa e diz que falta um estágio de fechamento no
    funil, que é o que de fato está acontecendo.
  - O card fechado caía em **posição aleatória** na coluna final, em vez de ir para
    o fim dela. Quem trabalha olhando o quadro perdia o negócio de vista.

  Para quem opera, nada muda no dia a dia: nenhuma configuração nova, nenhum passo
  de atualização, nenhum dado a corrigir. O que muda é que o aviso passa a sair uma
  vez, e que fechar num funil mal configurado avisa em vez de sumir.

  O achado é de @prevprocesso-maker, que instalou o sistema para um cliente e
  percebeu a emissão em dobro lendo o próprio código.

- **O atendente de IA passa a enxergar os compromissos já marcados do cliente** O atendente de IA marcava uma reunião e, minutos depois, agia como se ela não
  existisse: dizia que o horário estava ocupado por outra pessoa quando o ocupante
  era a reunião do próprio cliente.

  A causa é simples: o contexto que o agente recebe a cada mensagem trazia o
  histórico, as anotações e o estágio do funil — e **nenhuma agenda**. Ele só
  sabia dos compromissos se fosse consultá-los, e não tinha por que desconfiar de
  que precisava.

  Agora o contexto de cada conversa traz os compromissos futuros daquele contato,
  com data, horário e título. Se houver mais do que cabe, ele diz que a lista está
  incompleta em vez de deixar o agente concluir que aquilo é tudo.

  Compromissos cancelados ficam de fora: um compromisso desmarcado nessa lista
  faria o agente confirmar ao cliente uma reunião que não existe mais.

- **O agente para de dizer que o cliente não tem nada marcado quando tem** O atendente de IA podia marcar uma reunião e, minutos depois, dizer ao próprio
  cliente que **ela não existia** — pedindo desculpas por tê-la marcado. Não havia
  erro em lugar nenhum: a consulta era válida e devolvia "nenhum compromisso", que
  é uma resposta legítima.

  A causa é um nome. Dentro do motor, o campo que identifica **a pessoa** da
  conversa se chama `lead_id` — mas nas ferramentas de agenda esse mesmo nome
  significa **o negócio no funil**, que é outra coisa. O agente passava o
  identificador da pessoa no lugar do negócio, a busca não encontrava vínculo
  nenhum e respondia "nada marcado".

  Agora, quando o identificador não corresponde a um negócio do funil, a resposta
  deixa de ser "nada marcado" e passa a ser uma **recusa que ensina o caminho certo**
  — e que instrui o agente a dizer que vai confirmar com a equipe, nunca
  que o cliente não tem nada.

  Um negócio de verdade sem compromissos continua respondendo "nada marcado", que
  é a resposta certa.

- **O agente para de repetir uma pergunta que o cliente já respondeu** Numa conversa real, o agente pediu o e-mail do cliente **quatro vezes** — com o
  cliente respondendo três. Para quem está do outro lado, isso não parece um
  sistema: parece desatenção.

  Eram duas causas somadas.

  A primeira: ao fechar cada turno, o agente anota qual é a "próxima ação". Como
  essa anotação é escrita logo depois de ele perguntar e antes de a resposta
  chegar, ele anotava como próxima ação **a pergunta que acabara de fazer**. No
  turno seguinte essa anotação voltava no topo das instruções, acima do histórico
  — e mandava perguntar de novo o que o histórico logo abaixo já respondia.

  A segunda: o cadastro do contato aparecia com o e-mail em branco, e o agente lia
  isso como um fato ("não tem e-mail"), com mais autoridade do que a mensagem em
  que o cliente tinha acabado de digitá-lo. E como esse campo nunca é preenchido
  sozinho, o pedido se repetia indefinidamente.

  Agora a anotação diz explicitamente que se refere ao **depois** da resposta, o
  bloco avisa que foi escrito antes da última mensagem do cliente — e que, em caso
  de desacordo, vale o histórico —, e o cadastro em branco vem com a ressalva de
  que a informação pode já ter sido dada na conversa.

- **Os avisos coloridos do sistema voltam a ter cor** Boa parte dos avisos do produto — o fundo avermelhado de um erro, o âmbar de uma
  pendência, a borda suave de um cartão — era escrita para aparecer com transparência
  e simplesmente **não pintava**: a regra nunca chegava a ser gerada, em silêncio.
  Eram 62 marcações distintas, em 252 lugares das telas. Agora pintam.

  Junto vem o respiro entre o rótulo e o campo nos formulários, que havia encolhido
  no mesmo mecanismo, e a sombra da aba selecionada, que passara a usar um preto
  fixo em vez do tom do tema — visível para quem usa o sistema no modo escuro.

  Onde a transparência era aplicada ao TEXTO, ela foi retirada em vez de passar a
  valer: em 20 lugares o texto ficaria claro demais para ser lido com conforto — os
  rótulos de grupo do menu lateral, entre outros. Esses continuam exatamente com a
  aparência que sempre tiveram na tela.

  Quem opera uma VPS não precisa fazer nada: é só atualizar. Nenhuma configuração
  muda, nenhum arquivo precisa ser editado à mão.

- **Um fluxo de retorno publicado não abre mais vazio na tela** Um fluxo de retorno que estava **no ar e funcionando** podia abrir **em branco**
  no construtor. A automação rodava normalmente e conversava com os clientes; a
  tela é que não mostrava nada.

  Acontecia quando o fluxo foi publicado por fora do construtor — restauração de
  backup, instalação assistida, importação de outra instalação. Nesses casos o
  sistema guarda a versão publicada mas não guarda uma cópia de trabalho, e a tela
  só sabia abrir a cópia de trabalho.

  **O risco era maior do que a tela vazia.** Quem abrisse, mexesse em qualquer
  coisa e salvasse estaria salvando por cima — com o desenho vazio que a tela
  mostrou. Um "publicar" depois disso trocaria o fluxo que está funcionando por
  esse vazio, sem aviso nenhum.

  Agora, quando não existe cópia de trabalho, a tela abre **exatamente o que está no ar**.
  Quem nunca editou vê o fluxo publicado; quem tem trabalho salvo e não publicado
  continua vendo o seu trabalho, que segue tendo prioridade.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização.

- **O limiar de sentimento passa a vir do agente que atende aquela conversa** Quem opera mais de um agente ajustava o campo "limiar de sentimento" de um deles
  e via o comportamento do outro. Os dois campos existiam, os dois aceitavam
  valor, e só um fazia efeito — o do agente mais antigo da organização, porque a
  conversa que disparou o alerta não entrava na conta.

  Com um agente só, o resultado era certo por acidente. Com dois, o limiar em
  vigor dependia da ordem em que eles foram criados, e não havia nada na tela que
  explicasse por quê.

  E o limiar certo é genuinamente diferente por agente: numa clínica, cliente
  triste é sinal de problema; numa assistência técnica, cliente triste é o cliente
  normal. Um número único para os dois erra nos dois sentidos — escala demais num
  caso, de menos no outro.

  Agora vale o limiar do agente que está atendendo aquela conversa. Quando não dá
  para dizer com certeza qual é — dois agentes e nenhum vínculo com a conversa —,
  vale o padrão do sistema, nunca o número do vizinho.

  O alerta gerado passa a registrar qual agente decidiu e por quê, para que a
  pergunta "por que este alerta saiu?" tenha resposta na própria linha.

- **O nome, a descrição e a ordem do agente passam a ser salvos de verdade** Na tela de um agente, trocar o **Nome** não mudava nada. A pessoa digitava,
  salvava, publicava — e o nome continuava o mesmo, no editor e na lista.
  **Descrição** e **Ordem de preferência** sumiam do mesmo jeito.

  O que tornava isso difícil de perceber é que nada falhava: o campo aceitava a
  digitação, o aviso verde dizia "Rascunho salvo", e a publicação respondia com
  sucesso. Todas essas mensagens eram verdadeiras — a respeito da **versão**, que
  era a única coisa realmente gravada. Recarregar a página não ajudava, porque o
  valor nunca chegou a ser gravado.

  Agora os três são salvos junto com o rascunho, e a lista de agentes reflete o
  nome novo na hora.

  Dois detalhes que vêm junto: apagar a descrição realmente a apaga (antes o campo
  vazio seria interpretado como "não mexi"), e uma ordem de preferência fora de
  0 a 1000 é avisada embaixo do campo, em vez de virar erro genérico depois.

- **"Quero 2 iPhone 15" volta a encontrar o iPhone 15** Quando o cliente escrevia um número que não é característica do produto — a
  quantidade que ele quer, quanto pretende gastar —, o atendente de IA respondia
  que **não encontrou nada**. "Quero 2 iPhone 15" e "tenho 3.000 pra gastar num
  iPhone" voltavam vazias, mesmo com o produto no catálogo.

  É o pior momento para dizer "não encontrei": a pessoa estava comprando.

  A causa era a regra que impede o erro mais caro da busca — quem pergunta do
  128GB não pode receber o preço do 256GB. Para isso, o número que o cliente diz
  precisa bater exatamente. Só que **todo** número era tratado assim, inclusive os
  que não descrevem produto nenhum.

  Agora o próprio catálogo decide: um número só restringe a busca se ele existir
  em algum produto. "128" existe, então continua separando os modelos. "2" não
  existe em produto nenhum, então é quantidade — e quantidade não esconde nada.

  A proteção continua inteira no caso que importa: quem pede uma capacidade que a
  loja não tem continua recebendo "não temos", e nunca o modelo parecido com
  preço diferente.

  Para quem opera uma instalação, nada muda no dia a dia.

- **O prompt que você salva passa a ser o que o agente realmente executa** Editar as instruções de um agente **já publicado** e salvar mostrava o texto novo
  na tela — enquanto o agente continuava atendendo no WhatsApp com o texto
  anterior. Não havia erro, nem aviso: quem editava concluía que a mudança estava
  no ar, e ela não estava.

  A causa é que existem dois lugares onde as instruções podem morar: o cadastro do
  agente e a **versão publicada**. Quem atende o cliente é a versão. A tela mandava
  alguns agentes para o editor antigo, que grava no cadastro — o lugar que o
  atendimento não lê quando há versão publicada.

  Agora quem tem versão publicada é levado direto ao editor de versões, que grava
  onde o atendimento lê. E, se alguma outra ferramenta tentar mudar as instruções
  ou o modelo pelo caminho antigo, a resposta passa a ser um erro que explica o
  caminho certo, em vez de um sucesso que não teve efeito.

  Agente sem versão publicada continua exatamente como estava.

- **Título de novidade com aspas no meio chega inteiro à tela de atualização** O texto que descreve cada novidade é lido por quem opera a instalação, na tela
  de atualização, antes de decidir atualizar. Um título que citasse uma frase
  entre aspas chegava lá **torto**: a aspa de abertura sumia e a do meio ficava
  solta, como se o texto estivesse cortado.

  Num sistema de atendimento, citar o que o cliente escreve é o caso natural de um
  título — não a exceção. O primeiro título que precisou disso já saiu errado.

  Agora aspas no meio do texto são preservadas, e só somem quando envolvem o
  título inteiro — que é como alguém escreveria para "escapar" o texto.

  Nada muda no dia a dia de quem opera: nenhuma configuração nova, nenhum passo de
  atualização.

- **Um WhatsApp fora do ar deixa de pendurar a tela até o navegador desistir** Quando o serviço que conversa com o WhatsApp fica indisponível, o CRM ficava
  esperando por ele sem limite. A tela de conexão girava, o envio não voltava, e o
  único desfecho era o navegador ou o servidor desistirem sozinhos, minutos depois
  e sem explicação.

  O caso ruim não é o serviço recusar a conexão — isso já dava erro na hora. É o
  serviço aceitar e nunca responder, que é o que acontece quando ele está
  sobrecarregado ou travando: dali não vinha erro nenhum, só espera.

  Agora toda conversa com esse serviço tem prazo. Passou do prazo, o CRM desiste e
  diz que foi o tempo — em vez de deixar você olhando para uma tela parada sem
  saber se funcionou.

  Envio de áudio e vídeo tem prazo maior, de propósito: eles são convertidos antes
  de sair, e cortá-los no mesmo tempo de uma mensagem de texto faria mensagem
  legítima deixar de ser enviada.

- **Planilha exportada do Excel com acento entra inteira, sem virar caractere estranho** O Excel em português salva planilha num formato de texto antigo, e é o padrão
  dele — quem exporta a lista de produtos ou de contatos quase sempre manda esse
  arquivo. O sistema lia todos como se fossem do formato moderno, e o resultado
  dependia de onde estava o acento.

  Quando o acento estava nos **dados**, era o pior caso: a importação dizia
  "pronto, N produtos importados" e o catálogo ficava com nomes como
  `A��o C�nica` — sem um erro sequer. É esse nome corrompido que o atendente de IA
  lia em voz alta para o cliente, e ninguém confere linha a linha numa lista de
  300 itens.

  Quando o acento estava no **cabeçalho**, o arquivo inteiro era recusado com uma
  mensagem ilegível.

  Agora o sistema identifica o formato pelo próprio conteúdo do arquivo e lê os
  dois corretamente — sem você precisar reexportar nada. Vale para a importação de
  produtos e para a de contatos.

  E um arquivo que não é planilha de texto (um `.xlsx` renomeado, por exemplo)
  passa a ser recusado com a instrução do que fazer, em vez de virar centenas de
  linhas ilegíveis no seu catálogo.

- **Quem não é administrador volta a ver a lista de credenciais de IA** Um membro da equipe que não é administrador abria **IA › Provedores** e via a
  lista **vazia** — concluindo que a organização não tinha nenhuma chave
  cadastrada, quando tinha.

  Não havia erro nem aviso: a tela respondia normalmente, só que sem nenhuma
  linha. É a pior forma de falhar, porque parece uma informação verdadeira.

  A causa foi um ajuste de segurança anterior, que fechou a **escrita** dessas
  credenciais para quem não é administrador — e, sem querer, fechou a **leitura**
  junto. A tela de provedores é somente-leitura para esses papéis e nunca deveria
  ter sido afetada.

  Agora a leitura volta a valer para todo membro da organização, e a escrita
  continua restrita a administrador, como estava.

  A chave em si segue protegida: ela nunca foi exposta por essa tela, e continua
  inalcançável para qualquer papel — inclusive para quem passou a enxergar a
  lista.

- **A tela de chaves de IA explica o que deu errado e mostra quantos modelos a chave alcança** Quem colava uma chave de IA e errava via um código (`auth_failed_401`) no
  lugar de uma explicação, e quem acertava via a lista de modelos inteira colada
  por vírgula onde deveria haver um número. Se o servidor reiniciasse no meio da
  validação, o cartão dizia "Validando…" para sempre.

  Agora o cartão diz em português o que aconteceu ("O provedor recusou a chave.
  Confira se copiou inteira ou gere uma nova."), com o link para gerar outra;
  mostra a contagem de modelos; e, passados dois minutos sem resposta, troca
  "Validando…" por "Não validada" com a dica de revalidar. O diálogo de adicionar
  passa a dizer quando usar cada provedor, onde a chave mora e como ela começa.
  O botão de excluir só fica bloqueado quando a chave está de fato numa versão
  publicada de agente — a mesma regra que a API já usava.

  Nenhuma configuração nova, nenhum passo de atualização.

## [1.12.0] — 2026-09-02

### Adicionado

- **Catálogo de produtos próprio — com o preço que a IA responde ao cliente** Quem vende produto agora tem onde cadastrar o que vende. Antes, o único catálogo
  do sistema era o espelho de uma loja Nuvemshop: quem não usa Nuvemshop — a loja
  de rua, o showroom, quem vende pelo WhatsApp e só — não tinha lugar nenhum para
  pôr preço, e o agente de IA respondia "vou confirmar com a equipe" para a
  pergunta mais comum que existe, que é "quanto custa".

  Há uma tela nova em **Produtos**, no menu do CRM. Dá para cadastrar um a um, e dá
  para **importar a planilha que a loja já tem** — o arquivo do Excel, com os
  nomes de coluna que ela já usa (`código` ou `sku`, `preço` ou `valor`,
  `estoque` ou `qtd`). Reimportar a mesma planilha com preços novos **atualiza** os
  produtos em vez de duplicar, que é o gesto real de quando o custo muda.

  A importação recusa em vez de adivinhar. Uma linha com preço que não dá para ler
  não entra, e o relatório diz qual linha e qual foi o texto encontrado — um chute
  aqui vira preço errado dito a um cliente três dias depois. As linhas boas entram
  mesmo assim: uma planilha de 300 itens não morre inteira por causa da linha 7.

  Para a IA, a diferença é maior do que parece. A busca dela entende o cliente que
  escreve "ifone 15 128" e devolve exatamente o modelo de 128GB — nunca o de
  256GB, mesmo sendo quase o mesmo texto, porque é aí que o preço sai errado. E
  quando dois produtos casam igualmente bem, ela **pergunta** em vez de escolher.

  Só quem é gerente ou administrador altera preço; quem atende lê. Nada muda para
  quem já usa a integração com Nuvemshop — aquele catálogo continua onde estava.

### Corrigido

- **O segundo material que você ensina ao agente volta a funcionar** Ensinar mais de um documento ao mesmo assistente não funcionava, e **não havia como perceber**:
  o primeiro material era lido normalmente, e do segundo em
  diante a tela mostrava "pronto" enquanto o conteúdo nunca ficava disponível para
  a busca. O assistente respondia "não encontrei isso" sobre uma coisa que estava
  escrita num arquivo que você subiu — e nenhum aviso aparecia em lugar nenhum.

  Medido numa instalação real: cinco documentos enviados para o mesmo assistente,
  um funcionou, quatro ficaram parados. Os cinco apareciam como concluídos.

  A causa era interna: a numeração das versões do acervo passou a contar por
  documento, mas a regra do banco continuava contando por assistente — então o
  segundo documento sempre esbarrava no primeiro. Não era intermitente; nunca
  funcionava.

  Agora cada material tem a própria contagem, e os materiais antigos continuam
  válidos como estavam. Se você já subiu documentos que ficaram parados, basta
  reenviá-los depois de atualizar.

  Para quem opera uma instalação, nada muda no dia a dia: nenhuma configuração
  nova, nenhum passo de atualização.

- **O preço da planilha deixa de entrar dez vezes maior no catálogo** O catálogo de produtos aceita uma planilha para a loja não ter de cadastrar item
  por item. A leitura do preço tinha um erro de escala nas duas formas mais comuns
  de uma planilha brasileira chegar.

  **Um centavo escrito com um dígito só.** Quando a célula está formatada como
  número e mostra `1.299,90`, o Excel grava `1299,9` no arquivo — ele corta o zero
  do fim. O sistema lia esse único dígito como separador de milhar e gravava
  **R$ 12.999,00** no lugar de R$ 1.299,90. Dez vezes o preço, sem recusar a linha
  e sem avisar ninguém — e é esse preço que o atendimento automático responderia ao
  cliente.

  **Uma observação escrita ao lado do preço.** Quem escreve `R$ 5.499,00 (promo até
  10)` na mesma célula via os dígitos da observação grudarem no valor, e o produto
  entrava a R$ 54.990.010,00.

  Agora um ou dois dígitos depois da vírgula são sempre centavos — grupo de milhar
  tem sempre três, então um grupo menor não pode ser outra coisa. E célula com
  qualquer texto junto do número passa a ser **recusada**, com a linha apontada no
  relatório e a instrução de como escrever, em vez de virar um número plausível que
  ninguém confere numa lista de 300 itens.

  Para quem opera, nada muda: nenhuma configuração nova, nenhum passo de
  atualização. E nenhum catálogo precisa ser corrigido — o conserto sai na mesma
  versão que traz a importação de planilha, então nenhuma loja chegou a importar
  com o preço errado.

- **O atendimento automático não responde mais por cima de uma conversa entregue a uma pessoa** Quando a IA decide que um caso precisa de gente — cliente irritado, suspeita de
  pedido de descadastro, termo delicado —, ela entrega a conversa e silencia o
  atendimento automático até alguém resolver. A tela mostrava esse estado
  corretamente ("Automático pausado"), mas um segundo motor de resposta, que ainda
  atende instalações sem agente publicado, continuava respondendo assim mesmo.

  O resultado aparecia como o pior tipo de contradição: o painel dizia que uma
  pessoa ia assumir, o cliente recebia mensagem de robô, e ninguém do time ficava
  sabendo. A causa era uma comparação de datas que nunca dava certo para o valor
  "para sempre" que o produto usa nesses casos — a proteção existia no código e
  nunca chegava a agir.

  Agora os dois motores usam a mesma regra, a mesma que move a tela. Para quem
  opera, nada muda no dia a dia: nenhuma configuração nova, nenhum passo de
  atualização. O que muda é que "entreguei para uma pessoa" passa a valer de fato.

## [1.11.1] — 2026-08-31

> **Não publicada** — a tag `v1.11.1` nunca existiu: o corte não publicou imagens, e o que está abaixo chegou na 1.12.0.

### Corrigido

- **A Fila mostra quem realmente espera uma pessoa, e a aba do automático deixa de ficar vazia** A Inbox dizia quem estava no comando de cada conversa olhando um campo que o
  atendimento automático nunca consulta. O efeito era grande e silencioso: a aba
  **Fila** listava como "aguardando atendente" conversas que o robô estava
  respondendo naquele instante, e a aba do automático ficava quase vazia mesmo com
  ele atendendo a maior parte da caixa. Numa instalação real, medido: a Fila
  mostrava 83 conversas, a aba do automático mostrava 2, e o robô atendia 47.

  Quem via isso concluía a coisa errada em qualquer direção — ou que havia uma
  montanha de gente esperando, ou que a IA tinha parado de trabalhar.

  Agora as duas abas perguntam a mesma coisa que o motor: quem responde a próxima
  mensagem deste cliente. A Fila passa a listar só o que precisa de uma pessoa de
  verdade — conversas que a IA escalou, contatos travados para atendimento humano —
  e a aba do automático mostra o que ele está de fato conduzindo.

  **O número da Fila vai encolher bastante no primeiro acesso depois de atualizar.**
  Isso é o número certo aparecendo, não trabalho sumindo.

  A mesma correção alcança o "você é o Nº da fila" que o cliente ouve pelo WhatsApp,
  a numeração na tela e o painel de espera do gerente — os três passam a contar a
  mesma fila. Antes eles podiam divergir entre si.

  Para quem opera: nada a fazer. Nenhuma configuração nova, nenhum passo de
  atualização, nenhum dado alterado — só a leitura de quem está no comando.

- **Reclamar de cobrança errada não bloqueia mais o cliente** Quem escrevia "não me mande mais boletos" — ou "no me manden más cobros
  duplicados" — era tratado como se tivesse pedido para sair, e parava de ser
  atendido. É o oposto do que a pessoa quis dizer: ela está reclamando de uma
  cobrança e quer continuar falando com você.

  A regra olhava só o verbo ("mandar"), que é o mesmo de "não me mande mais
  mensagens". Agora ela olha também o que vem depois: quando o objeto é uma
  cobrança, uma fatura, um pedido ou um produto, deixa de ser pedido de saída.

  Pedir para sair de verdade continua funcionando igual, nas duas línguas.

- **O atendente de IA volta a achar horário quando consulta a agenda** Numa clínica, o atendente de IA tentou marcar um procedimento e não conseguiu —
  duas vezes seguidas. Ele fez tudo certo: descobriu o tipo de atendimento,
  resolveu a data que a pessoa pediu e foi consultar os horários. Mesmo assim
  respondeu que a equipe precisava confirmar, e abriu um chamado interno.

  A causa não era a agenda nem o atendente. Quando a IA não tem um dado opcional
  para preencher — no caso, qual profissional atenderia —, alguns modelos escrevem
  um código vazio em vez de simplesmente não mandar o campo. O sistema aceitava
  esse código como se fosse um profissional de verdade, procurava a agenda de
  alguém que não existe, e concluía que não havia horário publicado. Nenhum erro
  aparecia em lugar nenhum: a consulta era registrada como bem-sucedida.

  O sistema agora reconhece esses códigos vazios e os ignora, voltando a usar o
  profissional configurado no tipo de atendimento. Isso valia para dezenas de
  lugares além da agenda — inclusive a busca no acervo de conhecimento, em que o
  efeito era o atendente responder "não sei" com o material publicado ao lado, e o
  cadastro de negócios, em que um responsável inexistente ficava gravado e sumia
  dos filtros por dono.

## [1.11.0] — 2026-08-31

### Adicionado

- **Marcar ou confirmar um agendamento move o lead no funil sozinho** Antes, marcar ou confirmar um horário na agenda não mexia no card do negócio: a
  equipe precisava arrastar o lead manualmente para "Agendamento solicitado" ou
  "Agendado" (ou como quer que a organização tenha nomeado essas etapas).

  Agora, quando um agendamento nasce pendente de confirmação, o lead se move para
  a etapa do funil marcada com o slug `agendamento-solicitado`; quando o
  agendamento é confirmado, ele se move para a etapa `agendado`. É opt-in: quem
  não criou essas etapas no funil não vê nenhuma mudança de comportamento. Cancelar
  ou faltar a um compromisso não move o lead — o negócio pode ter outro horário
  remarcado, e quem decide que ele esfriou continua sendo o agente de IA ou uma
  pessoa da equipe.

- **O atendente de IA passa a marcar consulta pela conversa** Quem instalou e ligou a agenda tinha um atendente de IA que consultava horário e
  não fechava nada: o paciente pedia "quinta às 14h" e a resposta era sempre "vou
  confirmar com a equipe". Faltavam duas coisas, e nenhuma delas era o modelo.

  A primeira: ele não sabia que dia era hoje. Nenhuma informação sobre a data
  chegava até ele, então não tinha como transformar "quinta que vem" ou "amanhã de
  manhã" num horário de verdade. Agora todo atendimento começa sabendo a data, a
  hora e o dia da semana, no fuso que você escolheu nas configurações da empresa.

  A segunda: ele não tinha como descobrir o que a sua empresa atende. Consulta,
  retorno, avaliação, procedimento — a lista está no sistema, e ele não conseguia
  lê-la; tinha que adivinhar o nome exato e errava. Agora existe uma capacidade
  nova, "Ver o que a empresa atende", que mostra a ele os tipos de atendimento com
  a duração de cada um.

  Junto vieram outras duas: confirmar um horário quando a pessoa avisa que vem, e
  registrar depois se ela foi atendida ou não apareceu. E a lista de horários
  livres passou a sair em português — "sexta-feira 04/09 às 14:00" em vez de um
  código de data —, com um número menor de opções por vez, o que também deixa a
  resposta mais rápida.

  O sistema também passou a recusar um registro que antes aceitava calado: marcar
  "faltou" num compromisso que ainda nem começou. Isso devolvia o horário para
  outra pessoa enquanto o cliente original ainda estava contando com ele.

  **As capacidades novas não entram sozinhas nos agentes que já existem.** Para o
  seu atendente usá-las, abra *O que o agente pode fazer*, ligue o pacote
  **Vender** de novo e publique. Agente criado a partir de agora já nasce com elas.

### Corrigido

- **O canal Zernio volta a enviar em quem configurou a partir do arquivo de exemplo** Quem conectou o canal Zernio numa instalação montada a partir do arquivo de
  exemplo não conseguia enviar mensagem nenhuma por ele. As duas credenciais
  estavam certas, o canal aparecia configurado, e o envio falhava assim mesmo —
  tanto para quem deixou as credenciais na configuração quanto para quem as
  cadastrou pela tela.

  A causa estava no endereço do provedor. O arquivo de exemplo traz essa linha
  vazia, e o comentário ao lado dela promete que vazio usa o endereço de produção
  do provedor — a linha só existe para quem precisa apontar o sistema a um
  ambiente de homologação. Não era o que acontecia: o vazio era tratado como se
  fosse um endereço de verdade, e o sistema tentava falar com um lugar que não
  existe.

  Agora vazio significa o que o arquivo sempre disse que significava. Quem
  preencheu a linha para apontar para homologação continua sendo respeitado, e
  espaço sobrando em volta do endereço deixa de atrapalhar.

  Ninguém precisa mexer em nada. Instalações que já enviavam seguem iguais, e as
  que estavam com esse envio quebrado voltam a funcionar sozinhas.

- **Quem pede para sair em espanhol passa a ser atendido** Pedir para sair em espanhol só funcionava numa forma: a palavra sozinha, ou
  "no quiero recibir". As formas que as pessoas realmente escrevem — "deja de
  escribirme", "no quiero más mensajes", "dame de baja" — não casavam padrão
  nenhum, e o pedido se perdia em silêncio.

  O sinal que faz o robô parar de responder e chamar uma pessoa (o nível
  "ambíguo", usado quando o pedido não é claro o bastante para bloquear
  sozinho) também não existia em espanhol: nenhuma frase daquele idioma
  chegava a ativá-lo, então esse cliente nunca era escalado.

  De passagem, corrige um caso em português que só apareceu ao testar os dois
  idiomas juntos: "pare de mandar o pedido nesse endereço" bloqueava um
  cliente que só queria mudar a entrega.

- **O relógio interno do assistente deixa de depender da versão do banco** Quando uma conexão de WhatsApp entra em espera, o sistema marca a fila com uma
  data "infinita" — é assim que ele segura o atendimento até alguém resolver o
  aviso. O cálculo de quanto falta para a próxima tarefa fazia uma conta com essa
  data que **só funciona no Postgres 17**; em Postgres 15 ou 16 o banco recusa a
  conta e o relógio do assistente para.

  Isso nunca afetou quem seguiu a versão recomendada. Passa a importar agora que a
  instalação aceita bancos mais antigos — e é exatamente onde apareceria: numa
  máquina nova, com uma conexão em espera, sem nada na tela explicando.

  A proteção já existia, mas na ordem errada: ela limitava o resultado da conta,
  e a conta estourava antes. Agora limita a data antes de calcular.

## [1.10.2] — 2026-08-30

### Corrigido

- **Quando a IA fica calada, agora dá para ver por quê** Três consertos que atacam o mesmo problema: o sistema fazia a coisa certa em
  silêncio, e de fora parecia quebrado.

  **A ficha de proteção de envio parou de congelar o padrão do dia.** O botão
  "Enviar aos domingos" era o único controle daquela ficha que não sabia dizer
  "não mexi": ele gravava sempre o valor que estava na tela, e o valor na tela,
  sem escolha própria, era o padrão vigente. Quem abriu a ficha para declarar o
  aquecimento do número acabou congelando o padrão daquele dia — e, quando o
  produto passou a liberar domingo, essa instalação ficou para trás com uma
  escolha que ninguém fez. Agora só um valor DIFERENTE do padrão vira escolha.
  Quem desligou o domingo de propósito continua com ele desligado.

  **A espera pela janela de envio virou aviso na Central.** Quando o número está
  fora do horário de envio, as respostas ficam na fila e saem na abertura — isso
  não mudou. O que mudou é que agora existe um aviso dizendo que estão esperando,
  a partir de quando saem e o que fazer. Um aviso por número, e ele se resolve
  sozinho quando o horário reabre.

  **A aba "Execuções" de um agente mostra o que ele realmente fez.** Ela lia uma
  tabela que nenhum motor em uso escreve, e por isso dizia "Nenhuma execução
  ainda" mesmo com o agente respondendo. Passou a ler o registro vivo. Execuções
  anteriores a esta versão não aparecem ali — para o histórico completo, use
  IA › Execuções.

## [1.10.1] — 2026-08-28

### Corrigido

- **A Central de atendimento abre mais rápido quando a equipe é grande** Cada vez que a Central era aberta, o sistema perguntava o nome de cada pessoa
  da equipe que aparecia na página — uma pergunta separada para cada uma, toda
  vez, mesmo quando o nome nem ia ser mostrado na tela.

  Numa equipe pequena isso passava despercebido. Numa equipe grande, não: o
  tempo medido era de cerca de 350 milissegundos com dez pessoas atendendo, e de
  mais de um segundo com cinquenta — só para descobrir nomes que o sistema já
  poderia ter guardado.

  Agora o nome de quem atende fica guardado junto com a conversa, e é atualizado
  sozinho sempre que o atendimento troca de mãos. A Central abre no mesmo tempo
  com uma pessoa ou com cinquenta.

  Nada a fazer: a atualização do banco acontece sozinha quando você roda a
  atualização normal, e os nomes de quem já estava atendendo são preenchidos na
  hora.

- **Quem administra duas empresas entra sempre na mesma** Quem participa de mais de uma empresa na mesma instalação podia entrar numa ou na
  outra sem critério, ao acessar o sistema sem uma escolha anterior guardada — no
  primeiro acesso, numa sessão nova ou depois de a preferência expirar. O sistema
  não tinha regra para decidir qual delas abrir. Agora abre sempre a mais antiga, e
  a escolha feita no seletor de empresa continua valendo por cima disso. Quem tem
  uma empresa só não vê diferença.

- **Agenda sem responsável configurado: o aviso agora diz onde resolver** Numa instalação nova, ou quando um novo tipo de agendamento aponta para alguém
  que ainda não cadastrou horário de atendimento, tentar ver ou marcar um horário
  mostrava "Invalid input: expected object, received undefined" — frase correta
  para quem lê o código e inútil para quem opera a clínica.

  Agora a mensagem diz o que realmente falta e onde resolver: "A disponibilidade
  deste responsável ainda não foi configurada. Configure em Equipe →
  Atendimento." Continua sendo a mesma recusa de antes (nenhum horário é
  oferecido enquanto isso não for configurado) — só a explicação ficou legível.

  Quem já tinha disponibilidade cadastrada não percebe nenhuma diferença.

- **Quem publica o sistema com a própria marca passa a checar a atualização no lugar certo** Se você mantém uma cópia própria do projeto e publica as imagens do sistema com
  o seu próprio endereço, o comando de atualização olhava para o endereço do
  projeto original — e não para o seu — quando a configuração do servidor não
  dizia explicitamente qual imagem usar. Ele então comparava a versão instalada
  com a de outra pessoa, e podia anunciar que havia atualização quando não havia,
  ou o contrário.

  O endereço agora é lido de um ponto único do próprio kit, o mesmo que o resto
  da instalação usa. Quem opera com o projeto original não percebe diferença: o
  endereço lido é exatamente o que já estava escrito antes.

- **Quatro consertos que a versão anterior anunciou e não trouxe chegam agora** A lista de mudanças da versão 1.10.0 anunciou quatro consertos que não estavam
  dentro dela. Foi um erro nosso de ordem: os textos que descrevem os consertos
  entraram no projeto antes do código deles, e a versão foi fechada no meio.

  Se você atualizou para a 1.10.0 esperando alguma destas quatro coisas, elas
  chegam agora:

  - **A instalação nova não obriga mais a verificação em duas etapas.**
    Quem instalava pelo instalador automático era parado por uma tela de
    verificação em duas etapas logo depois do primeiro acesso, sem nunca ter
    sido avisado disso.
  - **Quando a inteligência artificial falha ao responder, o erro deixa de sumir.**
    A falha ficava só no registro técnico do servidor e não chegava a ninguém.
  - **O instalador para de confundir comentário com valor de configuração.**
    No arquivo de exemplo da VPS, um comentário escrito na mesma linha do valor
    era lido como parte do valor.
  - **Uma rede a mais contra vazamento entre empresas.**
    Esta é sobre as próximas versões, não sobre a sua instalação de hoje: uma
    tabela nova que seja criada sem a proteção que separa os dados de cada
    empresa passa a ser recusada na nossa conferência, antes de virar uma
    atualização que chega até você.

  Nada a fazer além de atualizar normalmente. Quem instalar do zero a partir
  desta versão nunca viu o problema.

- **O que você marca no Google passa a aparecer na agenda do CRM** Compromissos criados direto no Google Agenda já bloqueavam o horário — ninguém
  conseguia marcar por cima —, mas não apareciam na tela: a agenda parecia vazia e
  o horário indisponível ao mesmo tempo. Agora eles aparecem como faixa de
  ocupação, com visual próprio e sem clique, porque não são compromissos do CRM:
  não têm cliente, tipo nem responsável, e remarcá-los teria de ser feito no
  Google.

  A faixa mostra apenas o horário ocupado, **não o nome do evento**. A agenda
  conectada é pessoal de quem atende, e esta tela é vista por outras pessoas da
  empresa — o título de um compromisso particular não deve aparecer aí.

- **Os compromissos do CRM voltam a aparecer no Google Agenda** Quem conectou o Google Agenda não via os compromissos marcados no CRM chegarem
  lá — nenhum, nunca. O sistema tentava a cada cinco minutos e o Google recusava
  todas as vezes, porque o pedido usava a operação de "alterar um evento
  existente" para criar um evento que ainda não existia. Agora ele cria com a
  operação certa e só altera o que já está lá. Os compromissos pendentes sobem na
  primeira rodada após a atualização, sem duplicar os que porventura já existam.

  A falha também deixou de ser silenciosa: quando o Google recusar, o motivo passa
  a aparecer no registro do sistema, e não só numa coluna interna que ninguém abre.

## [1.10.0] — 2026-08-28

### Adicionado

- **O sistema inteiro em espanhol, com o idioma trocável em três lugares** Quem instala na América Latina agora escolhe o idioma **na própria instalação**,
  e o sistema abre em espanhol para todo mundo da empresa — inclusive para quem
  for convidado depois e nunca abriu o próprio perfil.

  Antes, o espanhol existia pela metade: só as telas do dia a dia estavam
  traduzidas, e o resto aparecia em português para quem tinha escolhido espanhol.
  Agora a tradução cobre Agenda, Desempenho, Radar, Respostas rápidas, IA e o
  painel de administração, com um teste automático que reprova qualquer texto novo
  que apareça sem tradução.

  O idioma se troca em três lugares, na ordem em que se costuma precisar deles:

  - **No topo de qualquer tela** — o botão `PT`/`ES` ao lado do controle de tema.
    Um clique, sem procurar nada. É onde recorre quem abriu o sistema num idioma
    que não lê.
  - **Na instalação** — o `install.sh` pergunta, e a resposta define o idioma da
    empresa inteira.
  - **Em Configurações** — no seu perfil (só para você) ou em Organização (para
    todo mundo que entrar sem preferência própria).

  Também está consertado um controle que não fazia nada: o seletor de Idioma em
  Configurações › Organização era gravado no banco e nunca era lido. Quem o
  mudasse não via diferença nenhuma. Agora ele vale para toda pessoa da empresa
  que não tenha escolhido um idioma seu.

  **As datas também acompanham o idioma.** "quinta-feira, 3 de março" vira
  "jueves, 3 de marzo" — não sobrou aquele meio-termo em que a tela fala espanhol
  e a data insiste no português.

  Duas exceções, de propósito: os **e-mails** que o sistema envia seguem em
  português (quem recebe um convite ainda não tem conta, então não há preferência
  de idioma para consultar), e o **relatório de LGPD** também — ele responde a uma
  lei brasileira, e mudar a forma dele conforme quem apertou o botão seria errado.

  ---

  A tradução para espanhol é, em boa parte, contribuição de **@JowaniOrantes**, que
  abriu três frentes de trabalho por conta própria: as áreas de IA e administração
  (#352), o módulo de Agenda (#379) e as correções que vieram do QA visual dele.
  São 57 commits e mais de 460 entradas de dicionário que este release não teria
  sem esse trabalho.

### Corrigido

- **Pausar um agente de IA agora o cala de verdade** Pausar o único agente publicado da organização fazia um agente que a tela
  chamava de "Rascunho" voltar a responder no WhatsApp pelo caminho antigo de
  resposta — com o texto do cadastro, sem as ferramentas nem os limites da versão
  publicada.

  Junto disso, a tela passou a dizer a mesma coisa que o motor faz: o seletor de
  dono de negócio deixou de esconder agentes publicados (e de oferecer os
  pausados), e o selo da Inbox só diz "Automático" quando existe mesmo alguém para
  atender.

- **Instalação nova não obriga mais a verificação em duas etapas logo de cara** Quem instalava pelo instalador automático caía, logo depois do primeiro acesso,
  numa tela obrigatória pedindo para cadastrar a verificação em duas etapas — um
  passo que o assistente de instalação nunca anunciou. A verificação é opcional
  desde a versão 1.0 e se liga em Configurações › Segurança, mas o instalador não
  acompanhou essa decisão e deixava o valor obrigatório.

  Quem já instalou e já configurou a verificação não é afetado: nada é desligado
  de quem já tem. A mudança vale só para instalações novas, que passam a nascer
  como sempre foi a intenção — com a escolha nas mãos de quem administra.

- **O mesmo celular escrito das duas formas passa a cair sempre no mesmo cadastro** Quando um celular ainda existia gravado nas duas formas — com e sem o nono
  dígito —, o sistema podia escolher qualquer uma das duas ao reencontrar a
  pessoa. Na prática isso aparecia no pior momento: a resposta do cliente entrava
  no cadastro errado, o follow-up não a reconhecia como resposta, e a mesma
  pergunta era enviada de novo.

  Agora a escolha é sempre a mesma e é sempre a forma com o nono dígito, que é a
  que o CRM guarda e mostra. Você não precisa fazer nada.

- **Quando a IA falha ao responder, o erro deixa de sumir** A peça que faz a IA responder às conversas registrava as próprias falhas apenas
  num log que ninguém lê. Se ela parava de responder por um erro, não havia sinal
  em lugar nenhum — só o silêncio no WhatsApp do cliente. Agora esse erro é
  enviado ao serviço de monitoramento, o mesmo que o resto do sistema já usava.

  Quem opera não precisa fazer nada, e nenhum dado de conversa é enviado: o
  sistema já limpa o conteúdo antes de mandar.

- **O instalador para de confundir comentário com valor de configuração** No arquivo de exemplo que serve de base para a configuração da VPS, as
  explicações ficavam na mesma linha dos valores. O instalador lê esse arquivo
  linha a linha e tratava a explicação como parte do valor — então uma senha, um
  endereço ou uma chave podiam chegar ao servidor com um texto extra colado no
  fim, e o erro só aparecia depois, num lugar sem relação com a causa.

  As explicações passaram para a linha de cima. Quem já tem o servidor rodando não
  precisa refazer nada; a mudança protege quem instala do zero a partir de agora.

- **Quem baixa o projeto no Windows consegue rodar os testes** Isto é do nosso processo de desenvolvimento, não do sistema que você usa. Quem
  baixava o projeto no Windows não conseguia rodar a bateria de testes do banco:
  o sistema operacional alterava os arquivos de banco de dados na cópia, e uma
  conferência de integridade recusava tudo antes de o primeiro teste rodar.

  Para quem opera uma VPS nada muda — o servidor sempre rodou em Linux, onde a
  alteração não acontece.

- **O relógio externo do follow-up passou a ser testado de ponta a ponta** Quem roda o sistema numa hospedagem sem agendador próprio — o plano gratuito da
  Vercel é o caso comum — depende de um serviço de cron externo bater de tempos em
  tempos para os follow-ups andarem. Esse caminho tinha runbook e nunca tinha sido
  exercitado: se ele parasse de funcionar, ninguém receberia erro, e os follow-ups
  simplesmente ficariam parados.

  Agora um teste automático dispara a batida de fora, como o cron real faz, e
  confere que o follow-up de fato anda — e que uma batida sem a chave certa é
  recusada sem mexer em nada. Você não precisa fazer nada: nada mudou no
  comportamento, só passou a existir uma rede que avisa se ele quebrar.

- **Uma rede a mais contra vazamento entre empresas** O sistema separa os dados de cada empresa por uma regra no banco, e essa regra
  precisa ser ligada tabela por tabela. Faltava uma verificação automática que
  recusasse uma tabela nova sem essa proteção — a conferência dependia de alguém
  lembrar. Agora ela é feita a cada mudança, e o que já existe está registrado
  como dívida conhecida, para a lista só diminuir.

  Nada muda para quem opera: é uma proteção contra um erro futuro, não a correção
  de um vazamento existente.

## [1.9.1] — 2026-08-28

### Corrigido

- **O Google Agenda conectado passa a aparecer como conectado** Quem conectava o Google Agenda continuava vendo o botão "Conectar Google" na
  tela, como se nada tivesse acontecido — e ao clicar em desconectar recebia um
  erro dizendo que não havia agenda conectada. Os compromissos marcados no CRM
  também nunca chegavam ao Google Agenda, em silêncio.

  A conexão sempre foi gravada corretamente; o que estava errado era o nome pelo
  qual três partes do sistema a procuravam, e por isso nenhuma delas a encontrava.
  Agora a tela mostra a conta conectada, desconectar funciona, e os compromissos
  sobem para o Google na primeira rodada seguinte. Quem já conectou não precisa
  reconectar: a conexão está lá e passa a ser vista.

- **A lista de horários volta a rolar ao marcar um compromisso** Ao escolher o dia, os últimos horários ficavam abaixo da borda da tela sem
  nenhuma forma de alcançá-los — nem rolando a página, nem a própria lista. Quem
  precisava de um horário do fim da tarde não conseguia marcar. Agora a lista rola
  sozinha, com o calendário e os dados do atendimento parados ao lado, e em telas
  menores o painel inteiro rola.

- **As verificações automáticas do projeto voltaram a caber no tempo** Isto é do nosso processo de desenvolvimento, não do sistema que você usa: a
  bateria de testes que roda antes de cada mudança tinha crescido a ponto de
  estourar o tempo limite e ser cancelada no meio. Ela passou a rodar em duas
  frentes ao mesmo tempo, o que a devolveu para dentro do limite com folga. Para
  quem opera uma VPS nada muda — só a chance de uma correção demorar mais a sair
  porque a verificação foi cancelada por tempo.

- **Áreas de administração passam a exigir a verificação em duas etapas** Quatorze telas e ações de administração conferiam apenas o papel de quem
  acessava, sem cobrar a verificação em duas etapas de quem a tem ativada. Entre
  elas estavam as que conectam o número oficial do WhatsApp, as que trocam a
  credencial do provedor de inteligência artificial e as que alteram os limites de
  segurança do agente — justamente as que mais importam.

  Quem já usa o sistema não precisa fazer nada, e quem não ativou a verificação
  continua entrando como antes. A mudança é que, para quem a tem ativada, ela
  passa a valer também nesses lugares.

- **Trocar para uma organização ainda não configurada deixava você preso** Quem participa de mais de uma organização podia trocar pelo seletor no topo e
  cair no assistente de configuração da organização nova — o que está certo, ela
  não foi configurada ainda. **O que estava errado é que não havia como sair de lá.**
  O seletor de organização some junto com o resto do sistema nessa tela, e sobravam
  só os links de Termos e Privacidade e um botão "Continuar" desabilitado. A saída
  era fechar o navegador e limpar os dados do site.

  Agora o assistente mostra, no topo, o caminho de volta para as outras
  organizações de que você participa — um clique e você está de volta onde estava
  trabalhando.

  Nada muda para quem administra uma organização só: o botão não aparece, porque
  não há para onde voltar.

- **Voltar da autorização do Google não pede login de novo** Ao conectar o Google Agenda, o navegador voltava e caía na tela de login — o que
  se lia como "o sistema me deslogou". A sessão nunca foi encerrada: o navegador é
  que, por segurança, não apresenta a credencial numa página aberta a partir de
  outro site, e a volta do Google era exatamente isso. Agora o retorno passa por
  uma página intermediária do próprio sistema, e a pessoa cai direto na Agenda,
  ainda conectada. Quem já usava não precisa fazer nada.

## [1.9.0] — 2026-08-28

### Adicionado

- **A agenda virou agenda — clicar num horário marca, arrastar um card remarca** A grade da Agenda mostrava a semana e não aceitava nada: clicar num espaço vazio
  não fazia nada, e arrastar um compromisso não fazia nada. Para marcar era preciso
  sair da grade, abrir "Novo agendamento" e escolher a data de novo no
  mini-calendário — mesmo tendo acabado de apontar para o horário na tela.

  Agora a grade responde:

  - **Clicar num horário livre abre a marcação já naquele horário.** Os horários
    que aceitam clique são exatamente os que você publicou em Equipe › Atendimento
    — os mesmos que o agente de IA oferece ao cliente. A tela não inventa horário:
    se não está publicado, não é clicável.
  - **Horário que não aceita marcação diz por quê**, em vez de ficar apagado sem
    explicação: "você ainda não publicou seus horários", "já há um compromisso
    neste horário", "fora dos horários que você publicou".
  - **Arrastar um compromisso para outro horário remarca**, com uma confirmação
    antes — quem foi atendido recebe aviso da mudança, então o gesto não consuma
    sozinho. Soltar fora dos horários publicados é recusado com o motivo, e o
    compromisso volta para onde estava; se o servidor recusar, ele volta também.
  - **Quem usa teclado remarca do mesmo jeito**: com o compromisso em foco,
    `Alt + ↑/↓` salta de vaga em vaga, `Alt + ←/→` muda de dia, `Enter` confirma e
    `Esc` desfaz.

  Nada muda no que já estava marcado, e nada precisa ser configurado para isto
  funcionar — se a sua equipe já publicou os horários de atendimento, a grade já
  está clicável.

### Corrigido

- **Conectar a agenda do Google passa a concluir de verdade** Quem clicava em conectar a conta do Google era levado à tela de autorização,
  autorizava, e voltava para uma página de erro — a conexão nunca se completava.
  Não era problema da conta nem da instalação: a volta da tela de autorização era
  recusada pelo sistema antes de chegar ao lugar certo, em qualquer instalação.
  Se você tentou conectar e desistiu, tente de novo: agora vai até o fim.

  A mesma recusa acontecia na volta da conexão com a Nuvemshop, e também foi
  corrigida.

  Para conectar o Google, quem administra a instalação continua precisando
  cadastrar as credenciais em Administração › Google e registrar o endereço de
  retorno no console do Google — exatamente o endereço que a própria tela mostra,
  terminando em /api/v1/agenda/google/callback. Sem esse endereço registrado, o
  Google recusa a autorização antes de o sistema ser chamado.

- **A coluna de horários volta a caber na tela ao marcar um compromisso** Ao escolher o dia, a lista de horários aparecia cortada pela borda direita e
  saía da tela — não dava para escolher horário nenhum, e nem diminuir o zoom nem
  rolar a página resolvia. As três colunas do painel somavam mais largura do que a
  janela onde ele abre, e o excedente era cortado sem barra de rolagem. Agora o
  painel abre mais largo quando a tela permite, e em telas menores a lista de
  horários aparece embaixo do calendário em vez de ao lado.

- **O botão "Ver na agenda" passa a levar até o compromisso marcado** Depois de marcar, o botão "Ver na agenda" da confirmação não fazia nada: o clique
  caía no vazio. Agora ele fecha o painel e leva a agenda até o dia do compromisso
  — inclusive quando ele foi marcado para outra semana, que era o caso em que
  mesmo fechar o painel não teria adiantado, porque a agenda continuaria mostrando
  a semana atual.

## [1.8.0] — 2026-08-27

### Adicionado

- **A tela diz quem consulta cada material** Um documento que nenhum assistente lê aparece marcado como tal: acervo que ninguém consulta
  é dinheiro gasto sem efeito, e isso era invisível.

- **Avisos de mensagem e de CRM chegam com a aba fechada** Antes, quem minimizava ou fechava a aba parava de ver aviso de mensagem nova e
  de movimento no funil — voltava e descobria tudo de uma vez. Agora o navegador
  mostra o aviso na bandeja do sistema mesmo com o site fechado, e clicar nele
  abre a conversa certa.

  Cada pessoa liga isso em Configurações › Notificações, e o navegador pede
  permissão uma vez. **Nada muda para quem não ligar.**

  Para a instalação inteira poder mandar esses avisos, quem administra a VPS
  gera um par de chaves uma única vez (`npx web-push generate-vapid-keys`) e o
  coloca no `.env`, em `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`.
  **Sem essas chaves o produto continua funcionando exatamente como antes**, com
  os avisos aparecendo só enquanto o site está aberto.

- **As credenciais do Google Agenda passam a ser cadastradas pela tela** Para ligar a sincronização com o Google Agenda era preciso acessar o servidor por
  linha de comando, editar um arquivo de configuração e reiniciar o sistema. Quem
  administra a instalação agora faz isso em Admin › Google Agenda: cola o ID e a
  chave do aplicativo, e o endereço de retorno já vem pronto para copiar no painel
  do Google.

  A chave é guardada cifrada e nunca mais aparece na tela — só é possível
  substituí-la. Quem já tem as credenciais no arquivo de configuração não precisa
  fazer nada: elas continuam valendo, e o que for salvo pela tela passa a valer no
  lugar delas. Ao trocar uma credencial já em uso, quem tinha conectado a agenda
  precisa conectar de novo — é o Google que invalida as autorizações antigas, e a
  tela avisa antes.

- **Dá para ver o que o agente aprendeu de cada material** O botão "Ver o que ele aprendeu" mostra os trechos exatos que ele procura antes de
  responder. Quando ele erra sobre um assunto, é ali que se descobre o porquê — antes a tela
  mostrava só um número.

- **Enviar arquivo passou a funcionar** PDF, Markdown ou texto, até 20 MB — ou cole o texto direto na tela, se preferir. Antes só
  existia o formato pergunta/resposta; quem tentava subir um PDF não tinha por onde.

- **O material do seu negócio agora é da empresa, e cada assistente escolhe o que lê** Antes, o que o agente sabia pertencia a UM assistente: dois times com o mesmo manual de
  trocas precisavam cadastrá-lo duas vezes, indexá-lo duas vezes e pagar por ele duas vezes.
  Agora o acervo é da organização — em **IA › Conhecimento** — e na tela de cada assistente há
  uma seção **"O que ele consulta antes de responder"**, onde você marca o que aquele
  assistente pode ler. O mesmo documento serve a quantos assistentes você quiser.

- **O follow-up anda mesmo em hospedagem sem agendador** Em ambientes que não têm agendador de verdade — o plano gratuito da Vercel é o
  caso comum — os follow-ups e as tarefas de bastidor só andavam quando alguém
  abria o sistema. Um lead que respondia de madrugada ficava esperando.

  Agora existe uma batida de relógio que pode vir de fora: um serviço gratuito de
  cron chama uma vez a cada poucos minutos e o sistema faz o que estava pendente.
  O passo a passo está no runbook do relógio.

  **Quem roda numa VPS com o agendador normal não precisa fazer nada** — ali o
  relógio já existia e continua igual.

### Alterado

- **O agente de IA passa a caber 25 capacidades, e alcança as de agenda** Quem já tinha o agente com a lista cheia lia "20 de 20 capacidades ligadas.
  Limite atingido." e não conseguia ligar as capacidades de agenda — ver horários
  livres, marcar, remarcar, desmarcar —, que aparecem na lista mas ficavam
  desabilitadas. O limite passou de 20 para 25.

  Isso não muda nada no que já está configurado: nenhum agente perde capacidade, e
  quem não estava no limite não vê diferença. Quem estava agora consegue ligar mais
  uma jornada. Agentes criados antes da Agenda não recebem as capacidades novas
  sozinhos — a lista de cada versão é uma foto congelada; é preciso abrir
  "O que o agente pode fazer" e ligá-las.

### Corrigido

- **A Agenda passa a dizer por que os dias estão travados** O calendário abria com o mês inteiro sem clique e nada explicando. Havia estados
  em que nem o aviso aparecia: numa instalação nova, em que ninguém publicou a
  jornada de atendimento, a consulta falhava e a tela concluía que estava tudo
  certo; e avançar dois meses levava a um período que a busca nunca cobriu, também
  em silêncio. Agora o bloco de aviso e os dias apagados saem da mesma conta,
  cada dia diz a causa ao passar o mouse e para quem usa leitor de tela, e o botão
  de avançar mês não leva mais a um período vazio por construção.

- **A tela de marcar mostra o local e o fuso reais, e dá para registrar o desfecho** Ao marcar um horário, o painel dizia "Presencial · Sala 2" e "horários no fuso
  America/Sao_Paulo" para todo mundo — texto de exemplo que nunca era trocado pelo
  que estava configurado no tipo de agendamento. Quem atende em outro fuso via a
  hora errada anunciada. Agora ele mostra o local que você cadastrou e o fuso de
  verdade, e some com a linha quando não há o que mostrar, em vez de inventar.

  No histórico, os botões "Realizado" e "Faltou" ficavam sempre cinzas, dizendo que
  estariam disponíveis quando a agenda estivesse conectada ao Google — o que nunca
  teve relação. Agora funcionam. Marcar "Faltou" devolve o horário para outra
  pessoa poder pegar.

- **Compromissos marcados no CRM passam a aparecer no Google Agenda** Quem conectou o Google Agenda não via os compromissos do CRM chegarem lá — nunca,
  em instalação nenhuma. A tarefa que faz esse envio pedia os pendentes ao banco de
  um jeito que o banco recusava, e ela falhava a cada cinco minutos desde que o
  módulo saiu, deixando só um aviso no registro técnico. Agora ela pede certo, e o
  que já está marcado sobe na primeira rodada depois da atualização. Não é preciso
  reconectar nada nem mexer em arquivo: a atualização já traz a mudança do banco.

- **A tela de Notificações passa a dizer o que falta para o aviso chegar com a aba fechada** A tela dizia que o aviso por Push "já funciona", sem conferir se esta instalação
  tinha como enviá-lo. Quem ligava a opção via o navegador pedir permissão,
  concedia, e depois não recebia nada com a aba fechada — sem nenhuma pista do
  motivo, e sem como descobrir o que fazer.

  Agora, quando faltam as chaves do Web Push, a própria tela avisa que os avisos
  só aparecem com o site aberto e mostra o comando para gerar o par de chaves e
  onde colocá-lo. Quando as chaves já estão no lugar, ela anuncia que o aviso
  chega também com a aba fechada e para de pedir configuração.

  **Você não precisa fazer nada.** A opção de Push continua podendo ser ligada dos
  dois jeitos: mesmo sem as chaves, o aviso na bandeja do sistema já funciona
  enquanto o DeskcommCRM está aberto numa aba.

- **A Agenda passa a mostrar só a organização que está selecionada** Quem administra mais de uma empresa na mesma instalação via a Agenda somando as
  duas: os tipos de agendamento apareciam repetidos, e clicar em metade deles
  respondia que o tipo não foi encontrado. Nada estava duplicado no banco — a tela
  é que mostrava as duas empresas juntas. Agora ela mostra só a que está
  selecionada no alto da página, e trocar de empresa troca a lista. O mesmo valia
  ao abrir um contato, um lead ou um funil pelo endereço direto. Para quem tem uma
  empresa só, nada muda.

- **Arquivar um material não liberava o espaço** Arquivada, a fonte continuava ocupando o lugar e não dava para criar outra do mesmo tipo —
  nunca mais, sem mensagem que explicasse.

- **Cadastrar a chave da OpenAI pela tela não ligava a base de conhecimento** O produto dizia, em duas telas, que a OpenAI é necessária "para indexar o seu material" — e
  o motor só olhava para a chave do arquivo de configuração da instalação. Quem cadastrou a
  chave em IA › Credenciais e viu o material parado estava vendo esse defeito. Agora a chave
  sai da sua organização, e a tela de conhecimento **diz qual está valendo**.

- **O mesmo celular com e sem o nono dígito deixa de virar dois contatos** `+55 32 8479-3302` e `+55 32 98479-3302` são a mesma pessoa, e o CRM tratava as
  duas grafias como contatos diferentes. O efeito aparecia no pior momento: a
  resposta do cliente entrava no cadastro errado, o follow-up não a reconhecia
  como resposta, e a mesma pergunta era enviada de novo.

  Agora o CRM guarda e mostra sempre a forma com o nono dígito, encontra a pessoa
  pelas duas grafias na entrada, e **junta os pares duplicados que já existiam**
  na sua base ao atualizar. Fixo e número estrangeiro não mudam. O envio ao
  WhatsApp continua tentando as duas grafias, como antes.

  E a resposta do lead passa a acordar o follow-up: quem responde antes do prazo
  não fica esperando o relógio para seguir no fluxo.

- **Conversas marcadas como aproveitáveis eram perdidas** A rotina que as prepara gravava zero trechos por um erro de configuração do banco, e mesmo
  assim as marcava como aproveitadas — o que as tirava da fila para sempre.

- **Duplicar um assistente perdia o escopo dele** A cópia nascia sem os funis em que o original mexia — e teria nascido sem os materiais
  também. Criar assistente pela API tinha o mesmo problema: o pedido era aceito e metade dos
  campos, descartada.

- **O botão de aviso na tela de Notificações não aparece mais ligável para depois se desligar sozinho** Quem tem as notificações bloqueadas no próprio navegador via, por um instante,
  o botão de Push disponível — e ele se desabilitava sozinho logo em seguida. Um
  clique naquele intervalo não fazia nada, porque a resposta do navegador já
  estava dada.

  A tela passa a consultar o navegador antes de desenhar o botão, em vez de
  desenhá-lo primeiro e corrigir depois. Você não precisa fazer nada.

- **O agente descartava paráfrases** O corte de semelhança usado no atendimento era mais rígido do que o calibrado com medição:
  "posso trocar se não servir?" era jogado fora mesmo com a resposta escrita no seu material.
  Agora os três lugares que decidiam isso usam o mesmo valor.

- **O aviso de "publique seus horários" agora leva até onde se publica** Quem abria a Agenda numa instalação nova encontrava o aviso de que ainda não
  havia horários publicados — e nenhuma indicação de onde publicá-los. A tela
  sempre existiu, em Equipe › Atendimento, mas se anunciava como "status, carga e
  capacidade" e nada ali dizia "horários". Agora o aviso é um link direto para ela,
  já com a aba certa aberta, e a seção diz para que serve. Nada precisa ser
  reconfigurado: quem já publicou a jornada continua com ela.

- **O conhecimento cadastrado ia parar no assistente errado** Se a sua organização tem mais de um assistente, todo material cadastrado era preparado
  para o *primeiro* deles — sempre. O segundo assistente nunca aprendia nada, sem erro, sem
  aviso, sem nada na tela. E a tela de conhecimento só existia para o assistente que veio
  com a instalação: qualquer assistente criado por você era invisível ali.
  Depois de atualizar, o que cada assistente já lia continua valendo. Mas o material que
  você tinha cadastrado para um assistente que não é o da instalação nunca chegou a ser
  aprendido de verdade — ele aparece no acervo e precisa de um "Preparar de novo" para
  virar consulta. Vale conferir, em cada assistente, o que ele consulta.

- **Preparar um material derrubava o outro** Enquanto havia um único índice por assistente, a rotina de conversas e a de perguntas
  frequentes competiam: a que rodasse por último apagava o acervo da outra, em silêncio. Cada
  material passa a ter o índice dele.

- **A página do projeto passa a anunciar a versão certa sozinha** Quem chega pelo GitHub via a versão anterior anunciada como a mais recente,
  mesmo depois de a nova sair, porque só a etiqueta da versão era criada
  automaticamente e o anúncio na página dependia de alguém publicar à mão. Agora
  os dois saem juntos. Para quem já roda numa VPS nada muda: a atualização sempre
  usou a etiqueta, não o anúncio.

- **Segurança: qualquer pessoa da equipe podia apagar a base de conhecimento** As quatro tabelas do acervo aceitavam escrita de qualquer papel, inclusive o mais restrito,
  por fora das telas do produto. Agora exigem gerente ou administrador, como as telas sempre
  exigiram.

- **Sem chave, o material ficava parado para sempre e ninguém era avisado** Ele nascia como "pronto", nada acontecia, e cadastrar a chave depois não recuperava o que
  ficou para trás. Agora o material mostra **"Esperando a chave"**, um aviso abre na Central,
  a própria tela de conhecimento oferece cadastrar a chave ali mesmo — e a preparação recomeça
  sozinha quando ela chega. Nada do que você enviou é perdido.

- **Tipo de agendamento novo já nasce com um responsável** Quem criava um tipo de agendamento — "Call Estratégica", "Retorno de 15 minutos"
  — recebia de volta o aviso "sem responsável, não aparece para marcar", sem ter
  deixado de preencher nada: a tela é que criava o tipo sem dono. Agora ele nasce
  com quem está criando, e continua sendo possível escolher "Definir depois" de
  propósito. Nesse caso o aviso virou um atalho: clicar nele abre onde se define o
  responsável. O seletor também passou a mostrar o nome das pessoas em vez de um
  pedaço do identificador, e agora é possível remover o responsável depois de
  definido — o que a tela já oferecia e o sistema ignorava.

## [1.7.0] — 2026-08-27

### Adicionado

- **Agenda: marcar, remarcar e cancelar compromissos pela tela** O sistema ganhou uma Agenda. Dá para criar tipos de compromisso, ver a grade da
  semana, marcar um horário e remarcar ou cancelar pela própria tela, com o motivo
  registrado. A IA também consegue consultar os horários livres e marcar durante o
  atendimento, sem ninguém sair da conversa.

  Quem usa Google Agenda pode conectar a sua conta em Configurações, e os
  compromissos passam a aparecer nos dois lados. Isso é opcional: sem conectar, a
  Agenda funciona igual, e quem não mexer em nada não precisa fazer coisa alguma
  depois de atualizar.

### Corrigido

- **A versão só é publicada pelo caminho da release** Uma correção no nosso próprio processo de publicação, feita antes de causar
  problema: o sistema que cria a versão decidia apenas por haver um número novo
  escrito no histórico de mudanças. Bastava alguém escrever esse número junto de
  outra alteração para a versão sair sozinha, sem passar pela aprovação. Agora ele
  exige também a marca de que aquilo foi de fato um fechamento de versão.

- **A tela de atualização mostra tudo o que mudou desde a sua versão** Antes ela mostrava só o texto da versão mais nova. Quem pulava versões — por
  exemplo, quem estava na 1.4.0 e atualizava direto para a 1.6.0 — nunca via o que
  tinha mudado no meio do caminho, e isso incluía os avisos de coisas que exigiam
  a sua ação. Agora a tela lista todas as versões entre a sua e a nova, com os
  avisos reunidos no topo e cada um dizendo de que versão veio.

## [1.6.0] — 2026-08-26

### Adicionado

- **Formulários do Respondi entram como lead, com as respostas na ficha.** Antes, quem ligava
  um formulário do Respondi ao CRM recebia um erro e **nenhum lead era criado** — o webhook
  chegava com as respostas dentro de uma estrutura que o CRM não sabia ler, e a captação era
  recusada inteira. Agora o nome, o telefone, o e-mail e cada pergunta respondida chegam na
  ficha do contato, e o lead nasce no funil como qualquer outro. **Telefone sem código de
  país é lido como brasileiro** (`(11) 99999-8888` vira `+5511999998888`, a mesma regra que o
  WhatsApp já usava); número de fora do Brasil precisa vir com o `+` e o código do país.
- **Quem recusa contato no formulário aparece na linha do tempo.** Se a pessoa marcou que
  **não** aceita receber mensagens, isso vira um evento visível na ficha dela — em vez de a
  equipe descobrir o silêncio depois, sem saber por quê. Recusa é informação, não ausência
  de informação.
- **Todo lead que chega pelo formulário do Respondi já entra triado.** Cada envio é lido na
  hora e ganha, na ficha, uma classe (A, B, C ou D) calculada a partir da pontuação do próprio
  formulário — e, quando falta a pontuação, o valor honesto **"não avaliado"**, nunca uma
  classe chutada. Quem não tem telefone utilizável ou recusou o contato entra marcado como
  **desqualificado**, com o motivo. E o que **precisa de olho humano** — nome que parece spam,
  o mesmo telefone chegando com outro nome, ou um valor de investimento que contradiz o outro —
  fica sinalizado como **aguardando revisão**, sem travar nada: o lead entra no funil do mesmo
  jeito e continua elegível para o primeiro contato. Tudo isso aparece na linha do tempo da
  ficha, então dá para ver **por que** um lead foi parar onde foi parar.

### Corrigido

- **A IA avisa o cliente antes de chamar uma pessoa — antes ela saía de campo calada.**
  Quando o atendimento automático parava e a conversa ia para a fila humana, o cliente
  não recebia mensagem nenhuma: ele falava, e ninguém respondia. Acontecia nos dois
  caminhos que param a IA, e o pior deles era o silencioso — a IA tinha acabado de
  **perguntar o e-mail do cliente**, o sistema detectou insatisfação na mensagem dele e
  desligou o automático; o cliente respondeu a pergunta e ela caiu no vazio. Agora, em
  qualquer um dos caminhos, sai uma mensagem antes do silêncio, e ela é honesta com o
  estado da sua equipe: com gente disponível ela convida a aguardar; sem ninguém livre
  no momento, diz que o pedido ficou registrado; e numa instalação que ainda não
  configurou atendente nenhum, **não promete contato**. Quem pediu para **parar** de
  receber mensagens recebe a confirmação da parada, não uma oferta de atendente.
- **Quem vai assumir a conversa agora sabe se o cliente foi avisado.** O aviso na Central
  passou a dizer, em uma linha, se a pessoa do outro lado já sabe que alguém está vindo —
  é o que muda a primeira frase que o atendente digita.
- **Conversa parada por insatisfação detectada agora abre aviso na Central.** Esse caminho
  devolvia a conversa à fila e calava a IA sem avisar ninguém: o cliente sem resposta e a
  equipe sem sinal de que havia alguém esperando. Agora ele abre o mesmo aviso que os
  outros caminhos já abriam, e sem duplicar quando dois motivos disparam na mesma conversa.
- **O agente voltou a ouvir os áudios que chegam.** Quem mandava um áudio ouvia de volta
  "não consigo ouvir mensagens de voz" — e a transcrição ficava pronta no sistema meio
  minuto depois, sem ninguém para usá-la. A causa era de ritmo: as tarefas de bastidor
  (baixar o áudio, transcrever, tratar mídia) só eram acordadas uma vez por minuto, e a
  resposta ao cliente não espera tanto. Medido numa instalação real: a cadeia levava de
  103 a 188 segundos, e passou a levar 18. A transcrição em si sempre levou 4 segundos —
  o resto era fila. Nada para você fazer: vale assim que atualizar.
- **A caixa de conversas voltou a se atualizar sozinha — antes só recarregando a página.**
  A mensagem do cliente chegava, ficava guardada certinho, e a tela continuava parada: quem
  estava com a conversa aberta, olhando, não via nada até apertar F5. Valia também para o
  funil, o histórico do contato e as telas da IA. A causa veio de fora — uma peça de terceiros
  que o sistema usa mudou de comportamento numa atualização, e o aviso de "chegou coisa nova"
  passou a ser recusado em silêncio, sem erro em lugar nenhum. Agora a tela recebe de novo na
  hora, e ela também se recupera sozinha: se a conexão em tempo real cair, a lista e a
  conversa voltam a se sincronizar em pouco tempo em vez de ficar congeladas num passado que
  parece presente. Nada para você fazer — vale assim que atualizar.
- **A automação parou de dizer "Sucesso" para mensagem que ela nem tentou mandar.** Quando o
  envio era pulado — contato sem telefone, contato bloqueado, contato que recusou receber
  mensagens — a execução aparecia na aba Atividade como bem-sucedida. Pior que o defeito que a
  versão passada corrigiu: aquele pelo menos tinha tentado. Agora aparece como **Falhou**, com
  a razão.
- **Quem recusa receber mensagens no formulário para de receber automação.** A recusa já ficava
  visível na linha do tempo, mas nada no motor a lia — as automações de WhatsApp saíam do
  mesmo jeito. Agora a recusa fica registrada na ficha da pessoa e as duas ações de envio
  automático (mensagem escrita por você e mensagem escrita pela IA) a respeitam. Vale também
  quando a pessoa **já era seu contato** e mudou de ideia num envio novo. **Quem nunca
  respondeu à pergunta continua recebendo normalmente** — não perguntar não é a mesma coisa
  que ouvir "não".

### Alterado

**O Tailwind passou da versão 3 para a 4.** Para quem roda numa VPS, não muda nada:
nenhuma variável nova, nenhum passo manual, o `update.sh` segue igual. O que muda é a
aparência de algumas telas — e para melhor, na maioria dos casos:

- **Avisos e destaques que não apareciam passam a aparecer.** O jeito antigo de escrever
  "esta cor com 10% de opacidade" era descartado em silêncio quando a cor vinha do tema —
  então o fundo rosado do aviso de erro, a borda avermelhada do campo inválido e vários
  realces de seleção simplesmente não pintavam. São 62 marcações assim, em 252 lugares,
  que agora mostram o que sempre deveriam ter mostrado.
- **O respiro entre o rótulo e o campo do formulário foi mantido.** A nova versão mudou de
  que lado o espaço é aplicado, e isso colava o rótulo no campo em todo formulário do
  sistema. Corrigido antes de sair.

### Corrigido

- A lista de opções de um `<select>` nativo perdeu 2px de recuo interno. Efeito visual
  não confirmado — o menu é desenhado pelo sistema operacional, não pelo navegador.

## [1.5.0] — 2026-08-25

O histórico de quem chega pelos seus formulários agora existe — inclusive de quem **não**
entrou. As automações passam a poder responder com uma mensagem escrita pela IA a partir do
que a pessoa preencheu. E a automação parou de marcar "Sucesso" para mensagem que nunca
chegou ao cliente.

O Inbox passa a dizer **quem manda em cada conversa** — e o conserto principal não é de tela:
clicar "Assumir" não parava o atendimento automático, então os dois respondiam o mesmo cliente.

### ⚠️ Requer atenção

**O horário em que as automações mandam mensagem passa a ser o seu, e não o do servidor.**
A proteção de horário da automação era medida pelo relógio da máquina, que roda em UTC —
então a faixa "7h às 22h" era, na prática, **4h às 19h de Brasília**. Duas consequências
que você talvez tenha visto sem saber a causa: uma automação disparada às 19h30 não saía e
ficava esperando até as 4h da manhã seguinte; e uma disparada de madrugada saía, mandando
mensagem para o cliente às 5h. Agora vale o seu fuso, e **vale a faixa que você configurou
em Conexões › Proteção de envio** — a mesma que a IA já respeitava. Se você apertou ou
ampliou esse horário achando que só mexia com a IA, confira: agora ele também rege as
automações. Quem nunca mexeu fica com 7h às 22h no **horário de Brasília**. Se o seu negócio fica em outro
fuso, escolha o seu em **Conexões › Proteção de envio**, no campo "Fuso horário da janela" — e
confira conexão por conexão, porque essa escolha é de cada número, não da instalação inteira.

**Assumir uma conversa agora PARA o atendimento automático nela. Antes não parava, e os dois
respondiam o mesmo cliente.** Quem clicava "Assumir" no Inbox ganhava a conversa na tela, mas o
automático continuava respondendo por baixo — ele só ficava quieto por 5 minutos depois que o
atendente mandava uma mensagem, e voltava a falar sozinho em seguida. Agora assumir e transferir
silenciam o automático naquela conversa, e **"Liberar" ou "Fechar" desfazem o silêncio que a
pessoa pôs**. Há uma exceção que importa: quando foi o próprio automático que passou o caso
para uma pessoa, "Liberar" e "Fechar" **não** o trazem de volta — ali quem devolve é o botão
**"Devolver ao automático"**, no topo da conversa. É justamente o caso das conversas que
aparecem na aba "Fila" (veja o aviso abaixo). Se a sua
equipe se acostumou a assumir a conversa e deixar a IA responder junto, esse hábito muda aqui.

**A distribuição por rodízio NÃO cala o automático** — distribuir é escolher quem cuida se precisar,
não tomar a conversa. Só o clique de uma pessoa silencia.

**A aba "Fila" vai mostrar mais conversas do que mostrava, e o número do badge pode subir de uma
vez.** Não é conversa nova: são as que a IA já tinha passado para uma pessoa e que não apareciam em
aba nenhuma. Se o número saltar depois de atualizar, é isso — e vale olhar, porque são pessoas
esperando resposta há mais tempo do que você imaginava.

Esta versão **mexe no banco de dados**. O `update.sh` aplica sozinho; não há passo
manual — são tabelas e estados novos: o histórico de captação, o estado de espera das
automações e o registro de quem está no comando de cada conversa.

**Se você está vindo da 1.4.0, os dois avisos abaixo são da 1.4.1 e valem para você.** A tela de
atualização mostra só a seção da versão que você está instalando, então eles vão repetidos aqui
para não passarem em branco. Se você já atualizou para a 1.4.1, já os leu — pule.

- **A IA passa a atender aos domingos, e antes não atendia.** O padrão de fábrica da janela
  anti-banimento mudou na 1.4.0: domingo era dia mudo e passou a ser dia normal (a faixa de
  horário continua a mesma). Se o seu negócio depende de silêncio no domingo, desligue em
  **Conexões › Proteção de envio**, na chave "Enviar aos domingos", por canal. Quem já tinha
  mexido ali teve a escolha respeitada. **Novidade desta versão:** essa chave passou a valer
  também para as automações — desligá-la faz o lead que preencher seu formulário no domingo
  só ser abordado na segunda de manhã.
- **Duas conexões oficiais do WhatsApp com a mesma conta da Meta: fica com o identificador a
  conexão MAIS RECENTE**, e a mais antiga recebe o sufixo `-conflito-`. Nada foi apagado. A 1.4.0
  disse o contrário — se você apagou a conexão SEM o sufixo por causa daquela frase, era a que
  estava funcionando; reconecte o número em Conexões.

### Adicionado

- **"Leads recebidos", em Webhooks: quem chegou pelo formulário, com o que preencheu.**
  Até aqui, o formulário do seu site entregava o lead e não sobrava registro nenhum de como
  ele chegou. Agora há uma aba com a lista: nome, data e hora, de qual formulário veio, a
  página em que a pessoa estava, o endereço de internet dela e as etiquetas de campanha
  (`utm_source` e companhia). Clicando na linha, todos os campos do formulário como ela
  preencheu, e um atalho para o lead no funil. Dá para filtrar por busca, por origem, por
  resultado e por período.
  **E aparece também quem NÃO entrou.** Um formulário cujos campos o CRM não reconhece era
  recusado em silêncio: quem colou o endereço no site só sabia que "não chegou nada", sem
  ter onde olhar. Agora a tentativa aparece na lista como *Não entrou*, com o motivo escrito
  em português e os campos crus do jeito que vieram — que é o que permite consertar o
  formulário em vez de adivinhar.
- **Nas automações, no "então": "Mensagem escrita pela IA".**
  Antes só dava para mandar um texto pronto com `{{nome}}` e `{{telefone}}`. Se o seu
  formulário pergunta o segmento, o tamanho da equipe e a maior dificuldade de hoje, quem
  tem 3 funcionários e quem tem 300 recebiam a mesma frase. Agora você escolhe um agente já
  **publicado**, escolhe o número, e escreve no campo *"O que a IA deve fazer com esses
  dados"* — por exemplo, "cite a dificuldade que ela citou e ofereça uma conversa de 15
  minutos". A IA recebe as respostas do formulário e essa sua instrução, e sabe que é a
  primeira mensagem de alguém que acabou de preencher e não está esperando resposta. É o
  mesmo desenho da instrução de um passo de follow-up.
  Quem envia continua sendo a automação — com horário de envio, descadastro e espaçamento
  entre mensagens valendo igual. A IA escreve o texto; ela não fala com ninguém por conta
  própria.

### Corrigido

- **A automação dizia "Sucesso" para mensagem que não chegou ao cliente.** Era o relato que
  originou boa parte desta entrega: automação ligada, lead entrando pelo formulário, a aba
  Atividade mostrando um "Sucesso" verde — e nenhuma mensagem no celular de ninguém. A
  automação só sabia perguntar se tinha dado erro de programa; ela não olhava se a mensagem
  de fato saiu. Agora ela olha: quando o envio falha, o resultado aparece como falha, com o
  motivo em português ("Não conseguimos falar com o serviço de WhatsApp. Confira se ele está
  no ar."), e um aviso é aberto na **Central de avisos** — o menu "Alertas", dentro de IA › Acompanhar o
  agente — **nomeando a regra que falhou**,
  porque um erro que só existe numa aba que ninguém abre é um erro invisível.
- **A automação que estava só esperando o horário parecia não ter rodado.** Ao adiar um
  envio, ela não gravava nada: "não apareceu nada na Atividade" e "a automação não funcionou"
  eram a mesma tela. Agora a espera é um estado visível na aba Atividade — **Aguardando envio** —, com o motivo ao
  lado. Nem sempre é o relógio: o mesmo estado aparece quando o número de WhatsApp está
  desconectado, e aí o que resolve é reconectar em Conexões, não esperar.
- **O agente ficava mudo quando o provedor dele era diferente do provedor padrão da
  organização.** Quem publicou o agente numa IA (por exemplo OpenAI) enquanto a organização
  continuava configurada em outra (Anthropic) tinha TODA mensagem de WhatsApp engolida: a
  conversa ficava sem resposta, sem erro visível na tela do agente. Por baixo, um verificador
  interno saía com o endereço de uma IA e o nome de modelo da outra, tomava "modelo inexistente"
  e derrubava o atendimento inteiro antes de o agente falar. Não era preciso mexer em nada para
  cair nisso — bastava a combinação. O rastro sempre esteve em **IA › Execuções** e o aviso em
  **Central de avisos** ("Job descartado após esgotar tentativas"); o que faltava era o
  atendimento acontecer.
- **O papel Operador mandava o modelo escolhido para o provedor errado**, pela mesma razão, e
  o campo "Modelo do Operador" deixado em branco não fazia o que a tela prometia: ele diz *"A
  mesma que conversa"* e usava o modelo padrão da organização. Agora vazio herda de verdade o
  modelo do Conversador.
- **O painel de Provedores de IA mostrava o modelo errado** nos pontos que herdam do agente
  (classificador de etapa, detector de manipulação, verificador de promessa, resumo de
  conversa, checkpoint, sugestão de resposta e a mensagem escrita pela IA nas automações):
  anunciava o padrão da organização enquanto o sistema usava o do agente. A coluna passa a
  mostrar o que de fato roda, e diz de quem herdou. **A "Mensagem escrita pela IA" desta
  mesma versão caía no primeiro item desta lista** — nas instalações com agente num provedor
  diferente do padrão da organização, ela não sairia.

- **A promessa da 1.4.0 sobre o limite de gasto agora é verdade.** Aquela versão disse que, quando o
  limite para a IA, "as conversas que estavam sendo atendidas vão para a fila de atendimento
  humano". Elas iam — mas a fila na tela não as mostrava: a aba, o contador e o painel do gerente
  procuravam um estado e a conversa escalada ficava em outro. Quem confiou no aviso e foi olhar a
  fila não encontrou nada lá. Vale para toda passagem para humano, não só a do limite.
- **O número da fila que o cliente ouve e o que a equipe vê eram contados de formas diferentes.** O
  "você é o Nº da fila" enviado pelo WhatsApp incluía as conversas escaladas; o número mostrado ao
  atendente não. Agora é a mesma conta dos dois lados.
- **Dava para saber quem atende uma conversa pela IA, mas não pela tela.** O nome do atendente
  chegava ao agente e não ao Inbox, que só tinha o código interno. O cabeçalho e a lista passam a
  mostrar **quem está no comando** — pessoa (com nome e iniciais) ou automático —, e o selo diz o
  **motivo** quando o automático está parado: alguém assumiu, está pausado para aquele cliente, ou
  volta sozinho em instantes.
- **Faltava o botão de desligar.** Havia "Devolver ao automático" e nada para pausá-lo — ele só
  parava por conta própria. Agora o mesmo lugar tem os dois lados.
- **Assumir, transferir e liberar não apareciam no histórico da conversa.** Passavam sem deixar
  rastro no painel lateral; o motivo escrito ao transferir ficava só no registro de auditoria, que
  o atendente não abre. Agora as quatro ações viram linha na atividade, **com o nome de quem fez** —
  antes toda ação humana aparecia como "Você/time".
- **Conversa encerrada deixava de dizer quem a atendeu**, justamente na aba "Fechadas".
- **Numa instalação sem nenhuma IA configurada, a tela dizia "Automático atendendo".** Não havia
  automático nenhum: eram conversas sem ninguém.
- **Quem não enxerga uma conversa conseguia ler o histórico de quem a atendeu.** Com a visibilidade
  restrita por atendente, o registro de troca de responsável não respeitava esse limite.

## [1.4.1] — 2026-08-25

O primeiro acesso passa a **perguntar como você já usa o seu número**, em vez de supor que
todo mundo conecta lendo um código no celular. Instalar numa máquina que já tem o CRM no ar
deixou de derrubar a instalação existente. E a seção da 1.4.0 descreveu errado duas mudanças
que chegam a todo mundo — uma delas invertida: como a tela de atualização lê o texto congelado
na versão, o conserto do texto só alcança você pela publicação de uma versão nova, que é esta.

### Adicionado

- **O primeiro acesso pergunta como você já usa o seu número, em vez de supor.** Existe mais
  de um jeito de ter WhatsApp para empresa, e cada um conecta de um jeito — mas o passo do
  telefone só sabia um: ele mostrava o código para ler no celular e pronto. Quem tem conta
  oficial na Meta, ou contrata o WhatsApp por uma empresa parceira, passava por ali sem nunca
  ser perguntado; o número entrava cadastrado do jeito errado e a pessoa só descobria depois,
  em outra tela, com o funcionário já montado por cima. Agora o passo abre com a pergunta e
  três respostas: **ler um código com o celular** (que é como quase todo mundo faz e segue
  sendo o caminho mais curto), **conta oficial na Meta**, ou **provedor parceiro** — e cada
  uma leva ao formulário certo, ali mesmo, sem sair do passo a passo. Escolher errado não
  tranca nada: dá para voltar e trocar. E nada é criado enquanto você não escolhe — antes, o
  número era cadastrado como "por código" só de você chegar na tela.
- **Quem escolhe a conta oficial é avisado ANTES de ir buscar as credenciais.** Esse caminho
  precisa de duas configurações no servidor que a instalação não cria sozinha, e sem elas o
  número **envia mas nunca recebe** — sem erro em lugar nenhum, que é o pior jeito de falhar.
  A tela diz isso antes de você abrir o painel da Meta, e aponta o caminho que funciona hoje.

### ⚠️ Requer atenção

**A IA passa a atender aos domingos, e antes não atendia. A 1.4.0 fez essa mudança e não
avisou.** O padrão de fábrica da janela anti-banimento mudou: domingo era dia mudo e passou a
ser dia normal (a faixa de horário continua a mesma). Quem nunca mexeu nessa configuração —
que é a maioria — recebeu a mudança na atualização, sem escolher. Se o seu negócio depende de
silêncio no domingo, desligue em **Conexões › Proteção de envio › "Enviar aos domingos"**, por
canal. Se você já tinha mexido ali, a sua escolha foi respeitada e nada mudou.

**Se você tem duas conexões oficiais do WhatsApp com a mesma conta da Meta, a 1.4.0 disse o
contrário do que acontece — confira antes de apagar qualquer uma.** O texto dizia que a
atualização "mantém a mais antiga". É o inverso: **fica com o identificador a conexão MAIS
RECENTE** (criá-la exigiu provar posse da conta na tela), e é a **mais antiga** que recebe o
sufixo `-conflito-`. Nada foi apagado. A conexão com o identificador limpo é a que continua
recebendo; a marcada como conflito aparece como falha na verificação de saúde, e isso é
esperado. **Se você apagou a conexão sem o sufixo por causa daquela frase, é a que estava
funcionando** — reconecte o número pela tela de Conexões.

Fora isso, nada exige ação sua. Não há mudança de banco de dados nesta versão.

### Corrigido

- **Instalar numa VPS que já tem o CRM no ar não derruba mais a instalação existente.**
  O instalador confundia a instalação de outra pasta com ele mesmo sendo rodado de novo e
  subia por cima: o site seguia no ar, mas passando a usar o banco da pasta nova — e o
  primeiro sintoma era a senha "parar de funcionar". Agora ele para antes de tocar em
  nada, diz em que pasta está a instalação que já existe e ensina como atualizá-la. Isso
  vale em qualquer arranjo de servidor — inclusive nas VPS em que o painel da hospedagem
  (Hostinger, Coolify, Dokploy) é quem atende as portas, e nas pastas que já tinham
  concluído uma instalação antes, onde a checagem anterior se desligava sozinha.
- **`salir` sozinho não descadastrava.** A 1.4.0 anunciou que "`baja`, `salir` e
  `no quiero recibir` descadastram"; medido com a função real, `baja` e `no quiero recibir`
  funcionavam e `salir` não — a palavra estava fora da lista. `salir` é o `sair` em espanhol,
  que já estava lá desde sempre. Continua valendo só a palavra **sozinha**: "voy a salir
  ahora" tem três palavras e não bloqueia ninguém.
- **A importação de planilha assume Brasil, e isso não estava escrito em lugar nenhum.**
  Telefone sem código de país entra como brasileiro: `(11) 99999-8888` vira
  `+5511999998888` — a mesma regra que o WhatsApp já usava ao receber mensagem. Se a sua
  planilha tem números de fora do Brasil, escreva-os com o `+` e o código do país (`+351…`),
  que aí são respeitados como estão. O comportamento não mudou; o que faltava era a frase.
- **Um controle citado pelo nome errado.** A 1.4.0 mandava procurar "Parar a IA no limite" na
  tela de orçamento de IA. O rótulo real mostra o seu número: "Parar a IA ao chegar em
  US$ 50,00". Nada mudou na tela — mudou a descrição.

## [1.4.0] — 2026-08-24

Esta versão muda o primeiro acesso. Instalar deixou de ser "configurar uma IA" e passou a ser **montar um funcionário e vê-lo atender antes de terminar**: você diz como ele se chama, o jeito dele falar e as regras da casa, monta o quadro de clientes do **seu** ramo — não o de loja virtual que todo mundo ganhava igual — e, no último passo, conversa com ele como se fosse um cliente. Nada sai pelo WhatsApp; você só confere que ele funciona antes de confiar nele. Junto disso, seis causas diferentes que deixavam uma IA publicada **muda** foram medidas num servidor real e consertadas uma a uma; o sistema passou a ser usável no celular; e você pode pôr o seu nome, o seu logo e a sua cor em tudo — pela tela, sem linha de comando.

### ⚠️ Requer atenção

**Desta vez, rodar o `update.sh` UMA vez basta — a instrução da 1.3.0 não vale mais.** A
versão anterior pedia duas execuções porque a primeira deixava o processo que faz a IA
atender "solto": acompanhando o desenvolvimento em vez de ficar parado na sua versão, como o
resto do sistema. Isso acabou. A atualização agora fixa as três partes do sistema na mesma
versão de uma vez só, e se ainda assim alguma ficar solta — é o caso de quem está vindo de
uma versão anterior à 1.3.0 — o próprio sistema fecha essa ponta sozinho em até 5 minutos,
sem você fazer nada. Rodar duas vezes por hábito não estraga nada: a segunda vez responde
"você já está na versão mais recente" e não toca em nada.

**Antes de ligar a parada automática da IA, confira o número do seu limite.** Ele sempre foi
em dólar, e a tela dizia real (está explicado acima). Quem escreveu "50" pensando em reais
tem, na verdade, um limite de US$ 50 — cerca de cinco vezes maior do que imaginava. Seu
limite não foi alterado; o que mudou é a tela finalmente dizer a verdade. Como a parada
automática nasce desligada em todo mundo, dá tempo de olhar o número com calma antes de
armá-la.

Fora isso, nada exige ação sua. O arquivo de configuração criado na sua instalação continua
valendo como está: tudo que é novo nesta versão já vem com um valor padrão, e a própria
atualização acrescenta o que faltar. O banco de dados também passa a se limpar sozinho a
partir daqui, jogando fora registro técnico velho que ninguém lê — conversa, contato,
mensagem e histórico de atendimento não são tocados, e não há nada para você configurar.

**Se você tem DUAS conexões oficiais do WhatsApp com a mesma conta da Meta, uma delas vai
mudar de nome.** Era possível cadastrar a mesma conta duas vezes — numa agência com dois
clientes, ou num número que trocou de empresa — e, enquanto isso durou, as mensagens
recebidas eram descartadas em silêncio para as **duas**. A atualização mantém a mais antiga e
marca a outra como conflito, acrescentando `-conflito-` ao identificador dela. **Nada é
apagado**: se você encontrar uma conexão com esse nome, é essa a razão — confira qual das duas
deve continuar e apague a que sobra.

**Se você usou o botão "Configurar Catálogo" na tela de conhecimento, confira o que ficou
gravado.** Ele salvava o que você escrevia como se fosse uma pergunta e resposta, não um
catálogo — então o conteúdo está lá, mas na gaveta errada. Vale reabrir e refazer.

**Se o seu sistema ainda chama a sua empresa de "Minha Empresa", troque em Configurações.** A
instalação cria a empresa com esse nome provisório, e o primeiro acesso trazia esse texto já
escrito no campo — quem seguiu adiante sem apagar ficou com ele. Agora o campo vem vazio, mas
quem já passou por ali precisa corrigir à mão.

### Adicionado

- **Instalar deixou de ser "configurar um sistema": agora você monta um funcionário e o vê
  atender antes de terminar.** O passo a passo do primeiro acesso foi de 4 para 6 etapas e
  mudou de assunto. Ele abre mostrando o que a sua instalação já trouxe pronta — servidor e
  banco de pé, qual inteligência artificial foi contratada, se o WhatsApp está pronto para
  parear —, em vez de um formulário em branco. O antigo "Configurar IA" virou **"Treine seu
  funcionário"**: como ele se chama, o jeito dele falar e — o campo que faltava — as regras
  da casa (horário de atendimento, o que nunca prometer, como chamar o cliente). Ali mesmo a
  chave da inteligência artificial é testada de verdade: não "a chave foi aceita", que um
  provedor responde até com a conta zerada, mas uma resposta real, que é a única coisa que
  prova que há crédito. Se a instalação veio sem chave, o campo para colar a sua está nessa
  tela, um clique antes de o funcionário nascer com ela. Entrou o passo **"Onde ele
  organiza"**, que monta o quadro de clientes do **seu ramo**: uma clínica termina com "Quer
  agendar" e "Consulta marcada", em vez do quadro de loja virtual — "Carrinho abandonado",
  "Em separação", "Enviado" — que toda instalação ganhava igual, sem nunca ter sido
  perguntada em que ramo entrou. Você pode renomear, remover e acrescentar colunas antes de
  gravar. E entrou o passo **"Ver ele atender"**: você escreve como se fosse um cliente e lê
  a resposta dele antes de terminar, sem nada sair pelo WhatsApp e sem criar conversa nenhuma
  — antes, o último clique despejava você numa caixa de conversas vazia, depois de montar um
  funcionário que você nunca tinha visto fazer nada. O funcionário que nasce dali também é
  outro: deixou de ser um respondedor de perguntas e já vem sabendo mexer no CRM sozinho —
  procurar o cliente, anotar o que ele informou, criar a oportunidade no funil e mover o
  cliente de etapa —, apontado para o funil certo e sabendo dizer o que o seu negócio faz. E,
  no fim, em vez de te largar numa tela vazia, o sistema se apresenta: as seis partes
  principais, cada uma com uma frase sobre o que ela faz por você.
- **Ponha o seu nome, o seu logo e a sua cor no sistema — pela tela, sem linha de comando e
  sem reiniciar nada.** Em *Administração › Marca*, quem é dono da instalação troca o nome do
  sistema, escolhe a cor da marca e sobe o arquivo do logo (PNG ou JPG, até 512 KB). Salvou,
  recarregou: a barra lateral, os botões, o destaque que aparece ao redor do campo em que você
  está digitando, o título da aba e o ícone do navegador já estão repintados. Até esta versão,
  a única forma de trocar a marca era editar um arquivo no servidor por linha de comando e
  reiniciar o sistema inteiro — e quem editava o código para conseguir isso perdia a mudança
  na atualização seguinte, quase sempre sem perceber. A cor não é aplicada crua: o sistema
  deriva onze tons dela e mostra onde cada coisa vai pousar antes de você salvar; se a cor
  escolhida deixaria o texto do botão ilegível no tema escuro, ele anda os degraus necessários
  sozinho. Nada de escolher amarelo e descobrir depois que o botão ficou branco no branco. E
  cada empresa dentro da mesma instalação pode ter a própria marca, em *Configurações ›
  Marca*, sem depender de quem instalou o sistema: o que ela deixa em branco é herdado da
  instalação.
- **A sua marca sai da tela e alcança o resto do produto.** O ícone da aba do navegador (que
  simplesmente não existia — a aba ficava sem ícone nenhum), o nome que aparece no aplicativo
  autenticador de quem liga a verificação em duas etapas, o nome do remetente dos e-mails e,
  principalmente, os e-mails de confirmação de conta e de recuperação de senha — que até aqui
  chegavam ao seu cliente com o nome do nosso produto, no primeiro contato dele com o sistema.
  O instalador também passou a perguntar a cor da marca: antes ele perguntava só o nome e
  entregava o verde do nosso produto em toda tela e em todo e-mail de acesso, então quem
  instalava para um cliente entregava a marca dele pintada com a cor de outro. Uma ressalva
  que vale conhecer: os e-mails de acesso são lidos de fora do CRM, então trocar a cor pela
  tela depois **não** reescreve esses e-mails — é a resposta dada ao instalador que faz as
  duas pontas nascerem iguais. Uma exceção é deliberada: **o relatório de dados pessoais em
  PDF nunca leva a sua marca.** Ele nomeia a empresa que responde legalmente pelos dados,
  porque é um documento que atende a um direito do titular — pôr ali o nome de quem só
  hospeda inverteria quem responde pelo quê.
- **Dá para usar o sistema pelo celular.** A barra lateral fixa era a única navegação
  existente e nunca sumia: num celular comum ela empurrava o conteúdo para fora da tela, e não
  havia botão nenhum para escondê-la. Agora ela vira uma gaveta que abre pelo topo e fecha
  sozinha ao trocar de tela, e todo botão ganha um alvo de toque de dedo no celular, voltando
  ao tamanho compacto no computador, onde quem aciona é o mouse. Junto veio uma varredura por
  todo o sistema atrás do que empurrava a tela para o lado: os cabeçalhos das páginas, a lista
  de funis, a barra de seleção em massa do quadro de vendas, campos de busca de largura fixa,
  tabelas soltas e os rodapés de "Pular/Continuar" do cadastro inicial. E a página inteira
  nunca mais desliza de lado: quando algo é largo demais — uma tabela, o quadro de vendas —, é
  só aquela parte que rola, e o resto da tela fica parado.
- **A verificação em duas etapas virou escolha, e não uma porta trancada na primeira tela.**
  O botão "Começar a usar" entregava o dono da instalação num bloqueador de tela cheia
  pedindo um aplicativo autenticador — um passo extra que o próprio wizard nunca anunciou,
  bem na hora de finalmente ver o produto funcionando. Agora quem administra decide se ela é
  obrigatória, em Configurações › Segurança, e o padrão é não exigir. Quem já usa a
  verificação continua protegido exatamente como está.
- **O produto passou a falar a sua língua: "Pipeline" e "Kanban" saíram da tela.** Eram cinco
  nomes para a mesma coisa, e três apareciam juntos na mesma tela. Agora o menu tem **Funis**
  (onde você abre o funil) e **Etapas do funil** (onde você configura o que cada coluna
  significa). Nas telas do primeiro acesso, o mesmo: o passo do WhatsApp parou de mostrar
  códigos internos como "Sessão: org_f3d61bc0" e "Status: INIT", e o passo do time deixou de
  listar "viewer, agent, manager, admin" em inglês.
- **Dá para responder "em cima" de uma mensagem, e enviar o contato de alguém, como no
  WhatsApp.** Passe o mouse (ou toque, no celular) sobre a mensagem, escolha *Responder*, e
  ela aparece citada logo acima do campo de texto — com um × para desistir. O cliente recebe a
  sua resposta pendurada na mensagem original, do jeito que ele já conversa no WhatsApp.
  Funciona nas duas formas de conectar o número, e o botão aparece também no celular — antes
  de sair, ele só existia para quem tem mouse, ou seja, sumia justamente onde a maior parte do
  atendimento acontece. Trocar de conversa limpa a citação sozinho, para nenhuma frase sair
  citando a mensagem de outro cliente. E no "+" ao lado do campo de mensagem existe agora a
  opção *Contato*: escolha alguém da sua base ou digite nome e telefone na hora, e chega no
  WhatsApp do cliente como cartão de contato de verdade — ele salva ou chama a pessoa com um
  toque. Quando um cartão de contato chega para você, ele fica clicável dentro do CRM: um
  toque abre a conversa com aquela pessoa, criando o contato se ainda não existir. O telefone
  é conferido antes de sair, para o cartão não levar um número que não existe no WhatsApp (o
  caso clássico do nono dígito).
- **Importar contatos de uma planilha.** Botão *Importar* na tela de Contatos: você sobe um
  arquivo CSV — o que qualquer Excel ou Google Planilhas exporta — e ele entra com nome,
  telefone, e-mail, CPF, aniversário e etiquetas. Os títulos das colunas podem estar em
  português (`nome`, `telefone`, `celular`, `aniversário`, `etiquetas`), e o separador pode
  ser vírgula ou ponto-e-vírgula, que é o que o Excel em português usa. Cada linha tem
  desfecho próprio na tela: importada, já existia, ou recusada com o motivo escrito — uma
  linha errada não derruba a planilha inteira. Até 500 linhas por vez. Arquivo `.xlsx` é
  recusado com a instrução de exportar como CSV, em vez de importar pela metade.
- **De qual anúncio o contato veio.** Quando alguém chega pelo botão "Enviar mensagem" de um
  anúncio do Facebook ou do Instagram, o CRM guarda a campanha e o anúncio na ficha do
  contato, e o negócio nasce etiquetado como vindo de anúncio. É gravado no primeiro contato e
  nunca reescrito depois — o primeiro toque é o que conta. Compartilhar um post normal, sem
  impulsão, não é confundido com anúncio pago. Anúncios do Google ainda não são identificados.
- **O atendimento automático volta a funcionar no domingo.** Até agora a IA ficava calada o
  domingo inteiro, e quem escrevia no domingo só era respondido na segunda-feira. A regra
  existia para reduzir risco de bloqueio, mas o que protege disso é o ritmo de envio, não o
  dia da semana — o custo caía sobre o seu cliente, à toa. Agora o domingo é liberado por
  padrão. A janela da noite continua valendo (nada sai entre 22h e 7h) e, se você faz
  prospecção ativa e prefere não incomodar no fim de semana, dá para desligar o domingo em
  Conexões › **Proteção de envio**, número por número — a chave se chama "Enviar aos
  domingos".
- **O limite de gasto com IA passa a valer de verdade — e nasce desligado.** Até agora a tela
  de Uso de IA › Orçamento deixava você escrever um limite mensal, mas quem barrava a chamada
  olhava para outro lugar: nenhuma instalação estava protegida, e a tela dizia que estava.
  Agora o número que você digita é o número que decide. Para que ligar isso não corte o
  atendimento de ninguém por engano, a proteção **começa desligada em todo mundo** e só liga
  em três passos, na tela: *Só acompanhar* → *Me avisar* → *Parar a IA no limite*. Não dá para
  pular direto para a parada, e quando você a arma ela **só começa a valer 72 horas depois**
  (dá para renunciar a essa espera marcando a caixa). **Você não precisa fazer nada** — quem
  não abrir essa tela continua exatamente como está hoje.
- **Quando o limite para a IA, ninguém fica sem resposta.** As conversas que estavam sendo
  atendidas vão para a fila de atendimento humano, com um aviso na Central de avisos
  explicando o que aconteceu. Cada uma volta ao automático pelo botão "Devolver ao automático"
  no cabeçalho da conversa. Aumentar o limite evita paradas novas, mas não devolve sozinho as
  conversas que já pararam. E, antes de qualquer parada, um aviso na Central de avisos aparece
  quando o gasto passa do ponto que você escolheu — ele se apaga sozinho quando o gasto volta
  para baixo do limite ou o mês vira.
- **O banco de dados passou a se limpar sozinho, todo dia.** Três arquivos internos cresciam
  para sempre e nunca eram podados: o arquivo bruto de tudo o que o WhatsApp envia, a fila de
  tarefas da IA e o registro de auditoria. Numa instalação real, o arquivo do WhatsApp sozinho
  era **86% do banco inteiro** — 468 MB de um total de 545 MB, contra menos de 10 MB de
  mensagens, contatos e leads somados. E o plano gratuito do Supabase acaba em 500 MB, que é
  onde vive a maior parte de quem instala. Agora, a cada dia: o conteúdo pesado dos eventos do
  WhatsApp é esvaziado depois de 7 dias e a linha some depois de 90 (o resumo continua lá,
  para investigar problema antigo); a fila de tarefas já concluídas é apagada depois de 90
  dias; e a auditoria segue a validade definida no arquivo de configuração da sua instalação,
  com 5 anos de padrão e um piso de 90 dias que não dá para furar. Nada que ainda tem dono é
  tocado: tarefa esperando, tarefa rodando agora e tarefa que falhou e virou aviso na Central
  de avisos ficam onde estão. **Você não precisa configurar nada** — já vem ligado com esses
  valores.
- **O agente de atualização passa a fixar sozinho a versão que ficou solta**, em até 5
  minutos, sem você fazer nada — ele grava a versão que já está rodando. O que ele **nunca**
  faz é mexer numa configuração que você escreveu à mão: se você escolheu acompanhar um canal
  de propósito, ele respeita e só avisa.

  Se você veio da 1.3.0 e rodou o `update.sh` uma vez só, é ele que termina o serviço a partir
  desta versão — a instrução de "rodar duas vezes" deixa de ser necessária daqui em diante.
- **Da lista de Contatos direto para a conversa.** Na lista de Contatos e na ficha de cada
  pessoa há agora um botão que leva direto para a conversa dela no Inbox, sem precisar
  procurá-la na lista de conversas.
- **Dá para instalar numa VPS que já tem painel (CloudPanel e similares).** Antes, o
  instalador tentava subir o próprio servidor web nas portas 80 e 443, que já estavam
  ocupadas pelo painel, e a instalação parava ali. Agora existe um passo a passo oficial para
  esse caso, na documentação do projeto, em `docs/runbooks/cloudpanel.md` — contribuição de um
  usuário da comunidade.
- **Quem usa a OpenRouter parou de ter o próprio consumo creditado ao site de outra pessoa.**
  Uma versão anterior levava, fixo dentro do sistema, o endereço de um site de terceiro — e o
  consumo de todo mundo ficava atribuído a um lugar que não é seu. Isso saiu. Se você quiser
  aparecer com o seu próprio nome no painel da OpenRouter, há dois campos no arquivo de
  configuração da instalação (`OPENROUTER_APP_URL` e `OPENROUTER_APP_TITLE`), os dois
  opcionais e vazios por padrão: deixando em branco, nada é enviado junto com as chamadas.

### Corrigido

- **Seis causas diferentes deixavam uma IA publicada muda — e nenhuma aparecia como erro.** Medidas
  uma a uma num servidor real, com o dono dizendo "a IA não responde": em todas, a tela dizia "IA
  atendendo" e a mensagem não chegava.
- **Número de WhatsApp recém-conectado: a IA não respondia a ninguém.** Todo número novo entra com
  uma trava de segurança nos primeiros dias, para não ser banido — e a trava segurava também as
  RESPOSTAS a quem escrevia para você. O cliente mandava "Oi" e passavam horas. Agora ela segura só
  o que o sistema começa sozinho; responder quem escreveu nunca é retido, e as conversas paradas por
  essa causa voltam à fila sozinhas.
- **Uma regra de distribuição vazia sequestrava o atendimento inteiro.** Dá para ligar uma regra em
  dois cliques e não colocar ninguém nela — e aí toda conversa ia para um atendente genérico, sem as
  suas instruções, morrendo em silêncio enquanto o agente certo esperava do outro lado. Agora isso
  não tira a conversa de quem já atendia.
- **Quem escrevia depois das 22h nunca era respondido — nem no dia seguinte.** Fora da faixa em que
  o sistema pode enviar (7h às 22h), a resposta era perdida: o atendimento era dado como concluído e
  nada saía. Agora ela é adiada e entregue quando o horário abre. No mesmo caminho, o **horário de
  funcionamento que você configurava não era lido por ninguém** (medido: 8h às 18h, de segunda a
  sexta, com o agente respondendo às 21:55 de uma terça), e a **retomada de quem sumiu morria em 25
  minutos**, dando o contato como perdido antes das 23h. Agora a espera aguenta a noite inteira e a
  mensagem sai pela manhã.
- **A tela do agente anunciava uma coisa e o motor rodava outra.** O cartão mostrava a inteligência
  escolhida no dia da criação, não a publicada; a mesma tela dizia "Publicado" e "Rascunho" ao mesmo
  tempo, e a resposta tranquilizadora era a errada; e **arquivar um agente antigo não arquivava
  nada** — ele seguia recebendo conversas. Agora as telas mostram quem realmente atende.
- **O que você configurava no agente não chegava ao atendimento.** "Abri o agente e o prompt sumiu"
  era comum: um rascunho antigo vencia a versão publicada, e a tela deixava publicar texto vazio por
  cima do texto bom. O editor **cortava o fim das instruções coladas, sem avisar** — um agente
  atendeu clientes de verdade com as instruções cortadas no meio de uma frase. O **tamanho de
  histórico que você escolhia não valia** (a tela oferecia até 8.000 e o motor usava 1.000), e
  **nada limitava mensagens seguidas**: o funcionário disparava até 8 sem o cliente responder. Agora
  vale o que você configurou, e há um teto por atendimento (3 por padrão).
- **Quem instalou escolhendo a OpenRouter tinha um funcionário que morria em toda mensagem.** Ela é
  a primeira opção do instalador e estava quebrada em quatro pontos: a chave sumia; o agente do
  primeiro acesso nascia pedindo uma chave da Anthropic que você nunca teve; o botão de testar
  recusava justamente o provedor em uso; e o seletor de inteligência abria em branco, trocando o seu
  provedor no primeiro salvamento. Junto, **"sem saldo" aparecia como erro sem nome nem conserto** —
  a chave estava sem crédito e o dono caçou defeito por horas no sistema para um problema de fatura.
  Agora a tela nomeia falta de saldo ou de limite, e quando falta chave ou modelo o agente fica em
  **rascunho honesto** em vez de nascer com selo de "Publicado" e ficar mudo.
- **"Tem como parar a dor?" bloqueava o paciente para sempre — e quem respondia "BAJA" em espanhol
  continuava recebendo.** A regra que reconhece pedido de sair da lista caçava a palavra em qualquer
  posição da frase. Medido numa clínica em uso real: "tem como parar a dor?" e "posso sair antes das
  15h?" bloqueavam o contato, que sumia sem ninguém saber — e o mesmo erro deixava passar "não quero
  mais receber", que é pedido claro. Do outro lado, os modelos em espanhol terminam com "Respondé
  BAJA para no recibir más" e o CRM só entendia português e inglês: o caminho mais curto para uma
  denúncia de spam. Agora só bloqueia a palavra sozinha ou o pedido inequívoco, e `baja`, `salir` e
  `no quiero recibir` descadastram.
- **Tropeços do primeiro acesso.** O aceite de termos era obrigatório e apontava para duas páginas
  que não existiam; elas agora existem e nomeiam **quem instalou** como responsável pelos dados. O
  sistema chamava sua empresa de "Minha Empresa" até você recarregar a página. E a tela do WhatsApp
  mandava escanear "o código abaixo" quando **não havia código nenhum**, ou dizia "Preparando o
  código…" para sempre; agora o código aparece e cada situação responde "e agora?", com botão de
  tentar de novo.
- **A caixa de conversas contava história errada.** O contador de pendentes só subia — responder não
  abaixava nada — e uma conversa com **uma** mensagem nova podia mostrar 6. Agora responder zera,
  abrir marca como lida, e os contadores errados são recalculados na atualização. A coluna *Última
  atividade* dos Contatos ficava parada, e mensagens novas só apareciam recarregando a página —
  agora a tela se reconecta sozinha e recupera o que entrou nesse meio-tempo.
- **A conexão do WhatsApp não voltava sozinha depois de um reinício.** Reiniciar o servidor ou uma
  falta de memória deixava o número parado — nada entrava, nada saía — até alguém abrir Conexões e
  clicar em *Reconectar*, às vezes só no dia seguinte. Agora o sistema religa sozinho o número que
  apenas parou — mas não quando o WhatsApp recusou a conta nem quando o QR Code espera alguém com o
  celular na mão, porque aí insistir piora.
- **O WhatsApp ficou três dias fora do ar dizendo apenas "Não foi possível verificar a conexão".**
  Quando o WhatsApp recusa a credencial, nada entra e nada sai — mas o aviso era a mesma frase
  morna, em amarelo, de uma oscilação de rede. Foram três dias sem uma única mensagem, e o dono só
  descobriu ao tentar conectar um número novo. Agora credencial recusada abre aviso próprio, em
  vermelho, que diz o que fazer — e avisa que escanear o QR Code de novo **não** resolve. A causa
  daqueles três dias também foi consertada: **duas cópias da pasta de instalação na mesma máquina**
  trocavam as credenciais uma da outra; agora a atualização automática percebe isso e para antes de
  estragar. E os **avisos nomeavam o número errado** — o telefone era gravado no primeiro pareamento
  e nunca mais corrigido —, mandando o dono pegar o celular errado.
- **Seu número podia aparecer como conectado enquanto não entregava mais nada.** No caminho oficial
  do WhatsApp, bastava desconectar o aparelho do outro lado: o CRM seguia dizendo "conectado" e o
  atendimento morria calado. Agora a conferência pergunta se dá para enviar por aquele número AGORA
  — e "não consegui verificar" segue sendo tratado como não sei, nunca como queda.
- **O sistema parado gastava mais cota de banco de dados do que o plano gratuito permite.** Uma
  instalação sem nenhum contato e nenhuma conversa consumia **8,09 GB por mês contra uma cota de 5
  GB**, só porque o processo que faz a IA atender perguntava à fila quatro vezes por segundo se
  havia serviço. Agora ele pergunta quando falta pouco para a próxima tarefa vencer e dorme até lá,
  sem deixar o atendimento mais lento. No mesmo esforço: o WhatsApp parou de mandar avisos que o CRM
  já jogava fora, e as tarefas automáticas deixaram de registrar na auditoria quando não fizeram
  nada — num servidor real, **95% da auditoria** era rotina vazia, enterrando o que importa.
- **A versão publicada subia e morria em seguida, num ciclo sem fim.** Faltavam peças dentro do
  pacote pronto e o sistema não mostrava uma única tela — enquanto o painel do servidor dizia que
  estava tudo de pé, porque só conferia se ele atendia o telefone, não se havia alguém do outro
  lado. Agora cada versão é ligada e testada antes de ser publicada.
- **A atualização do banco podia falhar em silêncio e você nunca saber.** Partes de uma mudança não
  chegavam ao seu servidor, o erro era tratado como inofensivo e a tela dizia "atualização
  concluída". Agora, se falhar, você fica sabendo. O instalador também **acusava a sua chave quando
  o problema era a internet**, prendendo você num laço do qual não se saía digitando certo. E **quem
  tem Supabase próprio travava na primeira instalação**, tendo que editar arquivo à mão: agora
  existe um segundo endereço, **opcional**, só para a estrutura do banco — quem não preencher
  continua exatamente como está hoje.
- **Uma leva de correções que você não vai notar — e esse é o ponto.** Uma mensagem preparada de
  propósito podia congelar o sistema inteiro por segundos; agora é recusada na entrada. Falhas de
  segurança em programas de terceiros foram fechadas, e um diagnóstico interno que imprimia a chave
  do seu WhatsApp em texto puro agora mostra só um pedaço. Aviso do WhatsApp fora do formato
  esperado era descartado em silêncio, com a mensagem se perdendo enquanto o WhatsApp achava que
  tinha entregue. Telas apertadas ganharam espaço: a barra lateral não cobre mais a lista de
  conversas, no celular a lista e a conversa não brigam pelo mesmo pedaço de tela, e textos cortados
  sem jeito de ler o resto — eventos do contato, erros de integração, dados de LGPD — abrem por
  inteiro. PDFs da base de conhecimento perdiam os parágrafos e agora chegam como no original. E o
  logo, que demorava meio minuto para aparecer e **aparecia quebrado em toda instalação em Docker**,
  aparece na hora e no lugar.
- **⚠️ Requer atenção — o valor do orçamento de IA sempre foi em DÓLAR, e a tela dizia real.** Quem
  lia "R$ 50,00" tinha, na verdade, um limite de **US$ 50,00** — cerca de cinco vezes maior do que
  imaginava. Nada mudou no seu gasto nem no seu limite: mudou o que a tela confessa. O rótulo agora
  diz US$ nas telas de Uso de IA, Execuções, Evolução e nos painéis de administração. **Confira o
  número antes de ligar a parada automática**: se você escolheu "50" pensando em reais, o que está
  armado é cinco vezes isso.
- **O gasto exibido era o acumulado desde a instalação, não o do mês.** O contador nunca zerava, e
  com alguns meses de uso a tela comparava meses de gasto contra um limite mensal. Agora o número é
  o do mês corrente, e é o mesmo que decide se a IA para. Junto: o seletor "Ação ao atingir 100%"
  oferecia "Pausar" e "Desabilitar" sem que nada os distinguisse, e a escolha não tinha efeito
  nenhum — saiu da tela (quem quiser que a IA pare no limite usa "Parar a IA no limite"). E o alerta
  de "limite atingido" ficava aceso depois de o mês virar ou de você aumentar o limite; agora se
  apaga sozinho.

## [1.3.0] — 2026-08-13

Esta versão mexe em como o sistema **chega e se atualiza** no seu servidor. Em uso, três
coisas mudam para melhor: a instalação deixa de ter uma etapa que podia falhar por falta de
memória no meio (o servidor não compila mais nada — tudo vem pronto), fica bem mais rápida, e
o agente de IA passa a receber as correções de cada versão. A recomendação de servidor
**continua exatamente a mesma**: o que consome memória é operar o sistema no dia a dia — 7
serviços e cerca de 150 MB por número de WhatsApp conectado —, e isso não mudou nem um pouco.

### Corrigido

- **O agente de IA nunca recebia atualização.** O worker — o processo que faz o agente
  atender 24 horas por dia — era compilado dentro do seu servidor no dia da instalação, e
  nenhuma atualização o reconstruía. Na prática: você atualizava o CRM, o site mudava, e o
  agente continuava rodando exatamente o código do dia em que você instalou, para sempre.
  Correções e melhorias do agente não chegavam. Agora ele é uma imagem pronta, publicada
  junto com o resto, e o `update.sh` a traz como traz o app.
- **Duas instalações "na mesma versão" rodavam código diferente.** Uma instalação nova ficava
  apontada para o canal `latest`, que — apesar do nome — acompanha o desenvolvimento em
  andamento, não a última versão lançada. Quem instalou em semanas diferentes tinha software
  diferente, e não havia como dizer qual. Agora o instalador grava o **número da versão**
  (ex.: `1.2.1`), e é essa versão que fica no seu servidor até você decidir atualizar.
- **O CRM podia não subir por causa de um serviço externo fora do ar.** A configuração pedia
  ao Docker que verificasse o registro de imagens a cada subida; se ele não respondesse, o
  contêiner não subia — mesmo com a imagem já baixada no seu disco. Agora que o seu servidor
  fica numa versão fixa, essa verificação deixa de ser feita **na sua instalação** (quem
  acompanha um canal móvel continua com ela, que é onde ela serve para alguma coisa).
- **O agendador de tarefas dependia da internet para voltar.** A cada reinício ele baixava
  dois programas antes de começar. Sem internet no momento do reboot — justo quando a máquina
  está se recuperando de alguma coisa —, as tarefas automáticas não voltavam. Agora já vêm
  dentro da imagem.
- **A versão mostrada em `/api/v1/health` era sempre `0.1.0`**, em qualquer instalação. Agora
  é a versão de verdade.
- O WhatsApp (WAHA) e o serviço de limites deixaram de acompanhar automaticamente qualquer
  versão nova publicada por terceiros. Passam a mudar só quando nós testamos e lançamos.

### ⚠️ Requer atenção

**Se o seu servidor foi instalado antes desta versão, rode o `update.sh` DUAS vezes.**

> **As duas execuções são necessárias nesta versão.** O agente que corrige isso sozinho entrou
> **depois** da 1.3.0 (está em *Não lançado*) — se você está atualizando para a 1.3.0, ele não
> existe no que você vai instalar. Esta nota já disse o contrário, e a frase teria feito você
> esperar cinco minutos por algo que nunca ia acontecer.
Medido em ensaio numa VPS: a primeira execução traz o agente novo, mas deixa a versão dele
"solta" — acompanhando o canal em vez de ficar fixa, como o resto do sistema. Isso faria o
agente saltar sozinho para a versão seguinte num reinício futuro, enquanto o resto do
servidor continuaria onde está. A segunda execução fixa tudo na mesma versão.

Para saber em que pé você está, sem mexer em nada:

```bash
curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/diagnostico.sh | bash
```

Ele só lê e explica — não escreve, não reinicia, não atualiza. Se disser que está afetada,
o passo a passo (com como voltar atrás) está em `docs/runbooks/remediar-worker-congelado.md`.

Fora isso, nada exige ação sua. Um `.env` antigo continua funcionando: as configurações
novas têm valor padrão e o próprio `update.sh` as acrescenta.

## [1.2.1] — 2026-08-12

**Versão de segurança. Se você roda o DeskcommCRM numa VPS, atualize.**

Um usuário da comunidade auditou o código e mandou um relatório. Parte do que ele apontou já
tinha sido corrigida nas versões seguintes à que ele analisou — mas **seis** problemas estavam
de pé, e um deles deixava dados de uma empresa visíveis para outra. Todos foram corrigidos,
cada um com um teste automático que impede o problema de voltar.

### Corrigido

- **Uma empresa conseguia ler a base de conhecimento de outra, e escrever no histórico dela.**
  Duas funções internas aceitavam o identificador da empresa como se fosse confiável, sem
  conferir se quem pediu era mesmo de lá. O isolamento entre empresas estava de pé em todo o
  resto — o furo era só nessas duas portas, e elas agora conferem.
- **Quem tinha permissão de apenas visualizar conseguia mudar configurações importantes.** Um
  usuário "visualizador" podia reescrever as instruções do agente de IA (o texto que ele fala
  com o seu cliente), desligar o canal de WhatsApp, mexer no limite de gastos e apagar a chave
  do provedor de IA — bastava falar direto com o banco de dados, sem passar pelas telas. Agora
  essas mudanças exigem administrador, como as telas já exigiam.
- **A verificação em duas etapas do administrador valia só na tela.** Quem tinha a senha de um
  administrador, mas não o segundo fator, ficava barrado na interface e mesmo assim alcançava
  as funções sensíveis por fora dela — criar chave de API, convidar gente para a equipe, pedir
  exportação de dados. Agora o servidor confere o segundo fator em todas elas.
- **Link de login podia levar para um site estranho.** Um endereço preparado por terceiros
  fazia você digitar a senha no site certo e, logo depois de entrar, ser jogado para outro
  lugar — o momento em que se confia mais na próxima tela.
- **Envio de arquivo na conversa não conferia permissão.** Era a única ação de escrita da
  conversa sem essa checagem; um usuário "visualizador" podia enviar arquivos de até 50 MB.
- **Automação de webhook podia alcançar a rede interna do servidor.** A checagem olhava só o
  texto do endereço; um domínio preparado para apontar "para dentro" passava, e alcançava
  serviços internos e a área de credenciais do provedor de nuvem. Agora o endereço é resolvido
  de verdade antes de qualquer envio.

### ⚠️ Requer atenção

- **Administradores vão precisar entrar de novo, com o código do aplicativo.** Se você já tem a
  verificação em duas etapas cadastrada e está com a sessão aberta, as ações de administrador
  passam a pedir o segundo fator. Sair e entrar novamente resolve. Quem ainda **não** cadastrou
  o segundo fator não é afetado e continua conseguindo cadastrá-lo normalmente.
- **Usuários "visualizador" e "gerente" perdem a escrita em configuração de IA e canais.** Se
  alguém do seu time mexia nessas telas sem ser administrador, promova a pessoa a
  administrador antes de atualizar — ou ela vai encontrar as ações bloqueadas.
- **Nenhuma ação manual no banco é necessária.** O `update.sh` aplica tudo sozinho.

## [1.2.0] — 2026-08-11

A maior versão até aqui: **126 novidades e 205 correções** desde a 1.1.0 (contadas por commit).
Dois temas.

O primeiro é o **agente de IA deixar de ser um respondedor e virar parte da operação**: ele
ganha papéis separados, capacidades declaradas, um follow-up que não deixa conversa morrer no
silêncio, e um painel onde você escolhe qual inteligência atende cada parte do sistema.

O segundo é o **sistema parar de mentir quando algo dá errado**: falha de IA deixa rastro em
vez de sumir, botão que não controlava nada foi ligado (ou removido), e erro de rede diz onde
mexer em vez de mandar reiniciar o que nunca caiu.

### Adicionado

**O agente ganha papéis**

- **Três papéis em vez de um** — Conversador, Operador e Segurança. Quem fala não é quem
  executa, e o disparo de ação passou a ser imposto pelo sistema, não decidido pelo modelo.
  Efeito medido: a taxa de resposta em que dado interno vazava para o cliente (URL de sistema,
  UUID, jargão de CRM) caiu de **3 em 10 turnos para 1 em 10** — mesmos cenários, ferramentas
  executadas contra dados reais, controle calibrado contra a linha de base.
- **O agente publicado tem lugar próprio**, entre atendente e gerente: assume o lead, devolve
  para uma pessoa quando precisa, e a volta aparece na linha do tempo em vez de sumir.
- **Capacidades declaradas.** Você escolhe o que ele pode fazer, vê quantas vezes usou cada
  uma, e ele avisa quando falta uma capacidade em vez de falhar calado.
- **Roteador de intenção por número** — um WhatsApp só passa a atender vários assuntos — agora
  com escolha do modelo (e do provedor) que identifica a intenção.

**Follow-up: nenhuma conversa morre no silêncio**

- **O follow-up nasce sozinho** quando o negócio entra numa etapa do funil, ou quando o agente
  abre um caso pedindo ajuda — e morre quando o caso fecha.
- **Ramos nomeados no canvas:** cada regra é uma bolinha com nome, e publicar exige cobertura
  por ramo, dizendo qual ramo ficou descoberto.
- **Pausar, retomar, adiar e pular** um follow-up sem matá-lo.
- **Tempo adaptativo** — a IA escolhe o intervalo e a tela mostra qual foi, e se bateu no seu
  limite.
- **Dossiê do follow-up:** o que já foi tentado, com o que o motor realmente fez.
- O painel inteiro fala **português** — UUID saiu da tela.

**Escolher a sua IA**

- **Painel de Provedores** (Agente de IA → Provedores): a tela onde se vê e se escolhe qual
  inteligência atende **cada uma das 23 partes do sistema** que usam IA — conversar, classificar
  sentimento, indexar conhecimento, ouvir áudio. Antes disso a escolha existia só no `.env`.
- **OpenRouter completa** — uma chave só, com catálogo que se atualiza sozinho contra a origem
  (cerca de 400 modelos na sincronização de referência; o número acompanha o que eles publicam).
- **O instalador pergunta qual IA vai atender** (OpenRouter, Anthropic ou OpenAI) e valida a
  chave na hora, em vez de assumir uma e falhar semanas depois.
- **Catálogo de modelos atualizado** nos provedores — quem instala não escolhe mais entre
  modelos de duas gerações atrás, pagando mais caro por pior.

**Ver o que a IA fez**

- **Tela de Execuções** (Agente de IA → Execuções): o que a IA fez e, quando falhou, o que
  aconteceu e o que fazer a respeito.
- **Falha de IA deixa rastro.** Antes, um erro no meio do caminho sumia — o log mentia por
  omissão e a operação não tinha como saber que algo não rodou.

**A conversa vira CRM sozinha**

- **A conversa vira lead** sem alguém transcrever nada à mão.
- **A IA propõe o dado que o cliente disse** — telefone, e-mail, nome — e **não grava nada**:
  o dado espera numa fila até uma pessoa confirmar na tela.
- **Demandas viram entidade de primeira classe:** nascem no ponto de entrada, aparecem no painel
  de quem atende, e o Radar mostra as que estão **sem próximo passo** — o que corre risco de
  morrer sem resposta.
- **Escopo de funil do agente:** você marca em quais funis ele mexe, e ele só escreve nesses.

**Medir a operação**

- **Índice de Atrito** (Desempenho) — o sistema passa a medir o próprio propósito.
- **Abandono, repergunta e espera calada** — as perdas de que ninguém reclama, agora contadas.

**Atendimento**

- **Fila de leads por atendente, com rodízio.** A distribuição deixa de ser combinada por fora
  e vira porta na tela.
- **Colar imagem no composer com Ctrl+V.**
- **Declarar desde quando o número é usado** e poder pular o aquecimento — um número antigo
  não precisa ser tratado como recém-nascido.
- **Aviso de mensagem presa.** Uma tarefa automática detecta mensagem que ficou "enviando" e
  abre um aviso na Central, em vez de deixar o cliente sem resposta em silêncio.

### Corrigido

- **Duas partes do sistema respondiam à mesma mensagem do cliente.** Agora há um dono só.
- **"O WhatsApp está fora do ar" quando o serviço estava de pé.** Toda falha de rede caía na
  mesma frase, mandando reiniciar um container que nunca havia caído. Agora a mensagem
  distingue endereço errado de serviço parado e diz onde mexer.
- **Escolher OpenRouter ou OpenAI no instalador tornava a instalação impossível** — e, num
  segundo defeito, a escolha era decorativa: aceita na pergunta e ignorada depois.
- **O instalador perdia a chave que você tinha configurado à mão** no `.env`, e a segunda
  execução desfazia a entrevista já respondida.
- **O papel Operador escrevia no CRM depois de o humano assumir a conversa** — era o único
  turno sem a guarda.
- **A telemetria da IA voltou a dizer a verdade** (5 defeitos de uma unificação anterior), e a
  troca de modelo voltou a ser auditada — o registro era engolido em silêncio.
- **Duas mutações perdiam a auditoria caladas** por chave natural gravada em coluna `uuid`.
- **A aba "Minhas" mostrava tudo que o atendente já tinha fechado.**
- **O filtro por tag da tela não filtrava** — a rota ignorava o parâmetro.
- **O menu passava da dobra em telas de 900px** depois que as telas novas entraram.
- **O roteador recusava um número que existia**, com a mensagem "não encontrado nesta
  organização", quando na verdade a consulta é que havia falhado.
- **A tela de funis misturava organizações** do mesmo usuário.
- **Excluir um canal** apagava o roteador junto, sem avisar, e deixava a Meta ainda entregando
  mensagens. Reconectar dizia "conectado" com a linha ainda arquivada.
- **Erro ao publicar o agente no onboarding criava um agente novo a cada clique.**
- **O custo de IA sem agente dono sumia da auditoria** — as telas de consumo mostravam zero
  numa instalação com tráfego real e provedor pago.
- **Mover um lead pelo assistente** deixou de pular o que mover pela mão aciona.
- **Telefone descoberto depois estourava a restrição de unicidade** e a mensagem do cliente
  sumia.
- **O `update.sh` inventava gasto de IA** e podia pausar o agente de quem estava atualizando.
- **Uma migration anterior apagou três tipos de aviso da Central** — corrigido, e agora há um
  gate que compara.

### Segurança

- **8 de 25 funções internas do banco estavam executáveis pela chave pública** que vai para o
  navegador, incluindo uma que escreve recebendo a organização por parâmetro, sem checar se
  você pertence a ela. Todas fechadas, com uma varredura que reprova a próxima.
- **Desligar uma camada de proteção do agente era escrita de qualquer membro** da organização —
  agora exige papel de gestão.
- **Expressão regular vulnerável a ReDoS** na leitura do telefone dentro da conversa.
- **O limitador de requisições vazava uma chave por janela** em memória.
- **O Sentry da comunidade recebia sessão além de erro** — agora recebe só o relatório de erro,
  como o README sempre descreveu.

**⚠️ Requer atenção**

Esta versão traz **51 mudanças de banco** (migrations 0087 a 0148). O `update.sh` aplica tudo
sozinho e **faz backup antes** — você não precisa rodar nada à mão. Se a sua instalação está há
muito tempo sem atualizar, é normal a etapa do banco demorar mais e imprimir vários avisos de
"já existe": eles são esperados, e o script só destaca o que não for.

Se você instalou entre 30/07 e hoje, seu servidor já roda este código (a instalação acompanha a
`main`) — esta tag existe para que a atualização pela tela e o `update.sh` voltem a ter um alvo
publicado para comparar.

## [1.1.0] — 2026-07-30

### Adicionado

- **Atualização pela própria tela.** O dono da instalação vê a versão instalada no rodapé do menu
  e, quando há versão nova, atualiza com um clique — sem abrir terminal. A tela mostra o que muda,
  avisa quanto tempo o sistema fica fora do ar e faz uma cópia de segurança antes.

### Alterado

- **A atualização passa a instalar a última versão publicada, não o topo do código em
  desenvolvimento.** O `update.sh` recusa instalar uma versão anterior à que já está no servidor
  (voltar no tempo continua possível com `--force`) e grava a imagem escolhida no `.env` — assim um
  `docker compose up -d` rodado depois não traz o app de volta para a `latest`.

**⚠️ Requer atenção**

Quem já tem o CRM instalado precisa rodar `bash hostgator-setup-kit/update.sh` **duas vezes** pelo
terminal para ativar o botão. Não é engano: a primeira execução ainda é a do programa antigo, que
baixa o novo mas não sabe ligar o agente da tela; a segunda já roda o programa atualizado e liga.
Depois disso, nunca mais é preciso o terminal.

## [1.0.0] — 2026-07-27

Primeira versão marcada do DeskcommCRM. O projeto vinha sendo desenvolvido publicamente desde abril de 2026 sem tags; esta release estabelece o ponto a partir do qual toda mudança passa a ser versionada e descrita — porque quem hospeda o próprio sistema precisa saber o que muda antes de atualizar.

### Plataforma

- Multi-tenancy com RLS em toda tabela tenant-aware, resolvida por `fn_user_org_ids()`.
- RBAC de 4 papéis (`viewer` < `agent` < `manager` < `admin`), aplicado no servidor.
- Autenticação via Supabase Auth com MFA TOTP obrigatório para administradores.
- Log de auditoria append-only com retenção de 5 anos.
- Onboarding de organização e ciclo completo de convite de membros.

### Atendimento WhatsApp

- Inbox de 3 painéis em tempo real, com múltiplos números via WAHA.
- Mídia servida por Storage com URLs assinadas; transcrição de áudio.
- Proteção anti-banimento: ritmo com variação, teto por número, janela de horário, aquecimento gradual e variação de texto.
- Detecção de pedido de descadastro (STOP) no inbound, com bloqueio automático.

### CRM

- Funil kanban com indexação fracionária de posição.
- Vocabulário configurável por funil — o mesmo núcleo atende e-commerce, clínica, imobiliária, infoproduto e serviços.
- Customer 360, contatos, etiquetas e linha do tempo unificada.
- Integração com Nuvemshop para a vertical de e-commerce.

### Agentes de IA

- Agentes com RAG por organização (pgvector), análise de sentimento e controle de orçamento por organização.
- IA como responsável de primeira classe, sujeita às mesmas regras de governança de um humano.
- Handoff IA→humano auditado, entregando resumo contextual (não a conversa crua).
- Cadeia de 7 verificações antes de cada envio, em ordem fixa: descadastro, LGPD, anti-banimento, variação de texto, promessa determinística, promessa semântica e disclosure. Cada avaliação vira registro durável e auditável — inclusive as que barram o envio.
- Servidor MCP interno.

### Governança de atendimento

- Atribuição e transferência auditadas, fila com posição e roteamento automático.
- Escopo de visualização por papel, aplicado via RLS.
- Métricas por atendente.

### Automação

- Fontes de captação: endpoint público por organização que recebe leads de landing pages, formulários e ferramentas externas.
- Regras QUANDO/SE/ENTÃO, que nascem pausadas até revisão.
- Webhooks de saída com proteção contra SSRF.
- Nenhum trigger de banco faz HTTP: eventos vão para `event_log` e são drenados por rota agendada.

### LGPD

- Exportação e anonimização em cascata via workers, com anonimização preferida sobre exclusão.
- Consentimento auditado.

### Self-host

- `hostgator-setup-kit`: instalação completa (app + WAHA + banco) com um comando.
- `baseline.sql` idempotente e auto-curativo — atualização não quebra clone com dados legados.
- 8 scripts de operação: `install`, `update`, `backup`, `restore`, `reset-password`, `reset-mfa`, `healthcheck` e o assistente de instalação em IA.
- Imagem publicada em `ghcr.io/melgarafael/deskcommcrm` — a VPS não compila nada.

### Qualidade

- CI com dois portões obrigatórios: `verify` (typecheck, lint, testes unitários) e `invariants`.
- O portão `invariants` sobe um Postgres limpo, aplica o `baseline.sql` em modo install e update, e roda **364 testes de invariante** em 56 arquivos — incluindo o teste de isolamento entre organizações, que prova que um usuário de uma organização não enxerga nenhuma linha de outra.
- Suíte end-to-end em Playwright dirigindo o frontend.

### ⚠️ Requer atenção

- **Node 22 é obrigatório para desenvolvimento.** A suíte de invariantes instancia o cliente do Supabase, que exige o `WebSocket` global — nativo apenas a partir do Node 22. Isso não afeta quem apenas hospeda: a VPS roda a imagem pronta.

[Não lançado]: https://github.com/melgarafael/DeskcommCRM/compare/v1.75.0...HEAD
[1.75.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.74.0...v1.75.0
[1.74.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.73.0...v1.74.0
[1.73.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.72.0...v1.73.0
[1.72.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.71.0...v1.72.0
[1.71.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.70.0...v1.71.0
[1.70.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.69.0...v1.70.0
[1.69.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.68.0...v1.69.0
[1.68.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.67.0...v1.68.0
[1.67.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.66.1...v1.67.0
[1.66.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.66.0...v1.66.1
[1.66.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.65.0...v1.66.0
[1.65.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.64.1...v1.65.0
[1.64.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.64.0...v1.64.1
[1.64.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.6...v1.64.0
[1.63.6]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.5...v1.63.6
[1.63.5]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.4...v1.63.5
[1.63.4]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.3...v1.63.4
[1.63.3]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.2...v1.63.3
[1.63.2]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.1...v1.63.2
[1.63.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.63.0...v1.63.1
[1.63.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.62.0...v1.63.0
[1.62.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.61.0...v1.62.0
[1.61.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.60.0...v1.61.0
[1.60.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.59.0...v1.60.0
[1.59.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.58.1...v1.59.0
[1.58.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.58.0...v1.58.1
[1.58.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.57.0...v1.58.0
[1.57.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.56.1...v1.57.0
[1.56.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.56.0...v1.56.1
[1.56.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.55.0...v1.56.0
[1.55.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.54.0...v1.55.0
[1.54.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.53.0...v1.54.0
[1.53.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.52.0...v1.53.0
[1.52.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.51.0...v1.52.0
[1.51.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.50.0...v1.51.0
[1.50.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.49.0...v1.50.0
[1.49.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.48.0...v1.49.0
[1.48.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.47.0...v1.48.0
[1.47.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.46.0...v1.47.0
[1.46.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.45.0...v1.46.0
[1.45.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.44.0...v1.45.0
[1.44.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.43.0...v1.44.0
[1.43.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.42.0...v1.43.0
[1.42.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.41.0...v1.42.0
[1.41.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.40.0...v1.41.0
[1.40.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.39.0...v1.40.0
[1.39.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.38.0...v1.39.0
[1.38.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.37.0...v1.38.0
[1.37.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.36.0...v1.37.0
[1.36.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.35.1...v1.36.0
[1.35.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.35.0...v1.35.1
[1.35.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.34.0...v1.35.0
[1.34.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.33.0...v1.34.0
[1.33.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.32.1...v1.33.0
[1.32.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.32.0...v1.32.1
[1.32.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.31.1...v1.32.0
[1.31.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.31.0...v1.31.1
[1.31.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.30.0...v1.31.0
[1.30.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.29.0...v1.30.0
[1.29.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.28.0...v1.29.0
[1.28.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.27.3...v1.28.0
[1.27.3]: https://github.com/melgarafael/DeskcommCRM/compare/v1.27.2...v1.27.3
[1.27.2]: https://github.com/melgarafael/DeskcommCRM/compare/v1.27.1...v1.27.2
[1.27.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.27.0...v1.27.1
[1.27.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.26.0...v1.27.0
[1.26.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.25.1...v1.26.0
[1.25.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.25.0...v1.25.1
[1.25.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.18.1...v1.19.0
[1.18.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.18.0...v1.18.1
[1.18.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.16.1...v1.17.0
[1.16.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.16.0...v1.16.1
[1.16.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.15.1...v1.16.0
[1.15.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.15.0...v1.15.1
[1.15.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.11.0...v1.12.0
[1.11.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.10.2...v1.11.0
[1.10.2]: https://github.com/melgarafael/DeskcommCRM/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.6.0...v1.7.0
[1.5.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/melgarafael/DeskcommCRM/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/melgarafael/DeskcommCRM/releases/tag/v1.0.0

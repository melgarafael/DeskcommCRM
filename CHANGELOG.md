# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

Se você roda o DeskcommCRM numa VPS, **leia a seção da versão para a qual está atualizando antes de rodar `bash update.sh`**. Mudanças que exigem ação manual aparecem sob **⚠️ Requer atenção**.

## [Não lançado]

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

[Não lançado]: https://github.com/melgarafael/DeskcommCRM/compare/v1.50.0...HEAD
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

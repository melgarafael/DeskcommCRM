# Funcionalidades — Atendimento

O que há aqui: tela de conversa, agenda, radar e avisos que chegam a quem atende.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Atendimento → Agenda

- **Correção de horário sozinha** — Remarcar após aviso manda a correção dizendo que mudou, com espera de 2 min. _(desde 1.42.0)_
- **Agenda no fuso da empresa** — A semana abre no fuso da empresa para todo mundo, não no relógio local. _(desde 1.42.0)_
- **Compromisso sem Meet avisa** — Enviar compromisso presencial ou por telefone fala data, hora e fuso sem link. Onde: Atendimento → Agenda → enviar. _(desde 1.41.0)_
- **Reenviar link da reunião** — Botão vira Enviar de novo com pergunta; só destrava depois que saiu. Onde: Atendimento → Agenda → link. _(desde 1.41.0)_
- **Endereço e obs ao marcar** — Novo agendamento ganha endereço e observação que já iam ao calendário. Onde: Atendimento → Agenda → novo. _(desde 1.38.0)_
- **Cliente único no marcar** — Buscar e escolher viram um campo só, inclusive compromisso sem cliente. Onde: Atendimento → Agenda → novo. _(desde 1.38.0)_
- **Endereço vira lista** — Endereço filtra salas usadas e salva novo para os próximos horários. Onde: Atendimento → Agenda → novo. _(desde 1.38.0)_
- **Abrir dia na agenda** — Bloco abre dia fora da jornada em horas à escolha, com repetição semanal. Onde: Atendimento → Agenda → exceções. _(desde 1.34.0)_
- **Confirmar pedido na tela** — Aba e detalhe ganham Confirmar para decidir sem esperar o cliente. Onde: Atendimento → Agenda → confirmar. _(desde 1.26.0)_
- **Encaixe fora da grade** — Novo agendamento ganha Outro horário para a equipe marcar fora da régua. Onde: Atendimento → Agenda → Outro horário. _(desde 1.26.0)_
- **Reserva solta o horário** — Pedido sem decisão libera o horário no prazo, padrão 24 horas. Onde: Atendimento → Agenda → prazo. _(desde 1.23.0)_
- **Falta vira aviso** — Falta sem resposta após a régua abre aviso na Central por falta. Onde: Atendimento → Agenda → falta. _(desde 1.20.0)_
- **Meet com entrega** — Compromisso Meet cria link, mostra estado e envia com autorização própria. Onde: Atendimento → Agenda → Meet. _(desde 1.17.0)_
- **Agendas do Google** — Escolha agendas que ocupam, destino gravável e reconciliação com decisão. Onde: Atendimento → Agenda → Google. _(desde 1.17.0)_
- **Presença e falta na agenda** — Equipe registra comparecer, faltar e cancelar; Central cobra confirmação. Onde: Atendimento → Agenda → presença. _(desde 1.17.0)_
- **Convidado no compromisso** — Novo agendamento ganha campo de convidado com resposta no evento. Onde: Atendimento → Agenda → convidado. _(desde 1.15.0)_
- **Grade que aceita clique** — Clicar marca, arrastar remarca com confirmação e teclado funciona. Onde: Atendimento → Agenda → grade. _(desde 1.9.0)_
- **Agenda na tela** — Tipos, grade, marcar e remarcar com motivo; IA consulta e marca junto. _(desde 1.7.0)_

### Atendimento → Inbox
- **Documento mostra o nome original** — O cartão de documento recebido mostra o nome original do arquivo, e não só a extensão. Vale para documentos recebidos depois da atualização; os antigos seguem mostrando a extensão. Onde: Atendimento → Inbox → documento. _(desde 1.79.0)_
- **Toque em botão de modelo aparece na conversa** — A resposta de quem clica num botão do modelo (toque, respostas de botão e de lista) entra como texto com o nome do botão, e a IA passa a vê-lo. Onde: Atendimento → Inbox. _(desde 1.79.0)_
- **Largura das colunas do Inbox ajustável** — Arraste a divisória da lista de conversas e da ficha do contato em tablet e notebook; a escolha fica no navegador e o duplo clique volta ao padrão. Onde: Atendimento → Inbox → divisória. _(desde 1.78.0)_
- **Prévia do modelo aprovado com a janela fechada** — Na conversa com a janela de 24 horas fechada, escolher um modelo aprovado mostra cabeçalho, corpo, rodapé e botões, atualizados enquanto você preenche. Onde: Atendimento → Inbox → modelo. _(desde 1.78.0)_
- **Aviso de mensagem para quem cuida** — O aviso de mensagem recebida vai ao atendente e aos administradores; sem atendente mas com negócio aberto, ao dono e aos administradores; sem responsável, à equipe toda. _(desde 1.78.0)_

- **Selo do canal no inbox** — A lista e o cabeçalho mostram por qual canal cada conversa entrou, com o nome dado em Conexões. _(desde 1.77.0)_
- **Menção com @ na nota** — Digitar @ na nota interna lista atendentes e avisa só a pessoa escolhida. Onde: Atendimento → Inbox → nota interna. _(desde 1.76.0)_
- **Barra de abas no celular** — No celular, abas fixas levam a Inbox, Funis, Agenda, Desempenho e Mais; aviso vai para baixo. Onde: Atendimento → Inbox → barra no celular. _(desde 1.76.0)_
- **Videochamada na conversa** — O cabeçalho ganha botão de vídeo que cria sala Jitsi e envia o link. Onde: Atendimento → Inbox → botão Vídeo. _(desde 1.76.0)_
- **Texto do áudio no balão** — A transcrição aparece no balão da conversa, abaixo do player. (avisa Transcrevendo enquanto gera). _(desde 1.70.0)_
- **Caixa Acervo na conversa** — O painel ganha caixa para perguntar ao material da empresa, com trechos e gráfico. Onde: Atendimento → Inbox → painel Acervo. _(desde 1.62.0)_
- **Anexo dentro da nota interna** — A nota interna aceita imagem, documento, áudio ou vídeo só para o time. Onde: Atendimento → Inbox → nota interna. _(desde 1.62.0)_
- **Filtro por várias etiquetas** — Dá para filtrar por todas (E) ou qualquer uma (OU) no Inbox, Funil e Contatos. Onde: Atendimento → Inbox → filtro de etiqueta. _(desde 1.62.0)_
- **Busca dentro da conversa** — A lupa procura o termo nas mensagens da tela, marca bolhas e conta achados. Onde: Atendimento → Inbox → lupa. _(desde 1.56.0)_
- **Trocar etapa pela conversa** — O painel ganha seletor de etapa para avançar o negócio sem sair da conversa. Onde: Atendimento → Inbox → Etapa do funil. _(desde 1.53.0)_
- **Rascunho sugerido expira** — Rascunho de integração apagado 30 dias após vencer; prazo muda no .env. Onde: Atendimento → Inbox → rascunho. _(desde 1.53.0)_
- **Link direto da conversa** — O endereço inclui o id; quem tem acesso abre o mesmo atendimento pelo link. Onde: Atendimento → Inbox → link. _(desde 1.49.0)_
- **Editar e apagar mensagem** — Atendente edita ou apaga envio próprio; gestor oculta e restaura recebido. Onde: Atendimento → Inbox → menu da mensagem. _(desde 1.48.0)_
- **Localização vira mapa** — O lugar compartilhado chega em cartão que abre o ponto no mapa. Onde: Atendimento → Inbox → cartão de mapa. _(desde 1.48.0)_
- **Transferir por outro número** — O Transferir ganha aba Número para continuar no mesmo cliente em outro canal. Onde: Atendimento → Inbox → Transferir. _(desde 1.46.0)_
- **Enriquecimento na conversa** — O painel mostra site, segmento e redes coletados na prospecção com fonte. Onde: Atendimento → Inbox → painel. _(desde 1.41.0)_
- **Logo do canal na conversa** — Lista e cabeçalho mostram o logo da rede junto da identidade do contato. Onde: Atendimento → Inbox → logo. _(desde 1.41.0)_
- **Cartão de passagem no fio** — A conversa mostra porquê, tentativas e aviso com botão Assumir e responder. Na 1.79.0 o fio volta a rolar até o fim quando o cartão chega antes das mensagens, e o "Assumir e responder" volta a ficar à vista ao abrir a conversa. Onde: Atendimento → Inbox → cartão. _(desde 1.38.0)_
- **Contexto ao assumir** — Quem assume lê porquê e tentativas; aviso se fecha e repetido vira acréscimo. Onde: Atendimento → Inbox → cartão. _(desde 1.38.0)_
- **Botão Novo Lead** — Botão Lead vira Novo Lead; existente segue em Leads recentes. Onde: Atendimento → Inbox → Novo Lead. _(desde 1.31.0)_
- **Arquivar conversa da fila** — A conversa sai da fila para Arquivadas e volta sozinha se o cliente escrever. Onde: Atendimento → Inbox → Arquivar. _(desde 1.30.0)_
- **Ligar e atender no CRM** — Botão Chamar na ficha; recebida toca o time, cala a IA e conta no relatório. Onde: Atendimento → Inbox → Chamar. _(desde 1.19.0)_
- **Balão diz a origem** — Enviada mostra Celular, IA, Você ou Atendente em vez de só IA. Onde: Atendimento → Inbox → balão. _(desde 1.18.0)_
- **Demanda fora da conversa** — Fechar difere de concluir; painel registra resultado e reabrir cria demanda. Onde: Atendimento → Inbox → demanda. _(desde 1.17.0)_
- **Inbox legível e dobrável** — Busca em pílula, linhas fixas, grupos que recolhem e lembram estado. _(desde 1.14.0)_
- **Responder citando** — Resposta sai pendurada na original; Contato vira cartão clicável. Onde: Atendimento → Inbox → responder. _(desde 1.4.0)_
- **Colar imagem no chat** — Ctrl+V anexa a imagem direto no campo de resposta. Onde: Atendimento → Inbox → composer. _(desde 1.2.0)_
- **Inbox em três painéis** — Lista, conversa e dados ao vivo em vários números pelo WAHA. _(desde 1.0.0)_
- **Mídia com transcrição** — Arquivo abre por link temporário e áudio vira texto na conversa. Onde: Atendimento → Inbox → mídia. _(desde 1.0.0)_
- **STOP bloqueia sozinho** — Pedido de parar lido na entrada corta todo envio ao contato. Onde: Atendimento → Inbox → bloqueio. _(desde 1.0.0)_
- **Fila com posição** — Quem espera vê o lugar e o rodízio reparte sem combinar fora. Onde: Atendimento → Inbox → Fila. _(desde 1.0.0)_

### Atendimento → Radar

- **Demandas de primeira classe** — Nascem na entrada, aparecem no painel e o Radar cobra próximo passo. Onde: Atendimento → Radar → painel. _(desde 1.2.0)_

### Outros

- **Sistema no celular** — Barra vira gaveta e botão ganha alvo de dedo sem deslize lateral. _(desde 1.4.0)_

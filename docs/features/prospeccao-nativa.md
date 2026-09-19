# Prospecção nativa

Em **CRM → Prospecção**, um administrador configura a chave Apify, pesquisa empresas no Brasil por segmento/região e consulta dados comerciais. O adaptador usa o mesmo Actor Google Maps dos fluxos existentes. Não depende de n8n nem grava em Airtable.

A busca é paga pelo saldo da conta Apify: limite de até 100 empresas e teto de US$ 0,50 a US$ 10 por execução. A quantidade pode ser menor. O enriquecimento consulta e-mails comerciais e redes do site, sem buscar pessoas físicas ou decisores. Chave cifrada por `fn_encrypt_oauth`, indisponível aos papéis do navegador. Não existe chave obrigatória no `.env`.

## Campanha

Depois da pesquisa, defina agente, conexão, funil, etapa de entrada, etapa de qualificados, oferta, critérios, ritmo e referência real da avaliação de legítimo interesse. O agente precisa estar publicado, automático, com a ferramenta `crm_move_lead_stage` e acesso ao funil. Ele precisa atender o canal selecionado ou ser membro do roteador com continuidade ativa. O roteador pode encaminhar uma mudança de assunto para outro agente.

### Criar um agente sem sair da campanha

**Configurar por conversa** é o caminho principal de preparação da campanha.
**Usar agente existente** conserva a seleção e configuração manual.
Descreva o objetivo em suas palavras; a IA faz perguntas curtas sobre o que falta,
aproveita os dados da campanha e propõe nome, abordagem, critério de qualificação,
conexão e etapas. Você pode continuar conversando para corrigir o resumo.
Não é necessário escolher ferramentas ou escrever um prompt técnico.

A conversa usa a IA já configurada no CRM, pelo mesmo mecanismo de credenciais,
orçamento e registro de custo. Ela só propõe: não recebe ferramentas de escrita,
não cria agentes e não envia mensagens a contatos. IDs de conexão, funil e etapas
são conferidos contra os recursos reais da organização.

O resumo acompanha a conversa desde o início, mostra o que já foi definido e o que
ainda falta. Sugestões permitem responder com um clique. O progresso fica salvo
na campanha, separado da configuração que inicia a fila; duas abas não podem
sobrescrever uma à outra silenciosamente. Falha ao salvar aparece na tela.

**Testar como cliente** prepara um rascunho pausado e usa o mesmo sandbox do editor
de agentes. O teste não publica, não muda o roteamento e não envia mensagens a
contatos. Ferramentas de escrita são propostas, sem execução. Se a configuração
mudar, o teste anterior deixa de representar o novo rascunho.

O cartão de revisão mostra a abordagem, os critérios, o canal e o funil. **Publicar e usar agente**
é a confirmação que publica o agente, prepara as capacidades comerciais e de
transferência humana e o seleciona no formulário, com acesso ao funil escolhido.
Ele pode receber conversas no canal; a campanha continua aguardando o comando
separado **Iniciar abordagens com IA**. **Configurações avançadas** abre o editor existente.

Quando o canal usa um roteador, o agente é acrescentado sem substituir os outros.
Ativar a continuidade do mesmo agente, salvo mudança de assunto ou transferência,
exige uma escolha explícita no cartão de revisão; a IA não pode autorizar essa alteração.
Sem roteador, um canal atendido por outro agente exige reutilizar o agente atual
ou configurar o roteamento, evitando trocar o atendimento existente sem aviso.
Falhas mantêm a conversa e os dados da campanha. Repetir a mesma confirmação
recupera a criação anterior sem produzir outro agente. O histórico de configuração
é retomado ao recarregar a página; ele não é uma conversa de cliente no Inbox.
Cancelar uma resposta interrompe a espera e propaga o cancelamento à chamada de IA.
Isso não garante estorno de tokens que o provedor já tenha processado.

### Assistente de voz

O editor do agente oferece **Assistente de voz**, com configuração de ElevenLabs
Agents. A integração é opcional e usa a conta ElevenLabs da organização. A chave
fica cifrada no servidor; o navegador recebe somente uma autorização temporária
para o teste. Voz, idioma, primeira mensagem e instruções podem ser revisados.

O teste usa o microfone e o áudio do navegador. Ele não inicia chamadas para clientes
nem conecta automaticamente o assistente a chamadas WhatsApp. A configuração de
voz e a publicação do agente de texto são ações independentes. Alterações posteriores
no prompt de texto precisam ser revisadas e salvas também na configuração de voz.

A ativação cria contatos e negócios usando os handlers existentes. Telefones e identificadores de empresa são únicos por organização; contatos anteriores são preservados. Uma preparação interrompida deve ser retomada com a mesma configuração. A fila começa após um minuto e envia somente a primeira abordagem. Respostas passam pelo atendimento normal; a qualificação exige os critérios definidos pelo operador e só é contada quando a etapa do negócio muda. Encontrar uma empresa não significa qualificá-la.

Há uma campanha ativa por organização, até 50 tentativas em 24 horas no conjunto das campanhas, e intervalo mínimo de cinco minutos. Falhas e envios incertos consomem o limite. A janela do número, modo de teste, versão do agente, fechamento do atendimento, recusa, pausa e intervenção humana continuam ativos. Pausar interrompe novas abordagens; uma transmissão já iniciada pode concluir.

## Operação e recuperação

- Scheduler chama `/api/v1/cron/prospecting` a cada minuto, com segredo interno. Atualize a imagem do scheduler junto da aplicação. Em desenvolvimento, `pnpm dev:crons` inclui a mesma rota.
- Busca sem confirmação nunca é repetida automaticamente: confira as execuções da Apify antes de iniciar outra.
- Envio incerto não é reenviado automaticamente. O resultado e o link do Inbox ficam na campanha para revisão.
- Erro de envio pausa a campanha. Retome depois de corrigir o agente, conexão ou atendimento; candidatos que falharam permanecem em revisão.
- Novas extrações são iniciadas manualmente. Não há recarga automática de listas ou sequência de insistência para quem não respondeu.

## Sistema vivo

Entrada: administrador e pesquisa → `prospecting_campaigns/candidates`. Saída: `createContactHandler`, `createLeadHandler`, `sendMessageHandler` e turno do agente no Inbox. Comandos emitem `prospecting.changed`; cadastro e atendimento conservam as atividades canônicas. Resultados, erros e próximos envios aparecem em `/app/prospecting`, registrado no catálogo de navegação. A falha pausa a fila e exige revisão, e o resultado da conversa altera o estado exibido. A continuidade humana e IA usa o Inbox existente. Não responder não inicia novas insistências automaticamente; o operador revisa o histórico para decidir o próximo passo.

Mapa: `docs/architecture/prospeccao-nativa.architecture.json`.

### Checklist de continuidade: configuração e voz

- **Entrada e saída:** o administrador conversa em `ProspectingAgentBuilder`; a sessão
  pertence à campanha e prepara uma versão canônica em `ai_agents/ai_agent_versions`.
  `VoiceAssistantPanel` usa esse agente para configurar um agente privado na ElevenLabs.
- **Registro e superfície:** rotas de configuração usam a auditoria canônica; operações
  de voz registram `ai_agent.updated` ou `ai_agent.tested`, sem credenciais. Resumo,
  salvamento, resultado do teste e falhas aparecem nos respectivos painéis.
- **Acesso e configuração:** menu Prospecção → Configurar por conversa; menu Agentes →
  editor → Assistente de voz. O rascunho também oferece um link direto para essa aba.
  Chave ausente e falha ao listar vozes têm mensagens e ações próprias.
- **Recuperação:** revisão de sessão impede sobrescrita entre abas; tentativas mantêm
  o mesmo identificador e distinguem preparar de publicar. Criação remota incerta
  é reconciliada pelo marcador persistido antes de aceitar uma nova criação.
- **Continuidade humana:** o teste pausado não transfere contatos. A publicação prepara
  o handoff canônico do agente de texto. A voz neste incremento é uma sessão de teste
  no navegador, sem ferramentas, transferência ou chamada para clientes; não abre
  demanda no Inbox nem promete executar ações comerciais.
- **Retorno e mapa:** conflito exige recarregar o estado; erro de provedor permite
  corrigir e repetir a mesma tentativa. Divergência da configuração privada bloqueia
  o teste de voz até nova sincronização. As entradas e saídas constam no mapa acima.

### Anonimização e nova extração

A anonimização canônica do contato também limpa telefone, endereço, e-mails,
links e enriquecimento do candidato e o retira da fila. Tokens pseudônimos,
restritos ao servidor e nunca devolvidos pela API, impedem reimportar a mesma
origem ou telefone na organização. A exclusão de dados no provedor de busca
segue o processo próprio desse provedor.

O export de dados do contato inclui a origem, os dados coletados e o estado da
abordagem dos candidatos vinculados a ele, com o mesmo escopo da anonimização.
Não inclui tokens de supressão nem autorizações internas de envio.

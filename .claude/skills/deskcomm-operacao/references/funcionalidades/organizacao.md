# Funcionalidades — Organização

O que há aqui: conta, empresa, equipe, acesso, LGPD e conversões.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Organização → API Tokens

- **Teto de 50 tokens ativos** — Emissão para em 50 tokens por empresa; revogados e vencidos não contam. _(desde 1.50.0)_

### Organização → Automações

- **Freio do IA decide** — Um interruptor desliga de uma vez todo passo a IA decide das automações. _(desde 1.76.0)_

### Organização → Conversões

- **Etapa com evento que o canal não repassa vira pendência** — A pendência diz o que fazer (escolher um evento que o canal repassa, ou conectar a Meta direto), em vez de pedir uma conexão que a instalação não tem. Onde: Organização → Conversões → Histórico. _(desde 1.79.0)_
- **Venda de anúncio no pixel** — Venda de quem veio de anúncio Meta é reportada ao pixel com valor da conversa. _(desde 1.70.0)_
- **Etapa avisa a Meta** — Cada etapa do funil pode avisar a Meta, configurado em Conversões. _(desde 1.70.0)_
- **Venda pelo canal intermediado** — Com chave ligada, a venda sai para a Meta pelo canal da conversa. _(desde 1.60.0)_
- **Histórico das conversões** — Conversões ganha histórico de envios e diagnóstico de falhas e pendências. Onde: Organização → Conversões → Histórico. _(desde 1.56.0)_
- **Conversão do Google por etapa** — Cada etapa pode enviar sua ação ao Google Ads, com botão de criar na conta. _(desde 1.56.0)_
- **Links rastreáveis do site** — Links de WhatsApp por campanha com script do site e contagem de cliques. Onde: Organização → Conversões → Links. _(desde 1.56.0)_
- **Captura Google e qualificados** — Conversões configura WhatsApp dos cliques e etapa de qualificação sem valor. _(desde 1.52.0)_
- **Reprocessar conversões** — Dá para verificar e tentar de novo cada venda pendente, com Data Manager. _(desde 1.52.0)_
- **Rastreio de origem no site** — Script do site preserva identificadores e liga o clique ao contato. Onde: Organização → Conversões → Links. _(desde 1.52.0)_
- **Link com níveis do anúncio** — Código de origem aceita conjunto, anúncio e posição além da campanha. (tela Endereço de captura na 1.42.0). Onde: Organização → Conversões → Endereço de captura. _(desde 1.36.0)_
- **Envio ao Google Ads** — Botão conecta a conta e ganho reporta o valor como já fazia para a Meta. Onde: Organização → Conversões → Google. _(desde 1.35.0)_
- **Venda volta ao anúncio** — Ganho reporta valor à plataforma com token, pausa e lista de falhas. _(desde 1.15.0)_

### Organização → Dados externos

- **Coluna identifica cliente** — Na conexão de banco externo, você escolhe a coluna que identifica o cliente na conversa. _(desde 1.74.0)_
- **Banco externo na tela** — Cadastre e explore banco PostgreSQL de outro sistema, só leitura e cifrado. _(desde 1.41.0)_

### Organização → Distribuição de atendimento

- **Nome de quem fala no balão** — Dá para ligar o nome do atendente ou IA em negrito acima da mensagem enviada. _(desde 1.70.0)_
- **Espera após resposta no celular** — Cada empresa escolhe de 5 minutos a 24 horas quanto a IA espera após resposta manual. _(desde 1.70.0)_
- **Distribuição por menor carga** — O atendimento ganha o modo que distribui para quem tem menos carga. _(desde 1.70.0)_
- **Conversa fica com quem atendeu** — Opção faz quem responde virar responsável e calar a IA até devolverem. _(desde 1.47.0)_
- **Volta sozinha ao agente** — Prazo devolve conversa parada ao agente pelo caminho do botão Devolver. Onde: Organização → Distribuição de atendimento → devolver sozinho. _(desde 1.35.0)_
- **Responsável por número** — Atendimento escolhe responsáveis por número com fila e aviso ao vazio. Onde: Organização → Distribuição de atendimento → por número. _(desde 1.17.0)_
- **Fila com rodízio** — Distribuição vira porta na tela em vez de acerto por fora. Onde: Organização → Distribuição de atendimento → rodízio. _(desde 1.2.0)_
- **Dono e fila com registro** — Atribuir e transferir ficam gravados com quem fez e quando. _(desde 1.0.0)_
- **Visão por papel** — Cada papel enxerga só as conversas que lhe cabem, sem vazar. Onde: Organização → Distribuição de atendimento → visibilidade. _(desde 1.0.0)_

### Organização → Equipe

- **Papéis no idioma da interface** — A tela mostra Somente leitura, Atendente, Gerente e Administrador no lugar do código interno. Onde: Organização → Equipe. _(desde 1.79.0)_
- **Copiar horários úteis** — O editor copia as faixas de um dia para segunda a sexta e mostra o resumo salvo. Onde: Organização → Equipe → Atendimento. _(desde 1.76.0)_
- **Presença do atendente** — Aba aberta emite sinal a cada minuto; Equipe mostra selo e carimbo. Onde: Organização → Equipe → presença. _(desde 1.34.0)_
- **Convites com estado** — Membros mostra convites com status e ações de reenviar e revogar. Onde: Organização → Equipe → Convites. _(desde 1.20.0)_
- **Áreas por pessoa** — Admin escolhe interface por membro e atualiza sem fechar a tela. Onde: Organização → Equipe → interface. _(desde 1.17.0)_
- **Quatro papéis na equipe** — Leitor, atendente, gerente e admin com poderes cobrados no servidor. Onde: Organização → Equipe → papel. _(desde 1.0.0)_
- **Entrada e convite de membro** — Primeiro acesso monta a empresa; convite traz gente sem conta solta. Onde: Organização → Equipe → convites. _(desde 1.0.0)_

### Organização → Extensões

- **Guia de IA do dia a dia** — Um guia de IA orienta o uso diário do CRM pela interface. _(desde 1.70.0)_
- **Extensão abre mais telas** — Pacote pode pedir Tarefas, Conversas, Funil, Contatos, Agenda e Radar. Onde: Organização → Extensões → portas. _(desde 1.38.0)_
- **Guias instaláveis** — Instalação admite catálogo e cada empresa ativa guias sem rebuild. _(desde 1.32.0)_

### Organização → Financeiro

- **Editar sem recadastrar** — Contas, formas de pagamento, plano de contas, regras de comissão e lançamentos recorrentes ganham Editar, sem desativar e recadastrar. Editar regra de comissão deixa de dar erro; editar conta deixa de zerar o saldo inicial e de voltar a moeda para BRL. Lançamentos e comissões já gerados não mudam. Onde: Organização → Financeiro → Editar. _(desde 1.79.0)_
- **Financeiro com contas** — Tela guarda contas, formas de pagamento e plano de contas sem movimentar nada. _(desde 1.41.0)_
- **Contas todo mês** — Seção guarda molde de conta mensal que abre pendente no dia certo. Onde: Organização → Financeiro → Todo mês. _(desde 1.41.0)_
- **Regras de comissão** — Lista define percentual por pessoa, serviço ou ambos, valendo a específica. Onde: Organização → Financeiro → Comissão. _(desde 1.41.0)_

### Organização → LGPD
- **Arquivo de dados para o titular (Brasil)** — Quem pede acesso aos próprios dados recebe também o arquivo com todas as mensagens e sem as anotações da equipe (LGPD, art. 18, II). Na 1.79.0 o arquivo passa a ser montado em partes e usa cerca de um terço da memória de antes; o conteúdo é o mesmo, e se a leitura falhar no meio o arquivo avisa que pode estar incompleto. Onde: Organização → LGPD. _(desde 1.78.0)_

- **Relatório cita o país** — Acesso cita a lei do país; sem revisão não cita nenhuma e conta feriado local. (alíneas do art. 15 para Portugal na 1.74.0). Onde: Organização → LGPD → relatório. _(desde 1.35.0)_
- **Esquecer e exportar** — Pedido apaga em cascata por worker; anonimizar vale mais que excluir. _(desde 1.0.0)_

### Organização → Marca

- **Cor da marca no tema escuro** — Campo opcional ao lado da cor principal, como o logo já tinha. Vazio, nada muda; preenchido, só o tema escuro usa essa cor (e-mails e tema claro seguem na principal). Na 1.79.0 o número do contraste no modo escuro passa a medir essa cor — é o do botão que aparece na tela. Onde: Organização → Marca e Administração → Marca → "Cor da marca no tema escuro". _(desde 1.79.0)_
- **Dica em português de Portugal** — Em Portugal a dica da tela Marca manda conferir a "Denominação social" e fala de RGPD; no Brasil o texto não muda. _(desde 1.79.0)_
- **Logo grande é ajustado** — Logo acima de 512 KB é recortado e reduzido no navegador antes de enviar. _(desde 1.51.0)_

### Organização → Notificações

- **Avisos chegam no celular** — Três avisos passam ao push com CRM fechado; precisa do par VAPID no .env. Onde: Organização → Notificações → push. _(desde 1.57.0)_
- **Som próprio por aviso** — Dá para trocar o som de etapa que avisa e de pedido de pessoa, MP3 ou WAV. Onde: Organização → Notificações → sons. _(desde 1.57.0)_
- **Aviso com aba fechada** — Navegador avisa na bandeja com VAPID no .env; sem chave segue igual. Onde: Organização → Notificações → push. _(desde 1.8.0)_

### Organização → Organização
- **Alíneas do art. 15.º pela tela** — Para organização fora do Brasil, o cartão em Configurações › Empresa preenche as alíneas a), c) e d) que o relatório de acesso imprime. Onde: Organização → Organização. _(desde 1.78.0)_

- **Portugal como país** — O seletor de país oferece Portugal, com NIF, telefone +351 e prazos do RGPD. _(desde 1.70.0)_
- **Retenção de mídia cumprida** — Arquivos vencidos e órfãos saem do armazenamento todo dia; padrão 365 dias. (interruptor na 1.74.0; anexos de nota desde 1.76.0). Onde: Organização → Organização → retenção de mídia. _(desde 1.53.0)_
- **Menu por empresa** — A empresa escolhe o recorte do menu; a pessoa só escolhe menos que isso. Onde: Organização → Organização → Menu lateral. _(desde 1.42.0)_
- **Lisboa nos fusos** — Lisboa entra nas listas de fuso; padrão continua São Paulo sem mudar ninguém. Onde: Organização → Organização → fuso. _(desde 1.41.0)_
- **Zona de perigo** — Apaga dados da empresa digitando o nome, com auditoria e sem refazer config. Onde: Organização → Organização → perigo. _(desde 1.15.0)_
- **Moeda da empresa** — Organização ganha campo Moeda que vale para produto novo e importado. (kwanza e Luanda na 1.35.0; euro na 1.42.0). Onde: Organização → Organização → moeda. _(desde 1.14.0)_

### Organização → Perfil

- **Sistema em espanhol** — PT/ES no topo, na instalação e no perfil; datas acompanham o idioma. Na 1.79.0 a tela de erro fatal passa a aparecer em espanhol (tratando por "tú") para quem usa o navegador em espanhol; em português nada muda. Onde: Organização → Perfil → idioma. _(desde 1.10.0)_

### Organização → Recursos opcionais

- **Tela de recursos opcionais** — Um lugar lista tudo que liga e desliga, o estado e o botão Ajustar de cada um. Na 1.79.0 cada linha passa a mostrar o caminho completo de onde o recurso aparece (e diz quando não cria menu); empresa com o menu enxuto passa a ver a entrada do recurso ligado. _(desde 1.62.0)_

### Organização → Segurança

- **Segundo fator por papel** — Dá para exigir segundo fator por nível de papel, com carência de 0 a 30 dias. _(desde 1.70.0)_
- **Segundo fator opcional** — Admin decide em Segurança; padrão não exige de ninguém novo. _(desde 1.4.0)_
- **Login com segundo fator** — Entrar com senha e código do aplicativo para quem administra. _(desde 1.0.0)_

### Organização → Tags

- **Tela de etiquetas** — Tags ganham lista com alcance, renomear, juntar e excluir em transação. (cores na 1.39.0). _(desde 1.31.0)_

### Organização → Tipos de agendamento

- **Agenda da equipe opcional** — Dá para limitar atendente à agenda dos compromissos dele; padrão mantém tudo. _(desde 1.41.0)_
- **Texto próprio no lembrete** — Cada tipo ganha mensagem com nome, título, dia, hora e endereço.  Onde: Organização → Tipos de agendamento → lembrete. _(desde 1.38.0)_
- **Clientes pela agenda** — Regra etiqueta como cliente quem tem horário e marca data e funil. Onde: Organização → Tipos de agendamento → clientes. _(desde 1.28.0)_
- **Lembrete mais de uma vez** — Tipo ganha E de novo com até três avisos adicionais. Onde: Organização → Tipos de agendamento → lembrete. _(desde 1.25.0)_
- **Fechar dia na agenda** — Dá para fechar o dia em Configurações sem falso compromisso. Onde: Organização → Tipos de agendamento → fechar dia. _(desde 1.22.0)_
- **Lembrete do compromisso** — Tipo ganha aviso com minutos e lista mostra quem está ligado. Na 1.79.0 o lembrete não é mais dado como enviado quando o canal não pode entregá-lo: fora da janela de 24h ele tenta outro canal e, se nenhum pode, tenta de novo na próxima rodada. Onde: Organização → Tipos de agendamento → aviso. _(desde 1.18.0)_

### Outros

- **Tela de atualização aponta log** — Abaixo do resumo de disputa, a tela aponta o arquivo .update.log no servidor. _(desde 1.63.0)_
- **Botão Atualizar no topo** — O Atualizar agora sobe para antes da lista O que muda na tela. _(desde 1.45.0)_
- **Disputa contada na tela** — Atualização conta passadas de banco e aponta o .update.log quando há disputa. _(desde 1.35.0)_
- **Atualizar pela tela** — Dono vê versão no rodapé e atualiza com backup e tempo avisado. _(desde 1.1.0)_

### Tela de entrada (fora do menu)

- **Mostrar senha e força** — Login e cadastro deixam mostrar a senha; o cadastro mostra a força sem mudar regras. _(desde 1.62.0)_
- **Logo até 80 px na entrada** — O logo da marca nas telas de acesso respeita o arquivo até 80 px de altura. _(desde 1.61.0)_
- **Entrar com Google** — Botão entra ou cria conta, respeita convite, bloqueio e segundo fator. _(desde 1.42.0)_
- **Acesso entende o navegador** — Login e cadastro sem conta usam o idioma do navegador antes do padrão. _(desde 1.30.0)_
- **Marca com símbolo** — Sem marca própria, menu e login mostram logotipo em vez de texto. _(desde 1.19.0)_
- **Conta sem empresa termina** — Quem confirmou e-mail sem empresa cai em tela que conclui o cadastro. _(desde 1.14.0)_

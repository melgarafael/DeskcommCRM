# Funcionalidades — CRM

O que há aqui: funil, contatos, empresas, tarefas, campanhas, produtos, propostas e chamadas.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### CRM → Campanhas

- **Campos do negócio na campanha** — A mensagem aceita campos do negócio e do contato; sem dado, a pessoa sai da lista. _(desde 1.74.0)_
- **Campanhas com ritmo** — Fale com um recorte no ritmo do número, com prévia, teste, pausa e prova de base. _(desde 1.43.0)_

### CRM → Chamadas

- **Telefonia SIP com IA** — Módulo liga voz por tronco SIP com IA, transcrição e tela de Chamadas. (credenciais do tronco em Organização → Trunk SIP) Onde: CRM → Chamadas → histórico. _(desde 1.41.0)_

### CRM → Comandas

- **Comandas vira módulo** — A tela só aparece se o módulo `financeiro` estiver ligado; instalação anterior a esta versão continua com Comandas ligada, instalação nova liga em Administração → Módulos. O caixa (contas, lançamentos, Faturamento) continua com ou sem o módulo, e os dados ficam como estão. Onde: CRM → Hub "Ver tudo em CRM" → Comandas (pré-requisito: Administração → Módulos → financeiro). _(desde 1.79.0)_
- **Comanda com comissão** — Fechar comanda marca venda, comissão, entrada, ponto e conclui agendamento. _(desde 1.41.0)_
- **Faturar atendimentos soltos** — Lista mostra o feito e não cobrado; marque, pague e fature de uma vez. Onde: CRM → Comandas → sem comanda. _(desde 1.41.0)_
- **Fidelidade com saldo** — Saldo aparece na comanda; API devolve saldo e extrato; erro se corrige ao contrário. Onde: CRM → Comandas → pontos. _(desde 1.41.0)_
- **Tela de comandas** — Comandas abre, lança item, finaliza na forma e estorna com motivo. _(desde 1.41.0)_

### CRM → Contatos

- **Carteira do cliente (vendedor dono)** — O cliente pode ter um vendedor dono: o dono é avisado por tarefa quando o cliente escreve numa conversa que está com outro vendedor, e o negócio novo desse cliente nasce com ele. Por enquanto a carteira é definida pela API (gerente ou acima); o cartão na ficha do contato vem depois. Cliente sem carteira segue o rodízio de hoje. Onde: API `PATCH /api/v1/contacts/[id]/carteira`; o efeito aparece em CRM → Tarefas (aviso ao dono) e CRM → Funis (negócio nasce com o dono). _(desde 1.79.0)_
- **Escolha do número ao iniciar** — Com mais de um número, iniciar conversa pelos contatos pergunta por qual número sai. Onde: CRM → Contatos → Iniciar conversa. _(desde 1.77.0)_
- **Contato pessoal com toque** — Dá para marcar contato como pessoal e tirá-lo do inbox, funil, IA e envios. _(desde 1.75.0)_
- **Data de nascimento no contato** — Ficha ganha o campo; o agente propõe a data ouvida para alguém confirmar. Onde: CRM → Contatos → ficha. _(desde 1.50.0)_
- **Desbloquear contato** — Administrador desfaz o bloqueio com confirmação e registro em auditoria. Onde: CRM → Contatos → Desbloquear. _(desde 1.48.0)_
- **Origem completa na ficha** — Linha Origem mostra fonte e níveis de campanha, conjunto, anúncio e posição. (nomes de campanha, conjunto e anúncio na 1.42.0). Onde: CRM → Contatos → ficha origem. _(desde 1.36.0)_
- **Contatos filtram anúncio** — Origens de anúncio entram na lista de filtros em dois idiomas. Onde: CRM → Contatos → filtro. _(desde 1.29.0)_
- **Juntar duplicados** — Botão Duplicados compara lado a lado e junta sem perder histórico nem recriar. Onde: CRM → Contatos → Duplicados. _(desde 1.15.0)_
- **Campos do nicho no contato** — Campos do funil aparecem no Editar contato e saem na anonimização. Onde: CRM → Contatos → Editar. _(desde 1.14.0)_
- **Recusa vira evento** — Não aceitar mensagens aparece na linha do tempo em vez de silêncio. Onde: CRM → Contatos → ficha. _(desde 1.6.0)_
- **Importar contatos CSV** — Botão sobe CSV com relatório por linha e até 500 por vez. Onde: CRM → Contatos → Importar. _(desde 1.4.0)_
- **Origem do anúncio guardada** — Ficha guarda campanha e negócio nasce etiquetado no primeiro toque. Onde: CRM → Contatos → origem. _(desde 1.4.0)_
- **Contato abre conversa** — Lista e ficha ganham botão que leva direto ao Inbox sem procurar. Onde: CRM → Contatos → conversa. _(desde 1.4.0)_
- **Dado proposto espera** — Telefone, e-mail e nome aguardam confirmação humana sem gravar. Onde: CRM → Contatos → proposta. _(desde 1.2.0)_
- **Ficha 360 com timeline** — Contato, etiquetas e história unida numa ficha só. Onde: CRM → Contatos → ficha. _(desde 1.0.0)_
- **Aceite guardado em ata** — Consentimento fica registrado com prova de quando e como. Onde: CRM → Contatos → aceite. _(desde 1.0.0)_

### CRM → Empresas

- **CNPJ e gestão de empresas** — Botão Consultar CNPJ, edição e exclusão de empresa na tela, com auditoria. _(desde 1.72.0)_
- **Módulo de venda para empresas** — Chave liga Empresas, Pessoas que decidem e importação de planilha no CRM. _(desde 1.61.0)_

### CRM → Etapas do funil

- **Quem pula o funil no onboarding liga três etapas** — Quem pula o passo do funil no onboarding já sai com Aguardando pagamento, Pago e Cancelado ligadas ao assistente, como no pacote "Loja". Empresas que já pularam ficam como estão; ligue em Configurações › Funis. _(desde 1.79.0)_
- **Ganhar negócio abre comanda** — Por funil, dá para ligar a abertura automática de comanda com valor e contato ao ganhar. _(desde 1.77.0)_
- **Tempo parado na etapa** — A tela de etapas mostra há quanto tempo cada negócio está na etapa agora. _(desde 1.73.0)_
- **Taxa de ganho sugere chance** — A coluna mostra histórico de ganho e sugere a probabilidade; aceitar é manual. _(desde 1.71.0)_
- **Janela de esfriando editável** — A janela de esfriando de cada etapa vira campo editável na tela de etapas. _(desde 1.70.0)_
- **Etapa avisa a Central** — Cada etapa pode abrir aviso na Central quando um negócio entra nela. _(desde 1.57.0)_
- **Campos exigidos e motivo de ganho** — Etapa pode exigir campos; motivo de ganho vira campo próprio e sai no webhook. _(desde 1.53.0)_
- **Perdas por motivo e categoria** — Motivos ganham categoria; quadro filtra e Métricas ganha relatório de Perdas. Onde: CRM → Etapas do funil → motivos (+ Perdas em Desempenho). _(desde 1.53.0)_
- **Chance e previsão do funil** — Etapa ganha chance de 0 a 100; Métricas ganha Previsão ponderada por mês e moeda. Onde: CRM → Etapas do funil → chance (+ Previsão em Desempenho). _(desde 1.53.0)_
- **IA escreve campos do funil** — Agente grava nos até 50 campos com autor e linha do tempo. Onde: CRM → Etapas do funil → campos. _(desde 1.18.0)_
- **Vocabulário por funil** — Cada funil fala a língua do nicho sem trocar o sistema. _(desde 1.0.0)_

### CRM → Funis

- **Ficha mostra pessoas do negócio** — A ficha lista as outras pessoas ligadas ao negócio, com papel de cada uma. Onde: CRM → Funis → ficha do negócio. _(desde 1.72.0)_
- **Abrir conversa no funil** — Card e dossiê ganham botão que abre ou reabre a conversa e leva à Inbox. _(desde 1.71.0)_
- **Aviso de negócio duplicado** — Criar negócio para contato com outro aberto no funil avisa com link, sem bloquear. Onde: CRM → Funis → novo negócio. _(desde 1.71.0)_
- **PARAR fecha o negócio** — Quem responde PARAR tem o negócio aberto fechado com o motivo registrado. _(desde 1.70.0)_
- **Renomear etapa no quadro** — Gerente renomeia a etapa no cabeçalho da coluna sem ir às Configurações. Onde: CRM → Funis → cabeçalho da etapa. _(desde 1.54.0)_
- **Perdido vira negócio novo** — Por funil, negócio encerrado que volta pode nascer como lead novo ligado ao antigo. Onde: CRM → Funis → reabertura. _(desde 1.53.0)_
- **Contato no card do funil** — Card mostra telefone, e-mail e links; painel ganha seção Contato com abas. Onde: CRM → Funis → card. _(desde 1.41.0)_
- **Funil arquivado volta** — Gaveta mostra arquivados para tirar do arquivo ou excluir com regra. Onde: CRM → Funis → arquivados. _(desde 1.39.0)_
- **Filtro vê tags da conversa** — Filtro do funil passa a achar marcador da conversa além do negócio e contato. Onde: CRM → Funis → filtro. _(desde 1.37.0)_
- **Novo Lead com contato** — O diálogo ganha campo Contato com busca, criação e título automático. Onde: CRM → Funis → Novo Lead. _(desde 1.29.0)_
- **Seleção em lote no funil** — Caixa por card e por etapa com Shift, barra de ações e troca de responsável. Onde: CRM → Funis → seleção. _(desde 1.15.0)_
- **Importar leads da planilha** — Botão importa CSV para a primeira etapa com relatório por linha. Onde: CRM → Funis → Importar planilha. _(desde 1.14.0)_
- **Agenda move o lead sozinha** — Marcar ou confirmar move para a etapa do slug sem arrastar. Onde: CRM → Funis → slugs. _(desde 1.11.0)_
- **Lead do Respondi triado** — Cada envio ganha classe, desqualificado e revisão sem travar a entrada. Onde: CRM → Funis → triagem. _(desde 1.6.0)_
- **Funis em português** — Menu tem Funis e Etapas do funil; onboarding sem código interno. _(desde 1.4.0)_
- **Conversa vira lead** — Mensagem abre negócio sem transcrição manual de ninguém. Onde: CRM → Funis → entrada. _(desde 1.2.0)_
- **Funil com ordem própria** — Quadro guarda a posição fracionada sem embaralhar no arrasto. Onde: CRM → Funis → quadro. _(desde 1.0.0)_

### CRM → Hub "Ver tudo em CRM"

- **Hub Ver tudo em CRM** — Visão geral lista as cinco; menu fica com Funis, Contatos e Tarefas. _(desde 1.15.0)_

### CRM → Planos de tarefa

- **Planos de tarefa** — Sequência de tarefas montada uma vez e aplicada a cada negócio por automação. _(desde 1.77.0)_

### CRM → Produtos

- **Editar produto no catálogo** — A tela Produtos ganha botão Editar; item de integração abre só leitura. _(desde 1.73.0)_
- **Foto no produto e na resposta** — Produto ganha até 5 fotos com capa; a IA manda a foto com o texto. Onde: CRM → Produtos → Fotos. _(desde 1.45.0)_
- **Catálogo próprio com preço** — Tela Produtos cadastra e importa planilha; IA responde preço exato. _(desde 1.12.0)_

### CRM → Propostas

- **Propostas comerciais com IA** — Tela nova: briefing com o cliente, rascunho revisado, modelos e PDF no WhatsApp. _(desde 1.60.0)_

### CRM → Prospecção

- **Escolha da fila na prospecção** — O operador escolhe quais empresas entram na fila antes de iniciar abordagens. _(desde 1.70.0)_
- **Ritmo da prospecção pausada** — Dá para ajustar o ritmo de campanha de prospecção pausada. _(desde 1.70.0)_
- **Fila pausada editável** — Na prospecção pausada dá para mexer na fila e excluir desmarcadas. _(desde 1.70.0)_
- **Empresa entra ao ser abordada** — A empresa pode entrar no funil só quando for abordada; novas campanhas nascem assim. _(desde 1.70.0)_
- **Agente criado conversando** — Descreva a oferta em conversa e a IA prepara oferta, funil e publicação. Onde: CRM → Prospecção → criar agente. _(desde 1.41.0)_
- **Prospecção com IA** — Pesquise empresas, enriqueça e prepare campanhas com teto de gasto por busca. _(desde 1.41.0)_

### CRM → Tarefas

- **Tarefas com prazo** — Tela guarda combinados com prazo, calendário e vínculo com negócio. _(desde 1.15.0)_

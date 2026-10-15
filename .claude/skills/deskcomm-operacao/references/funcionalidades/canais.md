# Funcionalidades — Canais

O que há aqui: conexões, Webhooks, integrações e proteções de envio.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Canais → Conexões

- **Agendar pausa** — A janela de manutenção pausa e retoma sozinha: escolha início, fim e uma conexão ou todas; a mensagem que chega durante a janela é guardada e volta à fila na retomada. Janelas podem ser listadas e canceladas; ainda não dá para editar uma. Onde: Canais → Conexões → Agendar pausa. _(desde 1.79.0)_
- **Modelos com parâmetros nomeados voltam a enviar** — Templates oficiais do WhatsApp com parâmetros nomeados (parameter_format NAMED) voltam a ser enviados pelo Inbox e pela API sem o erro meta_100, sem reconfigurar nada. Onde: Canais → Conexões → Modelos. _(desde 1.79.0)_
- **Pausar e retomar todas** — A Central de Conexões ganha pausa em lote de todos os números com contagem. _(desde 1.75.0)_
- **Desvincular perfil social** — Dá para excluir canais órfãos e desvincular o perfil para trocar de conta. Onde: Canais → Conexões → Redes sociais. _(desde 1.75.0)_
- **Botão pausar canal** — Cada número ganha Pausar e Retomar; pausado não entra na inbox nem envia nada. _(desde 1.74.0)_
- **Rede social sai do atendimento** — Cada conta ganha Remover do atendimento e Desconectar, com confirmação. Onde: Canais → Conexões → Redes sociais. _(desde 1.74.0)_
- **Agenda do celular vira contato** — Contato criado no app WhatsApp em coexistência nasce no CRM com o nome. Onde: Canais → Conexões → API oficial. _(desde 1.72.0)_
- **Tempo de pensar por número** — Cada número ganha quatro campos de tempo de pensar do agente antes de responder. Onde: Canais → Conexões → Proteção de envio. _(desde 1.67.0)_
- **Janelas de resposta e disparo** — Cada número ganha janela de resposta separada da janela de disparo em massa. Onde: Canais → Conexões → Proteção de envio. _(desde 1.66.0)_
- **Grupos de clientes no chat** — Grupos do número entram no chat com etiqueta, fila própria e sem resposta da IA. Onde: Canais → Conexões → Grupos. _(desde 1.61.0)_
- **Modelos Graph editáveis** — Modelos do canal Graph ganham Editar e Apagar por variante de idioma. Onde: Canais → Conexões → Modelos. _(desde 1.54.0)_
- **Modelos editáveis com prévia** — Modelos do intermediado ganham Editar, Apagar e prévia como no WhatsApp. Onde: Canais → Conexões → Modelos. _(desde 1.53.0)_
- **Respostas do app no CRM** — Mensagens do WhatsApp Business em coexistência entram como resposta humana. Onde: Canais → Conexões → API oficial. _(desde 1.49.0)_
- **Link do modelo sem enviar** — Modelo com mídia ganha campo de link salvo direto, sem precisar disparar. Onde: Canais → Conexões → Templates da Meta. _(desde 1.46.0)_
- **Modelos do Datafy na tela** — Aba do Datafy ganha Modelos para sincronizar e criar aprovados. Onde: Canais → Conexões → Modelos. _(desde 1.44.0)_
- **Canal oficial via Datafy** — Conecte número oficial com token; liga com DATAFY_ENABLED no .env. _(desde 1.43.0)_
- **Dados para integrar** — Painel Para integrar mostra endpoint, IDs e onde obter o token. Onde: Canais → Conexões → Para integrar. _(desde 1.42.0)_
- **Etiqueta de canal oficial** — Número oficial aparece com etiqueta API oficial ao lado do nome. _(desde 1.42.0)_
- **Redes sociais nativas** — Conexões ganha Redes sociais com Instagram e Facebook no Inbox e IA pausada. Onde: Canais → Conexões → Redes sociais. _(desde 1.41.0)_
- **Webhook oficial sozinho** — Conectar inscreve o webhook na Meta com estado, motivo e tentar de novo. Onde: Canais → Conexões → oficial. _(desde 1.36.0)_
- **Parear por código** — Escolha QR ou código digitado no celular; gerar não derruba sessão ativa. Onde: Canais → Conexões → parear. _(desde 1.36.0)_
- **Voz no WhatsApp com aviso** — Pareia segundo aparelho com aceite de risco; desligar desconecta de verdade. (botão Chamar no cabeçalho desde 1.48.0). Onde: Canais → Conexões → voz. _(desde 1.19.0)_
- **Modo de teste do canal** — Canais nascem em teste com lista de confiança; abrir exige confirmação. (aviso após 3 dias sem autorizado na 1.39.0). Onde: Canais → Conexões → teste. _(desde 1.16.0)_
- **IA só em origem autorizada** — Por canal, a IA cala por padrão e só assume conversa de origem elegível. Onde: Canais → Conexões → IA autorizada. _(desde 1.14.0)_
- **Oficial avisa antes** — Tela diz das configs do servidor antes de buscar credencial na Meta. Onde: Canais → Conexões → oficial. _(desde 1.4.1)_
- **Domingo com IA** — Domingo libera por padrão; desliga por número em Proteção de envio. Onde: Canais → Conexões → Proteção. _(desde 1.4.0)_
- **Desde quando o número** — Declara a idade do número e pula o aquecimento de antigo. Onde: Canais → Conexões → Proteção. _(desde 1.2.0)_
- **Proteção anti-banimento** — Ritmo, teto, janela, aquecimento e variação guardam o número. Onde: Canais → Conexões → Proteção de envio. _(desde 1.0.0)_

### Canais → Nuvemshop

- **Loja Nuvemshop ligada** — Pedidos e clientes da loja entram no CRM sem digitação. (fora do menu desde 1.15.0, só pela busca). _(desde 1.0.0)_

### Canais → Webhooks
- **Automação de tempo com funil e etapa** — "Quando ficar N dias sem mensagem" e "Quando um lead ficar N dias na mesma etapa" ganham seletores de funil e etapa, e salvar pela tela não apaga mais o recorte. Onde: Canais → Webhooks → regras. _(desde 1.79.0)_
- **Formulário próprio por fonte** — Cada fonte de entrada gera um formulário com perguntas extras (listas, caixas, números, valores em reais), pode ser renomeada, e as respostas ficam no lead. Onde: Canais → Webhooks → Fontes. _(desde 1.78.0)_
- **Automação limitada a uma fonte** — As automações de novos contatos podem valer só para uma fonte de entrada. Onde: Canais → Webhooks → regras. _(desde 1.78.0)_

- **Formulário autoriza IA** — Fonte de formulário pode autorizar novos contatos para a IA com consentimento explícito. Onde: Canais → Webhooks → Fontes. _(desde 1.76.0)_
- **Webhook de ganho e perda** — Saída ganha gatilhos de ganho, perda, reabertura e troca de responsável. _(desde 1.71.0)_
- **HMAC da fonte pela tela** — Em Fontes, seção Assinatura HMAC: segredo aparece uma vez e passa a exigir assinatura. Onde: Canais → Webhooks → Fontes. _(desde 1.70.0)_
- **Cadastrar campo da captação** — Em Leads recebidos, botão cadastra como campo do lead o que o formulário mandou. Onde: Canais → Webhooks → Leads recebidos. _(desde 1.70.0)_
- **Campos do formulário nas automações** — Mensagens aceitam atalho de campo e campos do funil viram botões no WhatsApp. Onde: Canais → Webhooks → ação de WhatsApp. _(desde 1.70.0)_
- **Webhook com entrega assinada** — A saída leva id de entrega, tentativa, carimbo e assinatura com guia de verificação. Onde: Canais → Webhooks → ação de webhook. _(desde 1.58.0)_
- **Webhook de compromisso completo** — Gatilhos de agenda levam horário, tipo, local e negócios; comparecer e falta viram gatilho. _(desde 1.53.0)_
- **Aviso em data do funil** — Automação dispara N dias antes ou depois de data do negócio, uma vez só. Onde: Canais → Webhooks → Nova automação. _(desde 1.35.0)_
- **Aniversário dispara regra** — Gatilho manda WhatsApp às 9h no fuso, uma vez por pessoa. Onde: Canais → Webhooks → aniversário. _(desde 1.25.0)_
- **Gatilhos da agenda** — Quatro gatilhos de horário com filtro de tipo e tags do contato. Onde: Canais → Webhooks → gatilhos. _(desde 1.23.0)_
- **Respondi vira lead** — Formulário cria lead com respostas na ficha e telefone vira brasileiro. Onde: Canais → Webhooks → fontes. _(desde 1.6.0)_
- **Leads recebidos na tela** — Aba lista quem chegou, quem não entrou e por quê, com atalho ao lead. Onde: Canais → Webhooks → Leads recebidos. _(desde 1.5.0)_
- **Mensagem escrita pela IA** — Automação manda texto do agente publicado com instrução sobre os dados. Onde: Canais → Webhooks → ação de IA. _(desde 1.5.0)_
- **Entrada por formulário** — Endereço público recebe lead de página e ferramenta externa. Onde: Canais → Webhooks → Fontes. _(desde 1.0.0)_
- **Regra que espera revisão** — Automação nasce pausada e só age depois de alguém aprovar. Onde: Canais → Webhooks → regras. _(desde 1.0.0)_
- **Saída sem vazar rede** — Webhook resolve o endereço de verdade antes de qualquer envio. Onde: Canais → Webhooks → saída. _(desde 1.0.0)_

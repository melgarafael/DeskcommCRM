# Restrição comercial opcional — núcleo

A organização pode exigir atendimento exclusivamente humano para preços, negociação e condições de pagamento em Configurações → Distribuição. Default desligado: outras organizações continuam operando. Não é tabela de preços nem validação de veracidade.

Consumidores: `escalarComercialAntesDoModelo` antes de `resolveConversationTurn`, automático/assistido/prévia; `commercialRestrictionGate` na cadeia v10; prévia usa a mesma configuração. Identificação por termos/padrões conservadores PT/es, não classificador universal. Não reconhece toda paráfrase, mídia ou cifra oblíqua; há falsos positivos possíveis. Corpo de endereço, telefone e horários habituais medidos permanece permitido. Outras restrições continuam independentes.

Entrada detectada real chama `performHumanHandoff`: briefing, silêncio infinity, cancelamento de crons e demanda no Inbox. Prévia propõe a passagem sem executar nem transmitir. Saída comercial barrada não chama transporte, grava trace e encaminha à equipe; não libera preço após insistência. Não confirma prazo/atendente existente. Filas por unidade ainda exigem implementação própria; a demanda vai para carteira/fila humana nativa.

Living System Checklist: entrada (mensagens/configuração), saída (handoff/before_send), log (trace/handoff_triggered), tela (Distribuição/Testar/Inbox), porta (Configurações), próximo passo (fila humana), configuração (checkbox + API manager), continuidade (handoff e retorno humano nativos), feedback (revisão manual dos falsos positivos, sem aprendizado automático), mapa (`atendimento-comercial.architecture.json`).

Fora desta entrega: automações determinísticas e campanhas não herdam automaticamente o flag do redator; permanecem desativadas até homologação. Regra de opt-out continua nativa; não altera consentimentos. Não é garantia de zero alucinação. Testes pareados do mesmo texto na cadeia e na prévia, transporte não chamado. Sem dados reais de clientes.

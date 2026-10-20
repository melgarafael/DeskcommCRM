# Revisão de agenda por fase

CONFIRMADO por código: `conferirPedidoDaAgenda` relê a agenda e leva a regra de confirmação do serviço junto com sua revisão. O escritor nativo conserva a revalidação de disponibilidade, conflitos e revisão. O campo ausente não dispensa confirmação. A regra não concede consentimento nem substitui decisões humanas autenticadas pertinentes.

Antes da escrita, JEV e reserva usam `CRITERIO_PROPOSTA_AGENDA`: pedido atual, pessoa, serviço, dia, hora/fuso e origem mais recente nas remarcações. Não se exige publicação ou recibo futuro de uma nova criação. O conteúdo e o histórico dos Casos continuam no pacote factual; pendência operacional não cria autoridade humana. Depois da escrita continuam valendo recibo, publicação, identidade/revisão e candidata efetivamente enviada.

O leitor de agenda exige sinais literais consistentes entre os objetos JSON recebidos. Saídas contraditórias não escolhem nem o primeiro nem o último positivo; emitem `agenda_review_ambiguous_output` sem conteúdo privado e mantêm o fechamento seguro. Os leitores históricos de outros classificadores permanecem intactos. Não há nova chamada de modelo ou aprovação determinística.

Explicar ausência de execução não promete implicitamente que ela ocorrerá. Na recuperação, a candidata deve comunicar o resultado/estado atual ou o impedimento real; saudação/formulário sozinhos não bastam. Promessas adicionais, atribuição humana ou falsa confirmação continuam nos gates correspondentes.

Conectividade: consulta nativa → proposta → pacote comum/JEV/reserva → gate anterior à escrita. A saída ambígua volta como recusa à ferramenta e permanece na trilha nativa de execução/diagnóstico opt-in; a recuperação limitada e o encaminhamento já existentes conservam o próximo passo. Nenhuma superfície, credencial, configuração ou tabela nova. A configuração do serviço permanece no painel da agenda; diagnósticos nas execuções e coleta privada já existentes.

Limite: testes com provedores controlados comprovam composição, transporte e fechamento seguro, não acurácia do modelo. O aceite final exige a conversa real, resultado CRM/Google e confirmação entregue, com captura contemporânea do contexto recebido pelos revisores. Não inferir essa prova de um teste sintético verde.

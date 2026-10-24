# Seleção de reservas no contexto da revisão

A fotografia canônica é comum ao agente, JEV, revisão de reserva e confirmador. A quota de operações continua limitada a oito itens/4.000 caracteres, com itens inteiros e cobertura explícita. Nenhuma omissão se transforma em ausência de restrição.

`updated_at` também muda durante a sincronização de eventos cancelados. Usá-lo como prioridade pode expulsar uma reserva vigente da fotografia. A seleção de agenda agora transporta primeiro reservas não canceladas e depois cancelamentos ordenados pelo seu próprio `cancelled_at`; a criação e o ID dão desempate determinístico. A mesma ordem vale antes do limite SQL e na normalização defensiva. A ordem não concede autorização nem transforma uma reserva ativa em prova de correspondência ao pedido.

A leitura de consulta não fabrica uma operação ou transição deste turno. Escritas continuam vinculadas pelo observador nativo à mesma identidade e revisão relidas. Remarcações sucessivas usam origem da última revisão e destino atual; cancelamento preserva sua própria revisão/publicação removida. Confirmadores recebem os mesmos fatos e mantêm seus sinais independentes. Histórico cancelado, cobertura, decisões humanas pertinentes e proteções são preservados.

Os testes dirigidos existentes montam e interceptam a requisição de revisão nas seis etapas: criação, primeira remarcação, segunda remarcação, cancelamento sem remarcação, após uma e após duas remarcações. Incluem histórico misto com atualizações técnicas posteriores, consulta sem escrita e os negativos de publicação pendente, revisão divergente e confirmação humana exigida. Provedores controlados verificam transporte, não acurácia de modelo real ou entrega; essas exigem a coleta contemporânea na conversa legítima.

# Alcance individual do recibo de agenda

Um recibo relido comprova a reserva e a revisão identificadas. Não é um inventário exaustivo dos compromissos do contato. `resultado_agenda_do_turno.alcance` declara essa fronteira sem acrescentar autorização ou informação sobre outros registros.

O agente, a recuperação limitada de envio, JEV, a revisão de reserva e o confirmador compartilham a mesma instrução de alcance. Uma lista parcial não sustenta “não há outra reserva”. O pedido para não reservar outro horário limita a ação autorizada; não atesta a ausência de compromissos anteriores. A cobertura parcial também não invalida, por si, a comunicação específica de um recibo completo.

Na recuperação, uma afirmação adicional sem prova deve ser retirada. A operação persistida correta não deve ser repetida ou alterada para adequá-la ao texto. Candidata, pedido, pessoa, serviço, data/hora, revisão, Google, decisões humanas e demais gates continuam independentes. Um sinal negativo nunca vira positivo pela existência do recibo.

A revisão LLM de envio pode devolver `motivo_curto` e `afirmacao_sem_suporte` no mesmo JSON negativo. São diagnósticos da incompatibilidade verificável, sem raciocínio interno; não participam da autorização, não exigem outra chamada e não viram logs de texto. A captura privada nativa existente, quando habilitada, preserva a saída literal sob sua retenção. Não se exige justificativa textual da decisão binária do JEV.

Consumidores: `blocosDeAgendaResidentes` ensina o agente; `projetarResultadoAgendaDoTurno` alimenta abertura e resultados nativos; `pacoteFactualDaRevisao` alimenta JEV/reserva/confirmador; `CORRECAO_DO_ENVIO_DE_AGENDA` orienta a tentativa limitada. O envio permanece em `send_message`, com ledger e gates. Agenda e conversa continuam nas telas existentes. Sem schema, configuração, tela, ambiente ou chamada adicional.

Os testes de transporte e composição com provedores controlados não provam acurácia do modelo nem entrega real. A validação exige contexto contemporâneo capturado, efeito correto e confirmação correspondente entregue. Um cancelamento já persistido deve ser acompanhado por consulta legítima, sem nova execução para repetir a prova.

---
impacto: capacidade_nova
secao: adicionado
titulo: Lista de espera com encaixe: a desmarcação oferece a vaga a quem pediu para ser chamado
---

Cada desmarcação abre um horário, e o "se abrir um encaixe, eu quero" vivia no caderno da recepção. Agora existe o pedido no sistema (`calendar_waitlist`): serviço, profissional (ou qualquer um), as faixas de horário que servem, antecedência mínima, até quando vale e a urgência. Quando um compromisso é desmarcado, a vaga é oferecida a **uma pessoa por vez**, na ordem de urgência e depois de chegada, e fica segurada como compromisso `pending` — o mesmo estado que já ocupa o horário e já expira sozinho. Se a pessoa recusar ou o prazo da oferta vencer (duas horas), a vaga passa para o próximo e só então ela volta para a fila; se confirmar, o compromisso vira `confirmed` e a inscrição fecha como atendida. O atendimento inteiro precisa caber no buraco, não só o começo. O pedido de encaixe ainda é criado pelo código — a ferramenta do agente e a tela da equipe ficam para a fatia seguinte. Contribuição de @webtecnica (#3465).

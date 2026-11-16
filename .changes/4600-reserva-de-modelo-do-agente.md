---
impacto: capacidade_nova
secao: adicionado
titulo: A versão do agente pode ter um modelo de reserva, de qualquer provedor cadastrado
---

Até aqui, só o provedor por assinatura tinha reserva. Com um provedor personalizado, a OpenRouter ou a DeepSeek, cota estourada, servidor fora do ar ou tempo esgotado derrubavam a resposta, e o cliente ficava sem retorno. Agora a versão do agente guarda um provedor e um modelo de reserva, vazios de fábrica. Quando a chamada principal falha por um desses três motivos, a reserva tenta UMA vez. Erro do próprio pedido, credencial recusada ou modelo fora da lista que a empresa liberou não caem para a reserva, e a reserva fala com o endereço do próprio provedor. A aba Execuções mostra quando a resposta veio da reserva. Quem não configura nada não vê diferença. A tela para preencher a reserva vem numa próxima entrega.

Contribuição de @webtecnica (#4617).

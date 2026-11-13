---
impacto: capacidade_nova
secao: adicionado
titulo: A quilometragem informada vira a data prevista da próxima revisão
---

O funil pode declarar a régua "revisão por quilometragem" (`pipelines.settings.revisao_por_km`): o campo de data da retirada, o campo de km, o campo de data de saída, o intervalo (10 000 km), o prazo (12 meses) e os dias de aviso. Quando o km é gravado no negócio — pelo card, pela API, pelo MCP ou pela resposta do roteiro — o CRM calcula o ritmo (km ÷ dias desde a retirada), projeta o dia em que o próximo marco é alcançado, limita pelo prazo e grava a data no campo de saída. O gatilho `lead.date_field_due` de 30 dias passa a ter a data que faltava, e cada quilometragem nova rearma o aviso sozinha.

Quatro casos ficam explícitos: km menor que o da revisão anterior não projeta nem regride a data; 12 meses vence antes do marco de km de quem roda pouco; sem data de retirada não há projeção, e o motivo é registrado; e quem roda muito tem a data elevada para hoje + dias de aviso, para o aviso não nascer vencido.

Entra como módulo opcional da instalação (`revisao_por_km`), desligado por padrão: quem não liga não carrega a régua.

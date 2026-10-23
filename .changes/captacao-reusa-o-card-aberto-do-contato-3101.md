---
impacto: capacidade_nova
secao: adicionado
titulo: Fonte de webhook com assinatura pode reaproveitar o card aberto do contato
---
Quando um sistema da empresa avisa por webhook sobre alguém que já tem um card aberto no mesmo funil, a captação abria um card novo, e o mesmo cliente acabava com dois ou três cards abertos sem ninguém saber qual deles é o de verdade. Na tela da fonte de webhook há uma opção nova, "Reaproveitar o card aberto do contato", e ela vem desligada. Como a opção "Atualizar o card quando o envio repete o mesmo cadastro", ela só liga em fonte com assinatura configurada. Ligada, o envio sem `external_id` atualiza o card que já existe, com os campos que mudaram e a etapa da fonte (só para a frente), em vez de abrir outro. Nada a fazer na atualização: quem não ligar a opção continua com o comportamento de sempre.

Implementado por @webtecnica (#3174).

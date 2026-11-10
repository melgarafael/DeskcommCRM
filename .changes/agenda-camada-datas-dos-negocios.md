---
impacto: capacidade_nova
secao: adicionado
titulo: A Agenda mostra as datas dos negócios
---

Quem trabalha com data — evento, obra, entrega, viagem — tinha as datas dos negócios
só na aba **Calendário** de cada funil. Agora a **Agenda** tem a camada
**Datas dos negócios**: escolha o funil e o campo de data (e, se quiser, um segundo
campo) e os negócios aparecem no dia de cada data, com o rótulo do próprio campo, o
funil e a etapa. Os dias entre as duas datas não aparecem.

A camada **nasce desligada**, e desligada a Agenda fica exatamente como era: nada
de item, nada de consulta. A escolha vale na tela de cada pessoa e
**não fica gravada**. Ela é **só leitura**: não ocupa horário livre, não entra nos
horários sugeridos e não manda lembrete de compromisso — clicar num item abre o
negócio no funil, que é onde a data muda. Quem não enxerga o funil não enxerga a
data: a leitura passa pela mesma regra de visibilidade do CRM.

Os parâmetros da consulta são validados antes de chegar ao banco, e a resposta diz
**por que** não veio lista: período com data que não existe no calendário (31 de
fevereiro, mês 13) volta como `data_de_calendario_invalida`, em vez de uma grade
vazia que pareceria "nenhum negócio neste período".

Nada a fazer na VPS: sem migration, sem variável nova.

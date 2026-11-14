---
impacto: capacidade_nova
secao: adicionado
titulo: O agente passa a ver o preço padrão do tipo de atendimento
---

A ferramenta `crm_list_event_types` passa a devolver `preco_padrao_cents`: o preço padrão do tipo de agendamento, em centavos, o mesmo valor que a comanda já sugere. Quando o tipo não tem preço cadastrado, o campo vem `null`, e não `0`.

Com isso, quando o agente consulta a lista de tipos, ele pode dizer o valor cadastrado no tipo em vez de pedir que a equipe confirme. Quem integra pela ferramenta e lê a lista de tipos passa a receber também esse campo.

Se o preço do tipo estiver desatualizado, é ele que o agente vai dizer, por isso vale conferir os valores em Configurações › Tipos de agendamento. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#4603), a partir da issue de @paulolimajr77 (#4560).

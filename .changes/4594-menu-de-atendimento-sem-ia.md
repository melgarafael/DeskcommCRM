---
impacto: capacidade_nova
secao: adicionado
titulo: Menu de atendimento sem IA, com opções numeradas, como módulo opcional desligado
---

Novo módulo opcional "Menu de atendimento sem IA", que nasce desligado. Ligado em /admin/sistema, e com o menu ativado pela empresa, a PRIMEIRA mensagem de uma conversa sem dono — sem nenhuma saída anterior da empresa — recebe um menu com opções numeradas escrito pela empresa, e o cliente escolhe por número: a conversa vai para a fila, para uma pessoa, ou recebe um arquivo. Contato marcado como "sempre atendimento humano" (ou com etiqueta de contato interno/da equipe) não recebe o menu: essas marcas valem no menu como já valiam para a IA. Em conversa que já teve resposta da empresa, o menu não volta depois de 24 h — o atendimento é um diálogo em andamento. Enquanto o menu espera a escolha, a IA não é chamada e não há gasto de IA. Uma resposta que não é opção repete o menu uma vez; na segunda, a conversa passa para um atendente.

Nesta etapa o menu é escrito na configuração da empresa (settings.menu_de_atendimento) e ainda não há tela para editá-lo. Quem não liga o módulo não vê diferença nenhuma: a entrada continua sendo da IA ou de quem atende. Contribuição de @webtecnica (#4594).

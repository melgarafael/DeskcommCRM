---
impacto: capacidade_nova
secao: adicionado
titulo: Configurações ganha a tela do follow-up por etapa, que edita o prazo dos próprios fluxos de etapa parada
---

O acompanhamento por etapa existia inteiro no servidor e só se montava no
construtor de fluxos: para dizer que a etapa de proposta espera 2 dias, a única
saída era `UPDATE` à mão no Postgres. Agora Configurações → **Follow-up por
etapa** lista as etapas abertas do funil com os fluxos de "negócio parado na
mesma etapa" que alcançam cada uma, e edita o prazo **no próprio fluxo**
(`automation_rules.trigger_config.dias`) — o mesmo valor que a varredura lê.

Não existe um segundo lugar guardando prazo: a tela não grava configuração
paralela, e o que ela mostra é o que acontece. Etapa alcançada por mais de um
fluxo mostra todos, cada um com o seu prazo, porque não existe "o prazo da
etapa" — existe o prazo de cada fluxo, e dois deles disparam os dois lembretes.
O texto da mensagem continua no fluxo, onde uma pessoa o revisa antes de sair: a
tela linka o construtor em vez de abrir um campo próprio. Etapa que nenhum fluxo
alcança aparece dita como tal, para a operação saber onde falta acompanhamento.
Contribuição de @webtecnica.

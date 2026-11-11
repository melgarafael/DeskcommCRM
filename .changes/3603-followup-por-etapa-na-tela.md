---
impacto: capacidade_nova
secao: adicionado
titulo: Configurações ganha a tela do follow-up por etapa — prazo e modelo de mensagem para cada etapa do funil, sem UPDATE no banco
---

O acompanhamento por etapa existia inteiro no servidor e só se montava no
construtor de fluxos: para dizer que a etapa de proposta espera 24h e qual
mensagem usar, a única saída era `UPDATE` à mão no Postgres. Agora Configurações
→ **Follow-up por etapa** lista as etapas abertas do funil com três decisões por
linha — se aquela etapa tem acompanhamento, em quantas horas ele começa e o
modelo de mensagem — e grava tudo de uma vez em `settings.followup_por_etapa`.

Desligar uma etapa não apaga o prazo nem o texto: religar depois não obriga a
escrever de novo. A tela lista TODAS as etapas abertas, marcadas ou não, porque
"esta etapa não tem acompanhamento" é a informação que falta na operação; etapa
de funil arquivado, ganha ou perdida não aparece, porque a gravação recusaria. O
envio continua sendo do fluxo de follow-up de cada etapa, revisado por uma
pessoa no construtor de fluxos — e o que a tela grava passa a ser OBEDECIDO pela
varredura do gatilho "negócio parado na mesma etapa": numa etapa com
acompanhamento ligado, o prazo em horas da tela substitui os dias da automação e
o modelo de mensagem viaja no evento do lembrete. Etapa sem régua continua
exatamente como antes. Contribuição de @webtecnica.

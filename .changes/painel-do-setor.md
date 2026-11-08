---
impacto: capacidade_nova
secao: adicionado
titulo: Painel de atendimento mostra quem espera resposta, quem está em atendimento e quem já foi atendido hoje
---
Um recurso opcional novo, desligado por padrão: quem administra a instalação liga «Painel de atendimento» em Recursos opcionais, e a tela aparece em Análise › Ver tudo em Análise. Ela reúne o dia de quem atende num número só, em três colunas. «Aguardando atendimento» lista quem mandou a última mensagem e ainda não teve resposta, do mais antigo para o mais novo, com «esperando há» quanto tempo. A conversa que a IA passou para a equipe também fica ali até alguém assumir, como na aba Fila. «Em atendimento» traz as conversas abertas em que a última palavra foi nossa, inclusive quando quem respondeu foi a IA. «Atendidos hoje» mostra o que foi encerrado no dia, no fuso da organização. Dá para filtrar por número, e o contador de casos da IA leva direto à fila de casos. A tela mostra só o que cada pessoa já vê no Inbox e atualiza sozinha; no celular as colunas ficam uma embaixo da outra. Quem usa a API ganha o filtro `closed_since` em `GET /api/v1/conversations`.

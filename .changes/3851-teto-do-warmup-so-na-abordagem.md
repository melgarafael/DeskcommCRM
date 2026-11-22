---
impacto: capacidade_nova
secao: adicionado
titulo: O teto diário do número pode contar só a primeira mensagem a pessoa nova
---

Cada conexão ganha a opção **Teto do dia só na abordagem** na ficha de proteção de
envio. Ligada, o teto de warm-up e o limite diário do CRM contam apenas a primeira
mensagem a uma pessoa nova: o follow-up de quem já foi abordado sai sem gastar nem
esperar o teto, e a abordagem continua contando e sendo barrada como antes.

Desligada — o padrão — nada muda: o teto conta todo disparo, exatamente como hoje.
A opção é por número, não por empresa: quem tem dois números escolhe em cada um.

O que **não** muda em nenhum dos dois casos: a resposta a quem escreveu continua
fora do teto (desde a 9061), o intervalo mínimo entre mensagens e a janela horária
continuam valendo para todo envio, e opt-out, bloqueio e janela seguem vetando.

Ligar a opção não solta mensagem parada: os turnos adiados pelo teto continuam com
o dia marcado, porque só os adiados pela janela são reagendados na abertura dela.

O **teto próprio do follow-up** que a opção cria agora é configurável: a mesma ficha
e a rota `PUT/PATCH /api/v1/ai/pacing` aceitam `followup_daily_cap` (inteiro maior
que zero, até 10.000 envios/dia). Em branco ou `NULL`, vale o padrão de **200/dia** —
quem nunca mexeu não vê diferença, e o motor segue vetando o 201º follow-up com
`followup_cap`. Antes o campo existia só no banco: toda empresa ficava presa nos 200.

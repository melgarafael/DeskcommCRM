---
impacto: capacidade_nova
secao: corrigido
titulo: O radar de risco parava de avaliar a empresa inteira quando um negócio tinha compromisso na agenda
---

No registro do servidor, uma linha só:

> *o observador de risco falhou — nova linha viola a regra `since <= detected_at`*

E a partir dali, **nada mais era avaliado naquela empresa** — nem os outros negócios, nem nas passadas seguintes, enquanto a situação existisse. O radar simplesmente parava, em silêncio para quem usa.

A causa tem a ver com a agenda. Um negócio entra em risco por **tempo sem contato**, e a data gravada é a do momento em que ele cruzou esse limite. Mas há dois atalhos que colocam um negócio em risco **sem esperar limite nenhum**: quando o compromisso é adiado, e quando a presença não foi confirmada. Nesses casos o sistema calculava uma data de cruzamento **que ainda não chegou** — e o banco, com razão, recusava gravar algo no futuro.

Dois consertos, e eles são independentes de propósito:

- **a data nunca nasce no futuro.** Uma travessia percebida agora começou, no mais tardar, agora. O negócio que esfriou de verdade continua com a data do cruzamento — que é a informação útil para triar;
- **e uma linha ruim passa a custar uma linha.** Se alguma gravação falhar, ela é contada e registrada, e as demais seguem sendo avaliadas.

O segundo é cinto, não conserto: o primeiro tira a causa, o segundo tira o estrago de qualquer causa futura.

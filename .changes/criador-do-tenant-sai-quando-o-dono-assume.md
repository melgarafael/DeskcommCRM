---
impacto: capacidade_nova
secao: corrigido
titulo: Quem cria uma organização para outra pessoa sai dela quando essa pessoa assume
---

Ao criar uma organização pelo painel de plataforma, quem cria entra nela como
administrador. Isso é necessário: sem ninguém dentro, a organização nasceria
inacessível e não daria nem para configurá-la antes de entregar.

O que faltava era a saída. Nada nunca tirava o criador de lá — a aba "Equipe" do
painel de plataforma está desativada, a tela da organização recusa que alguém
revogue o próprio acesso, e a jornada de convite não sabia da existência do
criador.

Na prática, quem instala o sistema para clientes ficava dentro da empresa de cada
um deles, para sempre. O cliente abria Equipe › Membros e encontrava o e-mail
pessoal de quem instalou listado como se fosse um colega da equipe: ocupando uma
vaga, aparecendo como responsável possível na Agenda, e podendo ser removido por
ele — enquanto quem estava lá não tinha como sair.

Agora a saída acontece sozinha, no momento em que a entrega se completa:
**quando o dono aceita o convite, o criador sai da organização.** Antes disso ele
continua dentro, porque até lá alguém precisa estar — então a organização nunca
fica sem ninguém.

Quem cria uma organização para si mesmo não é afetado: continua nela.

Esta versão também limpa os casos que já existem. Se numa instalação o dono já
tinha aceitado o convite e o criador continuava listado, ele sai na atualização.
Nenhuma outra pessoa da equipe é tocada, e organizações cujo convite nunca foi
aceito ficam como estão.

Você não precisa fazer nada para adotar.

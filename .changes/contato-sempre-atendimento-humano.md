---
impacto: capacidade_nova
secao: adicionado
titulo: Contato ganha a marca "Sempre atendimento humano", que a devolução automática não desfaz
---

Quem usa o mesmo WhatsApp para o negócio e para a vida não tinha, pela tela, um
jeito de dizer "este contato a IA nunca atende" que sobrevivesse à devolução
automática: `contacts.force_human` é a trava de HANDOFF, ela nasce da escalação e
morre quando o atendimento é devolvido — e a devolução automática (cron
`handoff-devolucao`) limpava essa trava sem ninguém clicar.

Agora existe `contacts.ai_opt_out`, a marca permanente "sempre atendimento
humano", separada da trava de handoff. Quem marca na ficha do contato liga a IA
para de imediato e nenhuma devolução — manual ou automática — a desfaz; só a
ficha desliga. Todos os caminhos que tentam assumir ou reatribuir o contato a
respeitam: devolução (manual e automática), reautorização da IA, guard de envio,
worker de resposta, varredura de silêncio e elegibilidade por canal. O rodízio e
a passagem para humano continuam iguais. Nada precisa ser feito ao atualizar: a
marca nasce desligada.

Contribuição de @webtecnica (#2671, issue #2379).

---
impacto: nada_mudou
secao: corrigido
titulo: O gatilho de silêncio não tenta mais inscrever, a cada minuto, quem já está num follow-up
---

A varredura do gatilho de silêncio descobria que um contato já tinha follow-up
vivo só quando o banco recusava a inscrição: a tentativa passava pela fronteira
de atendimento, pela proteção da agenda e por um INSERT que o índice único
barrava. Com contatos parados na espera longa de um fluxo, isso se repetia a
cada minuto — numa instalação real, ~124 mil recusas por dia e 100 mil erros no
log do Postgres em 24 h, num banco já sem folga de CPU. Agora a varredura lê
antes quem já está vivo e pula sem tentar. Os contadores seguem os mesmos.

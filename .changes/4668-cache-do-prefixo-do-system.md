---
impacto: nada_mudou
secao: alterado
titulo: Os blocos fixos da plataforma passam a vir ANTES do prompt do agente no system do turno
---

O `system` de cada turno abria pelo prompt do agente, e os blocos que são iguais para toda a instalação (transparência e autoria) vinham depois dele. Como o cache de prefixo dos provedores só reaproveita o começo idêntico do pedido, cada agente diferente — e cada edição do prompt de um deles — invalidava também esses blocos. A ordem passa a ser: blocos da plataforma, o que a tela do agente habilita (casos, agenda, interesse no banco externo), o prompt dele com a memória e o índice de skills, o que muda por turno (prévia, voz) e, fechando, a diretiva de idioma da organização, que continua sendo a última instrução que o modelo lê. O texto de cada bloco não muda; muda a posição. É um comportamento só de custo: a primeira chamada de cada agente depois da publicação recomeça o cache uma vez, porque o prefixo mudou de ordem.

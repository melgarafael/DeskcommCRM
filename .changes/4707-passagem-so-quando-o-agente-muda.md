---
impacto: nada_mudou
secao: corrigido
titulo: O agente só se reapresenta quando o roteador troca de agente de fato
---

A troca automática entre agentes do roteador passa a ser decidida pelo par (agente que atendia, agente que vai atender), e não pelo rótulo do desfecho do turno. Quando o mesmo agente continua na conversa, ele não se reapresenta: antes, um turno marcado como troca fazia o próprio agente que já atendia anunciar que ia continuar o atendimento, no meio da conversa e sem troca nenhuma.

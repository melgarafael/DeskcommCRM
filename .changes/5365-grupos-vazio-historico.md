---
impacto: nada_mudou
secao: corrigido
titulo: Conexões › Grupos não afirma ausência de grupos quando o WhatsApp devolve lista vazia
---

Em Conexões › Grupos, quando a consulta de grupos devolvia uma lista vazia, a tela afirmava "Este número não está em nenhum grupo.". Isso é falso quando o número participa de grupos e o WhatsApp não os devolve, que é o caso medido na #5365: "Guardar o histórico anterior à vinculação" ligado e nenhum grupo ligado ainda. Agora a tela exibe "Nenhum grupo encontrado", sem afirmar nada sobre o número. A lista em si continua vazia nesse estado, e esse conserto segue aberto na #5365. Conserto de @Yshuro.

---
impacto: nada_mudou
secao: corrigido
titulo: Conexões › Grupos não afirma ausência de grupos quando o WhatsApp devolve lista vazia
---

Em Conexões › Grupos, quando a consulta de grupos devolvia uma lista vazia (como no estado inicial com "Guardar o histórico anterior à vinculação" ativado), a tela afirmava "Este número não está em nenhum grupo.", o que é falso quando o número participa de grupos no WhatsApp mas o retorno vem vazio pelo filtro ou sincronização. Agora a tela exibe "Nenhum grupo encontrado", sem fazer afirmação indevida sobre o aparelho. Conserto de @Yshuro. Corrige a issue #5365.

---
impacto: nada_mudou
secao: corrigido
titulo: A tela de Casos diz que a chave do agente está desligada, em vez de ficar muda
---

Quem abria **Agente de IA › Casos** para acompanhar os pedidos que a IA faz à
equipe encontrava a tela sempre vazia e nenhuma pista do motivo: `cases_enabled`
vem **desligada de fábrica** (`AgentForm.tsx`), então a fila estava vazia por
configuração, não por falta de caso.

Agora o estado vazio pergunta primeiro *por que* está vazio: se nenhum agente da
organização consegue abrir caso, a tela diz que o recurso está desligado, por que
a lista está vazia e onde se liga — com link para o cartão do agente. Quem não
pode editar vê a explicação sem o link (não mandamos ninguém para um 403).

Nada muda para quem já usa o recurso: com a chave ligada, vazio continua sendo
"nenhum caso ainda". O default **não** foi tocado.

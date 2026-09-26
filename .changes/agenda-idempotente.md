---
impacto: nada_mudou
secao: corrigido
titulo: Repetir uma marcação devolve o compromisso já criado
---

Retries de uma mesma operação de agendamento passam a reutilizar o compromisso criado e a resposta registrada, tanto pela API quanto pelas ferramentas MCP e pelo runtime nativo do agente. Operações distintas continuam podendo criar compromissos distintos. Contribuição de @lucasa15.

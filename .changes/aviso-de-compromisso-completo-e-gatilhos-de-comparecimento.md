---
impacto: capacidade_nova
secao: adicionado
titulo: O aviso de compromisso por webhook traz horário, situação, tipo, local e negócios, e comparecimento e falta viram gatilho
---

Os gatilhos `appointment.*` passam a mandar no corpo o início, o fim, a situação, o tipo, o local, o link da reunião (quando houver) e os negócios ligados (`lead_ids`). Nada muda para quem já integra: as chaves antigas continuam com o mesmo nome e o mesmo tipo. Surgem dois gatilhos novos de regra, `appointment.completed` (compareceu) e `appointment.no_show` (faltou), que disparam uma vez por mudança de situação. A ação de webhook ganha a opção "Incluir o responsável no corpo", que vem desligada. Contribuição de @webtecnica (PR #1709, issue #1612).

---
impacto: capacidade_nova
secao: alterado
titulo: A IA responde bem mais rápido no atendimento automático
---

Modelos de raciocínio da OpenAI (gpt-5, o1/o3/o4) passam a receber um esforço
de raciocínio explícito, com padrão baixo. Numa instalação real, respostas de
atendimento com 23 a 34 tokens de texto custavam até 2047 tokens de saída — o
excedente era raciocínio invisível — e o turno levava 28 segundos em média, 50
no pior caso. Com o mesmo prompt, o padrão anterior gastava 8954 ms e o novo
gasta 2252 ms, com resposta equivalente.

Quem quiser o comportamento anterior usa `LLM_REASONING_EFFORT=provider`; quem
tem um agente que decide preço ou compara planos pode subir para `medium` ou
`high`, na instalação inteira pelo `.env` ou por organização em
`settings.llm.params.reasoningEffort`. Instalação que não edita nada recebe o
padrão novo ao atualizar. Outros provedores e modelos não são afetados.

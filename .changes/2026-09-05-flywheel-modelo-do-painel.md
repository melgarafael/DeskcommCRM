---
impacto: nada_mudou
secao: corrigido
titulo: A avaliação automática do atendimento volta a rodar em quem não usa Anthropic
---

A rodada que revisa os atendimentos e sugere melhorias pedia um modelo pelo nome
fixo `claude-haiku-4-5`. Esse nome só existe no vocabulário da Anthropic, então
em instalação apontada para outro provedor (OpenRouter, por exemplo) o provedor
recusava a chamada e a rodada morria a cada disparo, sem sugestão nenhuma
chegando à tela de Propostas. Agora os dois pontos do flywheel usam o modelo
escolhido no painel de provedores e, na falta dele, o padrão da organização — o
mesmo caminho de todos os outros pontos de IA.

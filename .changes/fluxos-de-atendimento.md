---
impacto: capacidade_nova
secao: adicionado
titulo: Fluxos de atendimento em tempo real + melhorias no editor de fluxos
---

- **Fluxos de atendimento:** nova tela (IA → Fluxos de atendimento) para montar
  perguntas que a IA conduz durante a conversa. A IA pergunta uma por vez, guarda
  a resposta no cadastro do cliente (valor **normalizado**), não repete o que o
  cliente já disse, aceita **correção** e para de perguntar quando o dado não é
  mais necessário — ou após um **máximo de tentativas**. Ao concluir, pode chamar
  uma skill, devolver à IA ou apenas encerrar. O fluxo começa quando o roteador
  de intenção casa (IA → Roteadores).
- **Editor de fluxos:** botão **Organizar** (auto-layout), exclusão nativa de nó
  e aresta, e validação de integridade do grafo (id repetido / aresta órfã) —
  vale para Follow-ups e para os Fluxos de atendimento.
- **Entrada pelo motor:** cada fluxo pode ter **palavras-gatilho** (no nó Início);
  quando a mensagem do cliente contém uma delas, o sistema inicia o fluxo
  **sozinho** — sem depender do modelo. Saudação/assunto sem gatilho apenas é
  respondido, sem iniciar fluxo.

Nada exige ação de quem opera: a atualização entra sem editar `.env` ou compose.

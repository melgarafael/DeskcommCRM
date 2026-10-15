---
impacto: capacidade_nova
secao: adicionado
titulo: A automação Iniciar fluxo de mensagem também inicia fluxo de atendimento
---

A ação "Iniciar fluxo de mensagem" das automações ganhou o campo "Tipo de fluxo". Em "Follow-up", que é o padrão, as regras já salvas continuam inscrevendo no mesmo fluxo; a única diferença é que contato que pediu para não receber mensagens deixa de ser inscrito. Em "Atendimento", ela começa um roteiro de atendimento publicado pela mesma entrada da palavra-gatilho e do roteador. Nenhuma mensagem sai na hora: a primeira pergunta do roteiro vai no próximo turno do contato, com as mesmas guardas do atendimento normal. A opção só aparece quando o módulo Fluxos de atendimento está ligado na instalação; com ele desligado, a regra pula e a aba Atividade diz o motivo. Contato que pediu para não receber mensagens não é inscrito em fluxo nenhum, de follow-up ou de atendimento, e a aba Atividade diz o motivo.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2710), a partir da issue #2647.

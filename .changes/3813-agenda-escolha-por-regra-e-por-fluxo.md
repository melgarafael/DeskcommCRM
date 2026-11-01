---
impacto: capacidade_nova
secao: adicionado
titulo: Regra de automação e follow-up escolhem o que fazer quando o contato tem horário marcado
---

Até aqui, todo envio automático para quem tinha um compromisso pendente ou confirmado na
agenda ficava adiado até o horário, mesmo que o compromisso fosse daqui a meses. Agora as
ações de enviar mensagem (texto e IA) e a configuração do follow-up aceitam
`quando_ha_compromisso`: `adiar` (o padrão, igual a antes), `enviar` (a agenda não segura
este envio) ou `nao_enviar` (o envio é pulado; numa regra de automação, a aba Atividade
mostra o motivo). Opt-out, janela do número e limite diário continuam valendo sempre. A
escolha ainda não tem controle na tela: por enquanto ela é gravada pela API da regra e pela
configuração do agente. Quem não configura nada não vê diferença.

Contribuição de @webtecnica (#3818, issue #3813).

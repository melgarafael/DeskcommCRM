---
impacto: nada_mudou
secao: corrigido
titulo: Etiqueta posta pelo agente de IA ou por integração (MCP) agora dispara a automação "ganhou uma etiqueta"
---

A ferramenta `crm_manage_tags` gravava a etiqueta no contato ou no negócio, mas não emitia o evento que a tela emite. Resultado: a regra "Quando um contato ganhar uma tag" (ou "Quando um lead ganhar uma tag") disparava quando a pessoa punha a etiqueta pela tela e ficava muda quando a mesma etiqueta chegava pela MCP — seja de um sistema de fora, como o n8n, seja do próprio agente de IA do CRM, que usa essa ferramenta para etiquetar durante a conversa. Regras de "ganhou etiqueta" que antes ficavam caladas quando a IA etiquetava passam a disparar.

Agora a ferramenta emite `contact.tag_added` / `lead.tag_added` com o mesmo envelope da tela: só as etiquetas que o alvo não tinha, a lista completa e a origem do atendimento. Reenviar uma etiqueta que já estava, ou só remover, não emite nada. Conversa continua sem esse gatilho. Se a emissão do evento falhar, a etiqueta continua gravada e a falha vai para o log. Sem migration e sem ação do operador.

Crédito: @rgisjr.

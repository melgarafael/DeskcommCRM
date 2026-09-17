---
impacto: nada_mudou
secao: corrigido
titulo: Excluir uma conexão de WhatsApp fecha o aviso crítico que ficava aberto para sempre
---
A Central de avisos mantinha um alarme crítico para uma conexão que já não existia — "WhatsApp fora do ar (STOPPED) — Nenhuma mensagem entra nem sai por esta conexão até ela voltar" — e o cartão nem conseguia mostrar o contexto: "Este contexto não está disponível para você". O aviso só fechava quando a própria sessão avisava que tinha voltado, e uma conexão arquivada nunca mais manda evento nenhum: o único caminho que resolveria o episódio desaparecia no mesmo instante em que a conexão era removida. Enquanto isso, a conexão nova, com o mesmo número, podia estar funcionando normalmente nos dois lados.

Agora, ao excluir (ou arquivar) uma conexão, os avisos abertos DELA são resolvidos no mesmo ato — e só os dela: o alerta de outro número que segue caído continua na Central, e o número que voltar a cair avisa de novo. O que a operação fez com os avisos fica registrado na auditoria.

Crédito: @webtecnica. Relato: @rogercampel.

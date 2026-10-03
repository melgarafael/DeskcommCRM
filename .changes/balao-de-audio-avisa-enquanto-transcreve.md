---
impacto: capacidade_nova
secao: adicionado
titulo: O balão do áudio avisa "Transcrevendo…" enquanto a transcrição é gerada
---
Enquanto o sistema ainda está transcrevendo um áudio, o balão da conversa mostrava só o player: o atendente não tinha como saber se o texto ia existir nem quanto tempo faltava. Agora, enquanto a transcrição está sendo gerada, o balão mostra um discreto "Transcrevendo…" logo abaixo do player; quando o texto fica pronto, ele aparece identificado com o rótulo "Transcrição". Quando a leitura falha ou não é possível, o balão continua mostrando só o player, sem aviso — como já era.

Não é preciso fazer nada na instalação: o aviso vale para áudio recebido e para áudio enviado pelo celular, e some sozinho quando a transcrição fica pronta — ou depois de alguns minutos, se o texto não vier (áudio de grupo, por exemplo, nunca é transcrito). O áudio gravado pelo atendente no CRM não mostra o aviso.

Contribuição de @webtecnica, na issue #2133 e no PR #2154.

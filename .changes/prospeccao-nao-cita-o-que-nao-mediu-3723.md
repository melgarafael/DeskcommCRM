---
impacto: nada_mudou
secao: corrigido
titulo: "A prospecção não cita mais como defeito do site o que ela não conseguiu medir"
---

Quando o site da empresa barra o acesso automático do servidor (401, 403, 406, 429, 451, 503 ou desafio anti-robô) ou não responde a tempo, a auditoria agora marca "Site não medido" e a abordagem segue sem falar do site. Antes isso virava "site com problemas" ou "site fora do ar" e entrava na primeira mensagem. Itens do checklist (falta de telefone, fotos, mapa) deixam de classificar o site e de ir para o gancho; link de WhatsApp conta como telefone; título curto deixa de ser defeito; e página montada por JavaScript mostra "Checklist não medido" em vez de faltas inventadas. Vereditos já gravados são corrigidos na leitura, sem mudar o banco: um domínio inexistente auditado antes desta versão aparece como "não medido" até a próxima auditoria. Nada muda na VPS.

Crédito: @webtecnica (#3742, #3723).

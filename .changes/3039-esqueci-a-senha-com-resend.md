---
impacto: nada_mudou
secao: corrigido
titulo: O "esqueci a senha" deixa de recusar a recuperação na instalação que envia pela Resend
---

Numa instalação de servidor único com e-mail só pela Resend, o kit já levava a Resend ao serviço de login, mas o CRM olhava só o SMTP: a tela de "esqueci a senha" recusava uma recuperação que sairia, e a tarja de "sem SMTP" seguia acesa no painel de Atualização e no `/admin`. Agora "sem e-mail no login" é não ter SMTP nem Resend, e os três lugares respondem igual. A frase da tela perdeu o absoluto "não sai e-mail nenhum" e diz só o que o CRM sabe: não há SMTP nem Resend configurados nele. Sem SMTP e sem Resend, a recuperação continua sendo recusada do mesmo jeito.

O que segue valendo: SMTP ou Resend salvos pela tela só chegam ao serviço de login no próximo `update.sh`, e até lá a tela deixa de recusar e o envio pode falhar com o erro genérico. O SMTP posto à mão no `.env` do Supabase o CRM não enxerga, e a tela segue recusando nesse caso; o remédio é configurá-lo em `/admin/email`. Nada precisa ser feito na instalação. Contribuição de @webtecnica (#3188), cuja medição apontou este caminho.

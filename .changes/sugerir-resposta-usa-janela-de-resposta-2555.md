---
impacto: nada_mudou
secao: corrigido
titulo: "Sugerir resposta" e o "Testar" do agente passam a respeitar a janela de resposta, não a de disparo
---

Fora do horário de disparo (padrão 7h-22h), o "Sugerir resposta" não gerava rascunho (aparecia "Confira a configuração do agente e tente gerar novamente"), mesmo quando a conexão tinha a janela de resposta aberta (por exemplo, 0h-24h). A prévia avaliava a janela errada, embora o envio do rascunho aprovado já usasse a janela de resposta. Agora a prévia usa a mesma janela de resposta do envio, e o "Testar" mostra o mesmo aviso que a produção mostraria. Os disparos em massa e as retomadas de conversa continuam presos à janela de disparo. Nada precisa ser feito ao atualizar. Conserto de @webtecnica (PR #2599); relatado por @rogercampel (issue #2555).

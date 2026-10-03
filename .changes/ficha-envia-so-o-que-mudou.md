---
impacto: nada_mudou
secao: corrigido
titulo: A ficha do negócio e o painel do CRM não desfazem mais o que outra pessoa alterou
---

Quem abria a ficha de um negócio — no dossiê ou no painel do CRM da caixa de entrada — e salvava devolvia ao valor antigo tudo o que outra pessoa (ou o assistente) tinha mudado naquele meio-tempo, mesmo sem tocar naquele campo: o formulário enviava a lista inteira de campos extras que carregou ao abrir e o servidor somava por cima do que já estava gravado. O campo simplesmente voltava, sem nenhum erro aparecer. Agora a ficha manda só o que a pessoa alterou, o merge continua sendo do servidor, e apagar um valor preenchido continua sendo transmitido e gravado.

Nada a fazer na instalação: a atualização entra sozinha com o resto do código.

Contribuição de @webtecnica (PR #2151, refs #2132).

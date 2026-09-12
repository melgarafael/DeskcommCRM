---
impacto: capacidade_nova
secao: adicionado
titulo: A aba Membros mostra os convites enviados, com status e ações
---

A tela **Equipe › Membros** ganhou uma seção **Convites**. Antes, um convite pendente só aparecia numa lista efêmera dentro do modal "Convidar membros", que sumia ao fechar — não havia onde ver se um convite foi enviado, se o e-mail saiu, se expirou ou se foi ignorado.

Agora cada convite mostra e-mail, papel e perfil de interface; o status (**Pendente / Aceito / Expirado / Revogado**); a data de envio e a de expiração; e quem enviou o convite. Quando o e-mail **não saiu** — instalação sem serviço de e-mail configurado, por exemplo — a linha avisa e oferece o link do convite para copiar ali mesmo, em vez de o admin achar que enviou.

Administradores podem **reenviar**, **copiar o link** e **revogar** cada convite; gerentes veem a lista. Revogar passa a impedir o aceite mesmo com o link ainda dentro da validade.

Tudo escopado por organização (RLS). Nada muda para quem já roda: a atualização cria a tabela `team_invites` sozinha, sem edição de `.env` nem de compose.

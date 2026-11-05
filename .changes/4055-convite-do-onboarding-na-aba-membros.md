---
impacto: nada_mudou
secao: corrigido
titulo: O convite feito no onboarding aparece na aba Membros e pode ser revogado
---

O passo 6 do onboarding ("Quem trabalha com ele") mostrava o link de aceite para
**Copiar link**, mas o convite não existia na aba **Membros** da tela de Equipe:
nada era gravado em `team_invites` e a seção dizia "Nenhum convite enviado". Quem
fechasse a aba sem copiar o link não tinha onde recuperá-lo, reenviar ou revogar.

Agora o onboarding usa o mesmo caminho do convite de `/app/team/invite`: o
convite vira linha em `team_invites` e aparece na aba **Membros** como Pendente,
com o e-mail, o papel e o botão **Copiar link**. Revogar e aceitar funcionam
igual, e reconvidar o mesmo e-mail renova a linha em vez de duplicá-la.

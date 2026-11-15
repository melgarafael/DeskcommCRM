---
impacto: nada_mudou
secao: corrigido
titulo: O acompanhamento administrativo não cria acesso permanente também pelas ações de tela
---

Durante uma sessão de acompanhamento, criar algo que sobrevive ao fim dela (convite de membro, por exemplo) passa a ser recusado também nas ações executadas pelas telas, e não só nas rotas da API. A regra fica num ponto só (`permanentAccessError`, em `lib/impersonate/support.ts`), e uma cerca nos testes reprova ação nova que crie credencial sem passar por ela.

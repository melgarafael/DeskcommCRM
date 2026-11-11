---
impacto: capacidade_nova
secao: adicionado
titulo: Você escolhe quais áreas do CRM um módulo conectado pode acessar
---

Agora, ao ativar um módulo conectado em /admin/extensoes, quem administra a organização vê, em frases simples, as áreas que o módulo pediu, como contatos, conversas, agenda e catálogo, e marca só as que autoriza. Configuração e agentes de IA são áreas sensíveis: só quem administra a organização consente, e elas não vêm marcadas de antemão. O módulo só alcança uma área se o pacote a declarou e a sua organização consentiu, e só no modo permitido: ler ou escrever. Quando uma pessoa usa a tela do módulo, o acesso vale o menor entre o do módulo e o da pessoa, e o registro de auditoria passa a mostrar por qual pessoa o módulo agiu. A chave opcional MODULE_JWT_PRIVATE_KEY só é necessária para essa identificação da pessoa, e você não precisa fazer nada ao atualizar. Se a sua instalação não tem módulo conectado, nada muda.

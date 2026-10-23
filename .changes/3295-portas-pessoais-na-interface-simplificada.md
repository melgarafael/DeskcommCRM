---
impacto: nada_mudou
secao: corrigido
titulo: A interface simplificada mostra as quatro portas pessoais de Configurações, incluindo Notificações e App no celular
---

Com a interface **simplificada** (o padrão de quem entra como `agent`), o hub de Configurações mostrava só **Perfil** e **Segurança**. Sumiam **Notificações** e **App no celular**, que são configurações **pessoais**: é em Notificações que a pessoa liga o lembrete de tarefa, escolhe a antecedência e informa o próprio WhatsApp para receber o aviso, e é em App no celular que ela instala o sistema na tela de início e libera o push. Resultado: justamente quem mais precisa do lembrete — a vendedora, com tarefas a prazo — não encontrava a opção, e o administrador não podia configurar por ela, porque a preferência mora no `raw_user_meta_data` da própria pessoa. A tela abria normalmente por URL digitada de memória; só não tinha porta.

Agora `/app/settings/notifications` e `/app/settings/aplicativo` entram em `PORTAS_ESSENCIAIS` como as vizinhas pessoais: nenhuma escolha de preset ou de destinos as esconde, e elas valem para **todo vínculo** — sem entrar em `ESSENCIAIS_DE_ADMIN`, que continua guardando as portas que exigem o papel de administração. Nada a fazer na atualização. Contribuição de @webtecnica, a partir da issue #3295.

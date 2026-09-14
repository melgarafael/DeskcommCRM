---
impacto: capacidade_nova
secao: adicionado
titulo: Gestão de modelos do parceiro Graph-compatível (Datafy) — criar, listar e apagar pela tela
---

A conexão por parceiro Graph-compatível ganhou a aba **Modelos**: agora dá para **listar, criar, editar e apagar** as definições aprovadas direto pela tela, sem sair do CRM.

É o que faltava para atender **fora da janela de 24 horas**: texto livre só passa dentro dela; fora, a Meta exige um modelo aprovado — e a partir de agora o parceiro tem esse caminho. O formulário é o mesmo do outro parceiro (cabeçalho, corpo, rodapé, botões, exemplos), e o que é criado entra na fila de revisão da plataforma.

- **Os modelos são os da API oficial** (o parceiro só dá outra porta): o que você cria aqui aparece no painel da plataforma e é o mesmo espelho local (`meta_templates`) que o agente usa para escolher o que enviar.
- **Sincroniza sozinho** depois de criar: a definição nasce em revisão e aparece pendente na lista, para você não criar a mesma duas vezes.
- **Envio pela janela certa:** o modelo enviado monta os parâmetros a partir do espelho e sai pelo host e token do parceiro — nunca pelo número da Meta.

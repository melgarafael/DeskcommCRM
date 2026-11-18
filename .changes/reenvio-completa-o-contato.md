---
impacto: nada_mudou
secao: corrigido
titulo: O segundo envio de uma integração completa o contato do card, e não só o card
---

Na fonte de webhook com "Atualizar o card quando o envio repete o mesmo cadastro" ligada, a integração que manda primeiro só o e-mail (a pessoa clicou num link) e depois o cadastro com nome e telefone, sob o mesmo `external_id`, atualizava o título, os campos e a etapa do card — mas o contato ligado a ele ficava com o e-mail no lugar do nome e sem telefone. Sem número, o follow-up pelo WhatsApp, o agente e o envio pelo CRM não alcançavam a pessoa.

Agora o reenvio também completa o contato do card: grava o telefone e o e-mail que faltam e troca o nome só quando ele ainda é o provisório (vazio, ou a cópia do e-mail ou do telefone). Nada que já esteja preenchido é trocado — um nome ou número escrito na tela continua valendo —, um telefone que já é de outro contato não é copiado nem religa o card, e contato pessoal ou anonimizado não é alterado. Quando o telefone entra, sai o mesmo `contact.phone_added` do resto do sistema.

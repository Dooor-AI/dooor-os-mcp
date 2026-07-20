# Publicação do MCP

O servidor MCP do Dooor OS é open-source e público:

> https://github.com/Dooor-AI/dooor-os-mcp

Usuários externos clonam e configuram o MCP a partir desse repositório público.
Eles não têm e não devem ter acesso a este monorepo privado
(`Dooor-AI/dooor-os`). Por isso, qualquer instrução de setup do MCP que sair
para fora aponta para o repositório público, nunca para o `dooor-os`.

## Onde ficam as configs e o código

* Código-fonte de desenvolvimento: esta pasta (`dooor-os/dooor-os-mcp/`).
* Espelho público: `Dooor-AI/dooor-os-mcp`.

Sempre que mexer no MCP, incluindo tools novas, mudança de client ou env vars,
atualize o repositório público. O publish não pode conter segredos: o MCP lê
`DOOOR_API_KEY` do ambiente, nunca de código.

O health check externo do servidor hospedado é `GET /health`. O endpoint
principal MCP é `POST /mcp`.

## Contrato de segurança do servidor hospedado

O MCP público não devolve body de resposta `5xx`, stack trace ou mensagem
interna nas respostas. Falha de servidor é sempre reportada de forma genérica,
porque pode carregar stack trace, string de conexão ou segredo.

Respostas `4xx` são tratadas de forma diferente, e de propósito: elas descrevem
o que o chamador enviou de errado, e o chamador é justamente quem precisa ler
aquilo. Sem isso, um erro de sintaxe numa consulta chega ao usuário como se a
plataforma estivesse fora do ar. A mensagem do backend é repassada apenas
quando o status é `4xx`, sempre redigida (chaves `dor_sk_*` e headers de
autorização são mascarados) e truncada em 300 caracteres na própria construção
do erro, de modo que nenhum ponto de chamada consegue reter texto não
sanitizado. Body que não estiver no formato JSON esperado é descartado em vez
de repassado cru, e `401`, `403`, `404`, `409` e `429` mantêm mensagem genérica
para que uma falha de autorização nunca ecoe o texto do upstream.

Falhas públicas recebem um correlation ID criado pelo próprio servidor e
enviado também no header `X-Correlation-Id`. IDs enviados pelo cliente não são
reutilizados.

O limite em memória do MCP é uma defesa local por hash da API key. Ele não usa
IP de origem, pois proxies podem compartilhar o mesmo IP entre clientes. Esse
limite vale somente para o processo ou instância atual. O backend do Dooor é a
fonte autoritativa dos limites e quotas globais entre todas as instâncias.

## Como sincronizar para o público

A partir desta pasta, copie os arquivos versionáveis para um clone do
repositório público, sem `node_modules/`, `dist/` e `.git/`, e faça push:

```bash
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  /caminho/dooor-os/dooor-os-mcp/ ./
git add -A
git commit -m "sync: <descricao>"
git push
```

No `package.json` público, `private` fica `false` e há campos
`repository`/`homepage` apontando para o repositório público.

## Recomendado

Para eliminar drift entre esta pasta e o repositório público, converter
`dooor-os-mcp` em git submodule apontando para `Dooor-AI/dooor-os-mcp`,
como já são `dooor-os-backend` e `dooor-os-frontend`. Enquanto isso não for
feito, vale a sincronização manual acima.

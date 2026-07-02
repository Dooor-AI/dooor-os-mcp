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

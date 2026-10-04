# Credits

Grok Codex Gateway is original work by Gezim Musliaj, copyright 2026.
The source, tests, and documentation in this repository are licensed
under the Apache License, Version 2.0. The license text is [LICENSE](LICENSE).
The short attribution notice is [NOTICE](NOTICE).

That license is a copyright and patent grant for this repository. It
is not a claim over the tools this gateway calls, and it does not
change the license of any package installed from npm.

## This repository

| | |
| --- | --- |
| Work | Grok Codex Gateway, a local MCP server that lets Grok Bot discover eligible projects and run Codex or OpenAI text jobs |
| Copyright | Copyright 2026 Gezim Musliaj |
| License | Apache License, Version 2.0 |
| Contact | gmusliaj@gmail.com |

Contributions sent for inclusion in this repository are accepted under
the Apache License, Version 2.0, unless a separate written agreement
says otherwise. See section 5 of the license.

## Software this gateway runs, but does not include

These programs stay under their publishers' terms. Nothing in this
repository copies their source or grants a license to them.

| Software | Role here | Owner |
| --- | --- | --- |
| Codex CLI | Local worker for project jobs. The gateway shells out to the `codex` binary already installed on the machine. | OpenAI |
| Grok Bot | Chat client. A Bot reaches the gateway through an approved local Shell call or an optional remote MCP connector. | xAI, through the Grok Bot product |
| Node.js | Runtime required by `.nvmrc` and `package.json`. | OpenJS Foundation and Node.js contributors |

## Packages installed from npm

Versions are the ones locked in `package-lock.json`. Direct
dependencies are marked. The others are pulled in by those packages.
Each package's own `LICENSE` file in `node_modules` is the text that
governs it.

The Model Context Protocol TypeScript packages carry this notice in
their license files, which this repository repeats rather than
flattening:

> The MCP project is undergoing a licensing transition from the MIT
> License to the Apache License, Version 2.0. All new code and
> specification contributions are licensed under Apache-2.0.
> Documentation contributions, excluding specifications, are licensed
> under CC-BY-4.0. Contributions for which relicensing consent has
> been obtained are licensed under Apache-2.0. Contributions made by
> authors who originally licensed their work under the MIT License and
> who have not yet granted explicit permission to relicense remain
> licensed under the MIT License. No rights beyond those granted by
> the applicable original license are conveyed for such contributions.

### Direct dependencies

| Package | Version | License | Copyright / author | Use in this gateway |
| --- | --- | --- | --- | --- |
| [@modelcontextprotocol/server](https://github.com/modelcontextprotocol/typescript-sdk) | 2.3.0 | Apache-2.0, with the MCP notice above | Anthropic, PBC | MCP server, tool registration, and protocol types |
| [@modelcontextprotocol/node](https://github.com/modelcontextprotocol/typescript-sdk) | 2.1.1 | Apache-2.0, with the MCP notice above | Anthropic, PBC | Streamable HTTP transport for Node.js |
| [openai](https://github.com/openai/openai-node) | 7.27.0 | Apache-2.0 | OpenAI | Optional Responses API client for text jobs |
| [zod](https://zod.dev) | 4.6.5 | MIT | Copyright (c) 2025 Colin McDonnell | Tool argument schemas |

### Development dependency

| Package | Version | License | Copyright / author | Use in this gateway |
| --- | --- | --- | --- | --- |
| [@modelcontextprotocol/client](https://github.com/modelcontextprotocol/typescript-sdk) | 2.3.0 | Apache-2.0, with the MCP notice above | Anthropic, PBC | Protocol tests against the official client |

### Transitive dependencies

| Package | Version | License | Copyright / author | Brought in by |
| --- | --- | --- | --- | --- |
| @modelcontextprotocol/core | 2.3.0 | Apache-2.0, with the MCP notice above | Anthropic, PBC | `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/node` |
| hono | 4.13.13 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors | `@modelcontextprotocol/node` |
| @hono/node-server | 1.19.17 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors | `@modelcontextprotocol/node` |
| jose | 6.2.12 | MIT | Copyright (c) 2018 Filip Skokan | `@modelcontextprotocol/client` (development) |
| eventsource | 3.0.7 | MIT | Copyright (c) EventSource GitHub organisation | `@modelcontextprotocol/client` (development) |
| eventsource-parser | 3.1.1 | MIT | Copyright (c) 2026 Espen Hovlandsdal | `@modelcontextprotocol/client` (development) |
| pkce-challenge | 5.0.1 | MIT | Copyright (c) 2019. The holder line in that package's LICENSE is blank. Author metadata names crouchcd. | `@modelcontextprotocol/client` (development) |
| cross-spawn | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda | `@modelcontextprotocol/client` (development) |
| which | 2.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | `cross-spawn` |
| isexe | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | `which` |
| shebang-command | 2.0.0 | MIT | Copyright (c) Kevin Mårtensson | `cross-spawn` |
| shebang-regex | 3.0.0 | MIT | Copyright (c) Sindre Sorhus | `shebang-command` |
| path-key | 3.1.1 | MIT | Copyright (c) Sindre Sorhus | `cross-spawn` |

## What is not credited as source

Ganglia is read only as a local directory of project entries. This
gateway does not vendor it. Names of sandbox modes, MCP methods, and
product features are used to describe behavior. They are not
attribution of authorship.

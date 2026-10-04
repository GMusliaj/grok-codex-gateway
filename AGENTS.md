# Gateway development

Initialize nvm and use `.nvmrc` before npm commands. Run `npm run check` and
`npm audit --include=dev` before declaring changes complete.

Keep runtime credentials, private configuration, local paths and task contents
outside this source checkout. Tests use unmistakable placeholder credentials
and fixture workers; do not run live inference as part of the test suite.

Preserve project eligibility checks, bearer authentication, local-only binding,
Codex's sandbox and repository rules. Never add approval-bypass flags. Ganglia
discovery is metadata-only; knowledge retrieval uses its installed recall skill.

Record material changes in CHANGELOG.md. Do not commit or publish unless asked.

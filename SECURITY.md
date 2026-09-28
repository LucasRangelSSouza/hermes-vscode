# Security policy

## Supported versions

Security fixes go to the default branch and the latest GitHub release.

| Line | Status |
|---|---|
| `main` | Supported |
| Latest GitHub release | Supported |
| Older builds | Unsupported |

## Reporting a vulnerability

Do not open a public issue. Use either:

- GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability), or
- email `comercial@rangeltech.net` with the subject `Hermes by Rangel Tech security`.

Include the affected version or commit, the impact, and steps to reproduce. You will get an acknowledgement, and a fix or a mitigation plan as soon as it can be verified.

## Areas that matter most

- Runtime download and extraction: host allowlist, HTTPS only, SHA-256 verification, safe extraction.
- Secret handling: API keys stay in VS Code Secret Storage and reach Hermes only through the process environment. They must never appear in settings, files, logs or session history.
- Executable launch: settings that choose what runs are machine-scoped; a workspace must not override them.
- Webview rendering of untrusted content.

## Out of scope

Vulnerabilities in Hermes Agent itself should be reported to [Nous Research](https://github.com/NousResearch/hermes-agent/security). Endpoint security products that block the runtime are a policy matter, not a vulnerability.

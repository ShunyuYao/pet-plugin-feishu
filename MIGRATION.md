# Migration acceptance

User scope: independent public source repository, bilingual README, official marketplace distribution without preinstallation. Preserve device authorization, auto-created applications, encrypted token migration and refresh, calendar provider/tools, messages and reports.

Implementation boundary: manifest 1.1.0 / API 1 / minimum host 0.21.0, explicit host:feishu compatibility grant. Existing host settings are reused; there is no replacement UI. Await authorization-window loading so a denied or failed navigation becomes a login error.

Acceptance gates: npm test (each regression has a named script), deterministic allowlisted archive build, actual host marketplace install/uninstall and fresh-instance persistence in the host E2E suite. Real account authorization remains manual. Host-only assertions from the original migration and connection tests stay in the host repository rather than being replaced with stubs here.

Public release: review source for credentials, commit source, publish CI-built ZIP from matching tag, compare downloadable checksum, update official registry. Do not publish personal profiles, secrets, development archives, or host source.

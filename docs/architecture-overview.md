# Architecture Overview

A bird's-eye view of how AgentSync moves bytes from your machine to a
Git remote and back. For internals — encryptor format, watcher
plumbing, IPC protocol — read [the deep dive](architecture.md).

## System context

The diagram below shows the major actors and the trust boundaries
between them. **Plaintext never crosses the network**; the Git remote
only ever sees ciphertext blobs and metadata.

<div class="agentsync-darknodes" markdown>

```mermaid
flowchart LR
    AgentsA["AI agents<br/>Machine A"]:::local
    CLI_A["agentsync CLI<br/>+ daemon"]:::local
    KeyA["age keypair<br/>Machine A"]:::key
    SanitizeEncrypt["Sanitize<br/>+ Encrypt"]:::gate
    Vault[("Git vault<br/>ciphertext only")]:::remote
    DecryptApply["Fast-forward<br/>+ Decrypt"]:::gate
    KeyB["age keypair<br/>Machine B"]:::key
    CLI_B["agentsync CLI<br/>+ daemon"]:::local
    AgentsB["AI agents<br/>Machine B"]:::local

    AgentsA -->|read configs| CLI_A
    CLI_A --> SanitizeEncrypt
    KeyA -.->|recipient| SanitizeEncrypt
    SanitizeEncrypt -->|ciphertext| Vault
    Vault -->|ciphertext| DecryptApply
    KeyB -.->|identity| DecryptApply
    DecryptApply --> CLI_B
    CLI_B -->|write configs| AgentsB

    classDef local fill:#2c3e50,color:#ffffff,stroke:#1a252f
    classDef key fill:#8e44ad,color:#ffffff,stroke:#5b2c6f
    classDef gate fill:#c0392b,color:#ffffff,stroke:#7b241c
    classDef remote fill:#27ae60,color:#ffffff,stroke:#196f3d
```

</div>

The dark slate nodes (Machine A and Machine B) live inside their
respective trust boundaries — plaintext never crosses out. The purple
key nodes sit alongside their machine because the age private key is
local-only. The two red **gates** are where every push and pull is
forced through sanitize/encrypt and fast-forward/decrypt; bypassing
them is not a supported path. The green **vault** sees only ciphertext.


## The push pipeline

When you run `agentsync push` (or the daemon fires one), bytes flow
through four gates in order. Any gate can abort the entire push — there
is no partial state in the vault.

<div class="agentsync-darknodes" markdown>

```mermaid
flowchart LR
    Walk["Walk agent paths<br/>AgentPaths resolver"]:::step
    Sanitize["Sanitizer<br/>never-sync + literal secrets"]:::gate
    Encrypt["Encryptor<br/>age recipients"]:::step
    Reconcile["Reconciliation<br/>fast-forward only"]:::gate
    Remote[("Git remote<br/>vault")]:::remote

    Walk --> Sanitize
    Sanitize -->|abort on hit| Abort["push fails<br/>guidance printed"]:::abort
    Sanitize --> Encrypt
    Encrypt --> Reconcile
    Reconcile -->|diverged| Abort
    Reconcile --> Remote

    classDef step fill:#2c3e50,color:#ffffff,stroke:#1a252f
    classDef gate fill:#c0392b,color:#ffffff,stroke:#7b241c
    classDef remote fill:#27ae60,color:#ffffff,stroke:#196f3d
    classDef abort fill:#d35400,color:#ffffff,stroke:#a04000
```

</div>

## Why these specific gates?

| Gate | What it enforces | Why it's non-negotiable |
|---|---|---|
| **Sanitizer** | Never-sync patterns + literal-secret detection | One leaked API key in the vault is one too many. Aborting beats encrypting a secret that future-you might decrypt and paste. |
| **Encryptor** | All vault writes go through `src/core/encryptor.ts` | Defence in depth — if Git history leaks, ciphertext-only is the difference between "annoying" and "catastrophic". |
| **Fast-forward only** | Refuse merges, even trivial ones | Two machines pushing concurrently produce *encrypted* diffs that can't be diff-merged meaningfully. Recovery via `pull` then re-push is the only safe move. |

## The pull pipeline

`pull` is **additive by construction** — it can add files and update
existing ones, but it never deletes. Skill removal is explicit
(`agentsync skill remove`) precisely so a misconfigured pull on a fresh
machine can never wipe local work.

<div class="agentsync-darknodes" markdown>

```mermaid
flowchart LR
    Fetch["git fetch<br/>vault"]:::step
    FF["Fast-forward<br/>or abort"]:::gate
    Decrypt["Decryptor<br/>age private key"]:::step
    Apply["Apply additively<br/>AgentPaths resolver"]:::step
    Local[("Local agent<br/>configs")]:::remote

    Fetch --> FF
    FF -->|diverged| Abort["pull fails<br/>guidance printed"]:::abort
    FF --> Decrypt
    Decrypt --> Apply
    Apply --> Local

    classDef step fill:#2c3e50,color:#ffffff,stroke:#1a252f
    classDef gate fill:#c0392b,color:#ffffff,stroke:#7b241c
    classDef remote fill:#27ae60,color:#ffffff,stroke:#196f3d
    classDef abort fill:#d35400,color:#ffffff,stroke:#a04000
```

</div>

## Where to look in the source

| Concept | File |
|---|---|
| Per-agent path resolution | `src/config/paths.ts` |
| Sanitizer | `src/core/sanitizer.ts` |
| Encryptor / decryptor | `src/core/encryptor.ts` |
| Fast-forward reconciliation | `src/core/git.ts` |
| Watcher + sync queue | `src/core/watcher.ts`, `src/core/sync-queue.ts` |
| Daemon entry | `src/daemon/` |
| CLI commands | `src/commands/` |

Ready for the full picture? Continue to the [Architecture Deep
Dive](architecture.md).

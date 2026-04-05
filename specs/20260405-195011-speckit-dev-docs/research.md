# Research: Improve Speckit Development Documentation

## Decision 1: Use the official six-step spec-kit workflow as the canonical backbone

**Decision**: Structure the repo guidance around the upstream start sequence: install/init, constitution, specification, optional clarification, technical plan, tasks, optional analysis, and implementation.

**Rationale**: The official quickstart and home page define the standard contributor mental model. Replacing that sequence with a repo-specific order would make the docs harder to trust and harder to compare with upstream guidance. The documentation should therefore preserve the official workflow and add repo-local notes where AgentSync differs.

**Alternatives considered**:

- Create a custom AgentSync-only workflow order. Rejected because it would drift from the official docs and make future maintenance harder.
- Document only the commands used most often in this repo. Rejected because the user asked for thorough coverage, including when and how to use the workflow.

**Sources**:

- [Spec Kit Home](https://github.github.com/spec-kit/)
- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- [Specification-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md)

## Decision 2: Split the docs into a start/use guide and a local-development guide

**Decision**: Add one guide that teaches contributors how to start and use spec-kit in this repository, and a second guide that teaches maintainers how to work on the local speckit setup itself.

**Rationale**: The upstream docs already separate quickstart concerns from local CLI development concerns. That split maps well to this repository: a new contributor needs commands, artifacts, and examples, while a maintainer needs prompt-file locations, generated agents, branch conventions, and workflow recovery behavior. Combining these into one page would make the entry path too dense.

**Alternatives considered**:

- Keep everything in `README.md`. Rejected because the resulting page would be too long and hard to scan.
- Put all speckit guidance into `docs/development.md`. Rejected because that page is already about AgentSync development generally, not the spec-kit workflow specifically.

**Sources**:

- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- [Spec Kit Local Development](https://github.github.com/spec-kit/local-development.html)

## Decision 3: Use AgentSync-specific examples instead of generic product demos

**Decision**: Use examples based on real AgentSync feature work, such as documentation changes, workflow maintenance, or feature planning in this repo, rather than photo albums or generic task apps.

**Rationale**: Upstream examples prove how spec-kit works, but they do not teach how to use it effectively in this repository. AgentSync-specific prompts will reduce transfer effort and make contributors more confident when starting their own feature.

**Alternatives considered**:

- Reuse upstream examples verbatim. Rejected because they explain spec-kit generically, not how AgentSync contributors should operate.
- Write abstract examples with no repo context. Rejected because they would not satisfy the user's request for good examples that make local development easy.

**Sources**:

- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- [Specification-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- /Users/chrislee/srv/github/agent-sync/specs/20260405-195011-speckit-dev-docs/spec.md

## Decision 4: Document timestamp branch naming explicitly as a repo-local override

**Decision**: Explain that AgentSync uses timestamp feature branches such as `YYYYMMDD-HHMMSS-slug`, even though many upstream examples still show sequential feature numbers.

**Rationale**: This repo's constitution requires timestamp branches, and `.specify/init-options.json` already sets `branch_numbering` to `timestamp`. Contributors need this called out explicitly because upstream quickstart material and methodology examples still show sequential naming in several examples.

**Alternatives considered**:

- Ignore branch naming differences. Rejected because it would create avoidable confusion when contributors compare repo behavior to official examples.
- Rewrite docs as if upstream only used timestamp naming. Rejected because the docs should teach the real difference, not hide it.

**Sources**:

- [Spec Kit Installation](https://github.github.com/spec-kit/installation.html)
- [Specification-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- /Users/chrislee/srv/github/agent-sync/.specify/init-options.json
- /Users/chrislee/srv/github/agent-sync/.specify/memory/constitution.md

## Decision 5: Teach setup modes separately from workflow stages

**Decision**: Distinguish setup modes such as `uvx` initialization, current-directory initialization, and local development against repo files from the normal speckit command stages.

**Rationale**: The official docs separate installation concerns from workflow usage and local CLI iteration. That distinction matters here because a reader may need to initialize spec-kit in a project, while a maintainer may instead need to understand how the already-installed prompt files and scripts work in AgentSync.

**Alternatives considered**:

- Collapse installation and workflow into a single list. Rejected because it blurs prerequisite actions with feature-development stages.
- Skip local-development modes. Rejected because the user explicitly requested guidance for future local development.

**Sources**:

- [Spec Kit Installation](https://github.github.com/spec-kit/installation.html)
- [Spec Kit Local Development](https://github.github.com/spec-kit/local-development.html)
- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)

## Decision 6: Treat extensions and presets as advanced, optional material

**Decision**: Document core workflow behavior first, then add a short advanced section explaining when extensions and presets matter.

**Rationale**: The upstream docs clearly support extensions and presets, but AgentSync currently has no `.specify/extensions.yml`. New contributors should not have to understand extension architecture before they can start a feature. Advanced customization should be visible without becoming part of the default path.

**Alternatives considered**:

- Omit extensions and presets entirely. Rejected because the spec requires guidance about baseline behavior when extensions are absent and how optional additions should be interpreted when present.
- Lead with extensions and presets. Rejected because it would overload first-time readers.

**Sources**:

- [Spec Kit Home](https://github.github.com/spec-kit/)
- [github/spec-kit Repository](https://github.com/github/spec-kit)
- /Users/chrislee/srv/github/agent-sync/.specify/extensions.yml (not present in this repository)

## Decision 7: Document the repo-local speckit surface as part of maintainer guidance

**Decision**: The local-development guide should explain where speckit prompt files, agent files, and workflow assets live in this repository: `.github/prompts/`, `.github/agents/`, and `.specify/`.

**Rationale**: There is currently no user-facing documentation for these assets, but they are essential for future maintenance. Contributors maintaining the speckit setup need to know where commands come from, which files are generated, and where repo defaults live.

**Alternatives considered**:

- Leave file-layout knowledge implicit. Rejected because that preserves the current tribal-knowledge problem.
- Document every file in detail in the start guide. Rejected because it would distract first-time readers from the main workflow.

**Sources**:

- /Users/chrislee/srv/github/agent-sync/.github/prompts
- /Users/chrislee/srv/github/agent-sync/.github/agents
- /Users/chrislee/srv/github/agent-sync/.specify/integration.json
- /Users/chrislee/srv/github/agent-sync/.vscode/settings.json

## Decision 8: Keep examples optimized for GitHub Copilot while acknowledging upstream agent differences

**Decision**: Use `/speckit.*` commands as the primary examples because this repository exposes GitHub Copilot prompt files and agent definitions for those commands, while briefly noting that upstream docs describe naming differences for some other agents.

**Rationale**: Readers of this repository need the local command surface first. Upstream differences for Claude or Codex are useful context, but they are secondary to the actual developer experience in AgentSync.

**Alternatives considered**:

- Document every agent variant equally. Rejected because it adds noise to repo-focused guidance.
- Ignore cross-agent differences entirely. Rejected because upstream docs explicitly call them out, and readers may compare notes across agents.

**Sources**:

- [Spec Kit Home](https://github.github.com/spec-kit/)
- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- /Users/chrislee/srv/github/agent-sync/.github/prompts/speckit.plan.prompt.md
- /Users/chrislee/srv/github/agent-sync/.github/prompts/speckit.specify.prompt.md

## Decision 9: Use a Mermaid flowchart to show the official process exactly

**Decision**: Include a Mermaid flowchart in the final documentation that follows the official quickstart mainline order exactly, with `checklist` and `analyze` rendered as optional side paths rather than required stages.

**Rationale**: The user explicitly asked for Mermaid diagrams to make the process easy to understand. A visual flowchart gives fast orientation, but it must not invent a repo-specific order. The official quickstart defines the mainline path clearly, while the official docs also show `checklist` and `analyze` as supplemental validation steps. Modeling the mainline and optional paths separately keeps the diagram accurate and easy to scan.

**Alternatives considered**:

- Omit diagrams and rely on prose. Rejected because it does not meet the user's request.
- Put `checklist` and `analyze` into the mandatory mainline. Rejected because that would overstate their role in the official quickstart process.
- Create a repository-specific custom flow. Rejected because the docs must reflect the official process first.

**Sources**:

- [Spec Kit Quick Start](https://github.github.com/spec-kit/quickstart.html)
- [Specification-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md)

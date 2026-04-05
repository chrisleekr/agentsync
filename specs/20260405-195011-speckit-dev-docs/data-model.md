# Data Model: Improve Speckit Development Documentation

## Entities

### Setup Mode

- **Purpose**: Describes how a contributor gets spec-kit available for use or testing.
- **Fields**:
  - `name`: Human-readable label such as `Pinned uvx init`, `Current-directory init`, or `Repo-local development`
  - `audience`: New contributor or maintainer
  - `prerequisites`: Required tools or repo context
  - `entry_command`: Primary example command
  - `use_when`: Situation where this setup mode is appropriate
  - `notes`: Caveats such as script selection or local testing behavior

### Workflow Stage

- **Purpose**: Represents a distinct step in the speckit development flow.
- **Fields**:
  - `name`: Stage name such as `Constitution`, `Specify`, `Clarify`, `Plan`, `Tasks`, `Analyze`, `Implement`
  - `command`: Primary command invocation
  - `required`: Whether the stage is part of the baseline path
  - `input_context`: Information the contributor should provide
  - `output_artifacts`: Files or outcomes created by the stage
  - `use_when`: Decision signal for entering the stage
  - `do_not_use_when`: Situations where another stage is more appropriate
  - `example`: Repo-specific sample prompt or invocation

### Feature Artifact

- **Purpose**: Captures a generated document inside a feature directory.
- **Fields**:
  - `name`: Artifact name such as `spec.md` or `tasks.md`
  - `producer_stage`: Workflow stage that creates it
  - `consumer_stage`: Next stage or reviewer who depends on it
  - `question_answered`: What the artifact explains
  - `readiness_signal`: How a contributor knows the artifact is complete enough
  - `common_failure`: Typical confusion or omission related to the artifact

### Readiness Signal

- **Purpose**: Gives a contributor a concrete reason to move to the next stage.
- **Fields**:
  - `stage`: Stage being completed
  - `observable_condition`: User-visible sign of readiness
  - `evidence_location`: File or output where the sign appears
  - `next_action`: Recommended next step

### Command Example

- **Purpose**: Shows a good, repo-relevant example for how to use a stage.
- **Fields**:
  - `scenario`: Short description of the contributor goal
  - `command_text`: Example invocation or slash command
  - `why_it_is_good`: What the example demonstrates
  - `expected_result`: Artifact or decision that should follow

### Mermaid Diagram

- **Purpose**: Represents a visual explanation of the workflow that lets readers identify the mainline process and optional validation steps quickly.
- **Fields**:
  - `title`: Diagram title
  - `diagram_type`: `flowchart`
  - `mainline_stages`: Ordered list of official quickstart stages
  - `optional_paths`: Supplemental validation paths such as `checklist` and `analyze`
  - `source_of_truth`: Official doc section that defines the order
  - `validation_status`: Whether the Mermaid syntax has been validated successfully

### Troubleshooting Entry

- **Purpose**: Explains a common workflow failure or confusion point.
- **Fields**:
  - `symptom`: What the contributor experiences
  - `likely_cause`: Most probable explanation
  - `recovery_steps`: Ordered next actions
  - `related_stage`: Workflow stage involved
  - `related_artifact`: Artifact or file to inspect

### Documentation Surface

- **Purpose**: Defines one user-facing document in the final docs set.
- **Fields**:
  - `path`: Target file path such as `docs/speckit.md`
  - `audience`: New contributor, maintainer, or both
  - `goal`: Primary user outcome for the page
  - `required_sections`: Sections the page must contain
  - `navigation_sources`: Pages that should link to it
  - `authoritative_sources`: Upstream docs or repo files that ground its claims

## Relationships

- A `Setup Mode` prepares a contributor to enter one or more `Workflow Stage` entities.
- Each `Workflow Stage` creates or consumes one or more `Feature Artifact` entities.
- A `Readiness Signal` is attached to a `Workflow Stage` and often points to a `Feature Artifact`.
- A `Command Example` illustrates one `Workflow Stage` in a specific `Setup Mode`.
- A `Mermaid Diagram` visualizes the relationships among `Workflow Stage` entities for a `Documentation Surface`.
- A `Troubleshooting Entry` resolves confusion around a `Workflow Stage` or `Feature Artifact`.
- A `Documentation Surface` groups related `Setup Mode`, `Workflow Stage`, `Feature Artifact`, and `Troubleshooting Entry` information for a target audience.

## Validation Rules

- Every baseline `Workflow Stage` must have at least one `Command Example`.
- Every `Feature Artifact` must name its producing stage and the question it answers.
- Every required `Documentation Surface` must define both audience and goal.
- Every `Mermaid Diagram` must identify its official source of truth and distinguish mainline stages from optional paths.
- At least one `Troubleshooting Entry` must exist for stage selection confusion, missing artifacts, and resuming work on an existing branch.
- Repo-specific facts must cite repository files, while general workflow facts must cite official spec-kit documentation.

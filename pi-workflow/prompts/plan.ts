import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildPlanPrompt(args: string, config: WorkflowConfig, context: SkillContext): string {
  const vault = config.vault;
  const project = context.project;

  return `# Implementation Plan

You are tasked with creating a detailed implementation plan through an interactive, iterative process. Be skeptical, thorough, and work collaboratively with the user.

## Project: ${project}
## Vault: ${vault}/${project}/

## Initial Input

${args ? `The user wants to plan: ${args}` : `Ask the user what they'd like to plan. They can provide:
1. A task/ticket description (or reference to a ticket file)
2. Any relevant context, constraints, or specific requirements
3. Links to related research or previous implementations`}

## Process

### Step 1: Context Gathering & Initial Analysis

1. **Read all mentioned files immediately and FULLY** (no limit/offset)
2. **Research the codebase** to understand:
   - Existing patterns and conventions
   - Related components and integration points
   - Test patterns to follow
3. **Read all identified relevant files** into your context
4. **Present informed understanding and focused questions** — only ask what you genuinely can't answer through code investigation

### Step 2: Research & Discovery

After clarifications:
1. If the user corrects a misunderstanding, verify with code — don't just accept
2. Research deeper — find similar features, integration points, conventions
3. Present findings with design options (pros/cons)

### Step 3: Plan Structure

Present an outline:
\`\`\`
## Overview
[1-2 sentence summary]

## Implementation Phases:
1. [Phase name] - [what it accomplishes]
2. [Phase name] - [what it accomplishes]
\`\`\`

Get feedback on structure before writing details.

### Step 4: Write Detailed Plan

Write to: \`${vault}/${project}/TASKNAME/YYYY-MM-DD-HHmm-plan.md\`
Create the directory: \`mkdir -p ${vault}/${project}/TASKNAME\`

Use this template:

\`\`\`markdown
# [Feature/Task Name] Implementation Plan

## Overview
[Brief description of what and why]

## Current State Analysis
[What exists now, what's missing, key constraints]

## Desired End State
[Specification of desired end state and how to verify it]

### Key Discoveries:
- [Finding with file:line reference]
- [Pattern to follow]

## What We're NOT Doing
[Explicitly list out-of-scope items]

## Implementation Approach
[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1.1 [Component/File Group]
**File**: \\\`path/to/file.ext\\\`
**Changes**: [Summary]

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: \\\`command\\\`
- [ ] Type checking passes
- [ ] Linting passes

#### Manual Verification:
- [ ] Feature works as expected
- [ ] No regressions

---

## Phase 2: [Descriptive Name]
[Same structure...]

## Testing Strategy
[Unit, integration, manual tests]

## References
- Research: \\\`${vault}/${project}/TASKNAME/...-research.md\\\`
\`\`\`

### Step 4b: Visual Sketch (if applicable)

If the plan involves UI:
1. Create empty .pen file: \`${vault}/${project}/TASKNAME/YYYY-MM-DD-HHmm-sketch.pen\`
2. Write pencil agent config to \`/tmp/pencil-config.json\`
3. Run: \`pencil --agent-config /tmp/pencil-config.json\`
4. Update plan's Visual Reference section

### Step 5: Review

Present the plan location and ask for feedback:
- Are phases properly scoped?
- Are success criteria specific enough?
- Missing edge cases?

Iterate until the user is satisfied.

## Important Guidelines

1. **Be Skeptical** — question vague requirements, identify issues early
2. **Be Interactive** — don't write the full plan in one shot, get buy-in at each step
3. **Be Thorough** — read all context files, include file:line references, write measurable success criteria
4. **Be Practical** — incremental testable changes, consider migration and rollback
5. **No Open Questions in Final Plan** — resolve everything before finalizing
6. **Separate automated vs manual verification** in success criteria
`;
}

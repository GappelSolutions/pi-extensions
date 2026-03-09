import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildImplementPrompt(args: string, config: WorkflowConfig, context: SkillContext): string {
  const vault = config.vault;
  const project = context.project;

  return `# Implement Plan

You are tasked with implementing an approved technical plan from the codelayer vault.

## Project: ${project}
## Vault: ${vault}/${project}/

## Plan Reference

${args ? `Read this plan: ${args}` : `Ask the user for the plan path. Plans are at: \`${vault}/${project}/TASKNAME/YYYY-MM-DD-HHmm-plan.md\``}

## Getting Started

1. Read the plan completely and check for any existing checkmarks (\`- [x]\`)
2. Read all files mentioned in the plan — FULLY, no limit/offset
3. Think deeply about how the pieces fit together
4. Start implementing from the first unchecked item

## Implementation Philosophy

- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

## If Something Doesn't Match the Plan

STOP and present clearly:
\`\`\`
Issue in Phase [N]:
Expected: [what the plan says]
Found: [actual situation]
Why this matters: [explanation]

How should I proceed?
\`\`\`

## Verification

After implementing a phase:
1. Run the success criteria checks from the plan
2. Fix any issues before proceeding
3. Check off completed items in the plan file
4. **Pause for manual verification**:

\`\`\`
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- [List automated checks that passed]

Please perform the manual verification steps listed in the plan:
- [List manual verification items from the plan]

Let me know when manual testing is complete so I can proceed to Phase [N+1].
\`\`\`

Do NOT check off manual testing items until confirmed by the user.

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

## Vault Cleanup (Automatic)

When ALL phases are complete and verified:
1. Delete the task folder: \`rm -rf ${vault}/${project}/TASKNAME/\`
2. Confirm: "Vault cleaned up - removed TASKNAME from codelayer-vault."

This is automatic — don't ask for confirmation.

## Important
- Read files FULLY before implementing
- Implement phase by phase, not all at once
- Run success criteria after each phase
- The plan is your guide, but your judgment matters
`;
}

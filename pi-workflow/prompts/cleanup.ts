import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildCleanupPrompt(_args: string, config: WorkflowConfig, context: SkillContext): string {
  const vault = config.vault;
  const project = context.project;
  const vaultDir = `${vault}/${project}`;

  return `# Vault Cleanup

Clean up completed task folders from the codelayer vault for **${project}**.

## Vault Directory: ${vaultDir}

## Process

1. **List all task folders** in \`${vaultDir}/\`
   \`\`\`bash
   ls -1 ${vaultDir}/ 2>/dev/null || echo "no vault directory"
   \`\`\`

2. **For each folder**, quickly assess status:
   - Read the plan file(s) inside
   - Check git log for commits referencing the task name or ticket ID:
     \`git log --oneline --all --grep="TASKNAME" | head -5\`
   - Check if a related branch exists:
     \`git branch -a --list "*TASKNAME*"\`
   - Classify as:
     - **IMPLEMENTED** — evidence in git (commits found, branch merged)
     - **IN PROGRESS** — partial commits or active branch exists
     - **UNKNOWN** — no git evidence found

3. **Present a summary table**:
   \`\`\`
   Vault Cleanup - ${project}

   IMPLEMENTED (safe to delete):
   - taskname-1/ - commits found, branch merged
   - taskname-2/ - commits found in main

   IN PROGRESS (keep):
   - taskname-3/ - active branch exists

   UNKNOWN (needs manual decision):
   - taskname-4/ - no git evidence found
   \`\`\`

4. **Ask once**: "Delete the IMPLEMENTED folders? (y/n) Any UNKNOWN folders you also want removed?"

5. **Delete confirmed folders** with \`rm -rf\`

6. **Report** what was cleaned up

## Guidelines

- Be fast. Skim plans for ticket IDs and task names, check git — don't deep-analyze
- When in doubt, classify as UNKNOWN
- Never delete IN PROGRESS folders without explicit confirmation
- If the vault directory doesn't exist or is empty, just say so
`;
}

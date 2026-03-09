import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildCommitPrompt(_args: string, config: WorkflowConfig, context: SkillContext): string {
  const c = config.commit;
  const gitRoot = context.gitRoot ?? context.cwd;

  // Build config summary for the prompt
  const configBlock = `## Active Configuration

| Setting | Value |
|---------|-------|
| language | ${c.language} |
| messageFormat | \`${c.messageFormat}\` |
| directCommit | ${c.directCommit} |
| targetBranch | ${c.targetBranch} |
| ticketRequired | ${c.ticketRequired} |
| ticketPlatform | ${c.ticketPlatform} |
| platform | ${c.platform} |
| prDescriptionLanguage | ${c.prDescriptionLanguage} |
| coAuthoredBy | ${typeof c.coAuthoredBy === "string" ? c.coAuthoredBy : c.coAuthoredBy} |
| branchFormat | \`${c.branchFormat}\` |
| prReady | ${c.prReady} |`;

  return `# Commit Changes

Unified, self-contained commit command — config-driven, no external dependencies.

## Project: ${context.project}
## Git Root: ${gitRoot}

${configBlock}

## Flow

### Step 1: Quality Gate ${c.prReady ? "(ENABLED)" : "(SKIPPED — prReady is false)"}

${c.prReady ? `Run the full quality pipeline:
1. Identify changed files: \`git diff --name-only\` + \`git diff --name-only --staged\`
2. Detect project type from files (package.json → Node/Angular, *.csproj → .NET, Cargo.toml → Rust, pubspec.yaml → Flutter)
3. Run tests:
   - Node/Angular: \`npm test -- --watch=false\`
   - .NET: \`dotnet test\`
   - Rust: \`cargo test\`
   - Flutter: \`flutter test\`
4. Check test coverage for changed files, write missing tests
5. Code review: check for DRY violations, naming, error handling, magic values, OWASP Top 10
6. Fix all issues found (CRITICAL through LOW)
7. Re-run tests after fixes
8. Run build (\`npm run build\` / \`dotnet build\` / \`cargo build\` / \`flutter build\`)
9. Run formatter (\`prettier\` / \`dotnet format\` / \`cargo fmt\` / \`dart format\`)

Do NOT ask for feedback during this phase — just execute end to end.` : "Quality gate is disabled. Skip directly to Step 2."}

### Step 2: Inspect Changes

1. Run \`git status\` and \`git diff\` to see what's staged and unstaged
2. Review the conversation history to understand what was accomplished

### Step 3: Plan Commits

1. Group related changes into logical commits
2. Draft commit messages using this format: \`${c.messageFormat}\`
   - Use imperative mood
   - Focus on "why" not "what"
   - Infer component from changed files
${c.language === "de" ? "3. Write commit messages in German" : "3. Write commit messages in English"}

### Step 4: Present Plan & Get Confirmation

Show file groupings and commit messages. Ask: "Shall I proceed?"

### Step 5: Execute

${c.directCommit ? `**Direct commit mode:**
1. Stage specific files (NEVER use \`git add -A\` or \`git add .\`)
2. Create commit(s) with message format: \`${c.messageFormat}\`
${typeof c.coAuthoredBy === "string" ? `3. Add co-authored-by trailer: \`Co-Authored-By: ${c.coAuthoredBy}\`` : c.coAuthoredBy ? "3. Add co-authored-by trailer" : "3. Do NOT add any co-authored-by or Claude attribution"}
4. Done.` : `**Branch + PR mode:**
1. Ask for branch type (\`feat\`/\`bug\`/\`hotfix\`/\`chore\`)
${c.ticketRequired ? "2. Ask for ticket ID (REQUIRED)" : "2. Ask for ticket ID (optional)"}
3. Ask for short description (kebab-case)
4. \`git fetch origin\` + \`git checkout ${c.targetBranch}\` + \`git pull\`
5. Create branch: \`${c.branchFormat}\`
6. Stage specific files, commit with format: \`${c.messageFormat}\`
${typeof c.coAuthoredBy === "string" ? `7. Add co-authored-by trailer: \`Co-Authored-By: ${c.coAuthoredBy}\`` : c.coAuthoredBy ? "7. Add co-authored-by trailer" : "7. Do NOT add any co-authored-by or Claude attribution"}
8. \`git push -u origin \${branch}\`
${c.platform === "azure-devops" ? `9. Create PR with Azure DevOps CLI:
   \`\`\`bash
   az repos pr create --source-branch \${branch} --target-branch ${c.targetBranch} --title "\${title}" --description "\${body}"
   \`\`\`
   - PR description in **${c.prDescriptionLanguage === "de" ? "German" : "English"}**
   - If ticket provided: \`az repos pr work-item add --id \${prId} --work-items \${ticket}\`
   - Open in browser: \`az repos pr show --id \${prId} --open\`` : c.platform === "github" ? `9. Create PR with GitHub CLI:
   \`\`\`bash
   gh pr create --base ${c.targetBranch} --head \${branch} --title "\${title}" --body "\${body}"
   \`\`\`
   - PR description in **${c.prDescriptionLanguage === "de" ? "German" : "English"}**
   - Open in browser: \`gh pr view --web\`` : "9. No PR creation (platform is none)"}`}

### Step 6: Report

- Show \`git log --oneline\` for the new commits
- ${typeof c.coAuthoredBy === "string" || c.coAuthoredBy ? "" : "NEVER add \"Generated with Claude\" or co-author lines"}

## Important
- Stage specific files only — NEVER \`git add -A\` or \`git add .\`
- Commits should look like the user wrote them (unless coAuthoredBy is configured)
- Group related changes, keep commits focused and atomic
- You have full context of what was done in this session
`;
}

import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildInitPrompt(_args: string, _config: WorkflowConfig, context: SkillContext): string {
  const gitRoot = context.gitRoot ?? context.cwd;

  return `# Generate Project Workflow Config

You are generating a \`.pi/workflow.json\` configuration file for the project **${context.project}** by analyzing its git history and structure.

## Target File

Write to: \`${gitRoot}/.pi/workflow.json\`

## Detection Steps

Run these commands to gather data, then analyze the results:

### 1. Remote URL
\`\`\`bash
git -C "${gitRoot}" remote get-url origin 2>/dev/null || echo "no-remote"
\`\`\`
- Contains \`dev.azure.com\` or \`visualstudio.com\` → \`platform: "azure-devops"\`, \`ticketPlatform: "azure-devops"\`
- Contains \`github.com\` → \`platform: "github"\`
- No remote or other → \`platform: "none"\`

### 2. Branch Naming
\`\`\`bash
git -C "${gitRoot}" branch -a --format='%(refname:short)' | head -50
\`\`\`
- Look for patterns like \`feat/12345-...\`, \`bug/...\`, \`feature/...\`
- Extract \`branchFormat\` from the most common pattern
- If branches have ticket IDs → \`ticketRequired: true\`

### 3. Commit Messages
\`\`\`bash
git -C "${gitRoot}" log --oneline -50
\`\`\`
- Detect format: \`#12345 type(component): desc\` vs \`type(component): desc\` vs freeform
- Extract \`messageFormat\` from the most common pattern
- Check for \`Co-Authored-By\` trailers → \`coAuthoredBy\`

### 4. Target Branch
\`\`\`bash
git -C "${gitRoot}" branch -a
\`\`\`
- Has \`dev\` → \`targetBranch: "dev"\`
- Has \`development\` → \`targetBranch: "development"\`
- Has \`main\` only → \`targetBranch: "main"\`

### 5. PR Description Language
\`\`\`bash
git -C "${gitRoot}" log --format=%B -20
\`\`\`
- Scan for German keywords (\`Zusammenfassung\`, \`Testplan\`, \`Änderungen\`) → \`prDescriptionLanguage: "de"\`
- Otherwise → \`prDescriptionLanguage: "en"\`

### 6. Direct Commit Check
\`\`\`bash
git -C "${gitRoot}" log --oneline -20 --first-parent
\`\`\`
- If most commits are directly on main/dev (no merge commits, no branches) → \`directCommit: true\`

### 7. Project Type
Check for \`package.json\`, \`Cargo.toml\`, \`*.csproj\`, \`pubspec.yaml\`, etc. in \`${gitRoot}\`
- Determines which test/build/format commands are relevant for \`prReady\` config

## Config Schema

\`\`\`json
{
  "commit": {
    "language": "en | de",
    "messageFormat": "template with \${ticket}, \${type}, \${component}, \${description}",
    "directCommit": false,
    "targetBranch": "dev",
    "ticketRequired": false,
    "ticketPlatform": "azure-devops | linear | github | none",
    "platform": "azure-devops | github | none",
    "prDescriptionLanguage": "en | de",
    "coAuthoredBy": false,
    "branchFormat": "\${type}/\${ticket}-\${description}",
    "prReady": true
  },
  "vault": "~/dev/codelayer-vault"
}
\`\`\`

Only include fields that differ from these defaults:
- \`language\`: \`"en"\`
- \`messageFormat\`: \`"\${type}(\${component}): \${description}"\`
- \`directCommit\`: \`true\`
- \`targetBranch\`: \`"main"\`
- \`ticketRequired\`: \`false\`
- \`ticketPlatform\`: \`"none"\`
- \`platform\`: \`"none"\`
- \`prDescriptionLanguage\`: \`"en"\`
- \`coAuthoredBy\`: \`false\`
- \`branchFormat\`: \`"\${type}/\${ticket}-\${description}"\`
- \`prReady\`: \`false\`

## Output Format

After running all detection steps, present your findings like this:

\`\`\`
Detected config for ${context.project}:

  platform:              [value]  (reason)
  targetBranch:          [value]  (reason)
  ticketRequired:        [value]  (reason)
  messageFormat:         [value]  (matches N% of commits)
  branchFormat:          [value]  (matches N% of branches)
  prDescriptionLanguage: [value]  (reason)
  directCommit:          [value]  (reason)
  coAuthoredBy:          [value]  (reason)
  prReady:               [value]  (reason)

Write to ${gitRoot}/.pi/workflow.json? [Y/n]
\`\`\`

Wait for user confirmation before writing the file.

When writing, create the \`.pi\` directory if it doesn't exist (\`mkdir -p ${gitRoot}/.pi\`), then write the JSON config with only non-default values. Use 2-space indentation.

## Important
- This is a DETECTION tool — analyze what exists, don't invent conventions
- When uncertain, note the uncertainty in the reason
- Omit fields that match the defaults to keep the config minimal
- The vault path should always be \`"~/dev/codelayer-vault"\` unless the user says otherwise
`;
}

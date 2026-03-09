import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildSketchPrompt(args: string, config: WorkflowConfig, context: SkillContext): string {
  const vault = config.vault;
  const project = context.project;

  return `# Quick Sketch

Create visual designs, wireframes, and UI mockups.

- **Web/mobile UI**: Use Pencil (.pen files)
- **Terminal UIs (TUIs)**: Use TUI Studio + ASCII wireframes

## Project: ${project}
## Vault: ${vault}/${project}/

## Request

${args ? `Design: ${args}` : "Ask the user what they'd like to sketch."}

## Process

### Step 0: Route by Type

**If the design is a TUI** (terminal app, CLI tool, Bubble Tea, terminal dashboard):
→ Skip to TUI section below.

**Otherwise** (web, mobile, dashboard, component library):
→ Continue with Pencil workflow.

### Step 1: Parse the Request

1. Identify what to design: UI screens, components, layouts, flows
2. Check for an existing .pen file path in the input
3. Check for file references to use as context

### Step 2: Determine Output Location

- If a path was provided: use it directly
- If in a git repo with a vault task: \`${vault}/${project}/TASKNAME/sketch-DESCRIPTION.pen\`
- Otherwise: \`./sketches/DESCRIPTION.pen\` in current directory

Create the output directory if needed.

### Step 3: Create the .pen File

1. Write \`{}\` as initial content (Pencil requires pre-created files)
2. Gather context files to attach (components, screenshots, plan markdown)

### Step 4: Write Pencil Agent Config

Write to \`/tmp/pencil-config.json\`:
\`\`\`json
[
  {
    "file": "ABSOLUTE_PATH_TO_PEN_FILE",
    "prompt": "DETAILED_DESIGN_PROMPT",
    "model": "claude-4.6-opus",
    "attachments": ["OPTIONAL_CONTEXT_FILES"]
  }
]
\`\`\`

Prompt crafting guidelines:
- Be specific about layout: grid, sidebar, stack, centered
- Describe component hierarchy and relationships
- Mention design system if the project uses one
- Include color scheme/theming context
- Describe key states: default, hover, active, loading, empty, error

### Step 5: Launch Pencil

\`\`\`bash
pencil --agent-config /tmp/pencil-config.json
\`\`\`

If \`pencil\` is not found: "Install Pencil from https://pencil.dev to generate visual sketches. The empty .pen file has been created and is ready."

### Step 6: Open & Report

1. Open: \`open PATH_TO_PEN_FILE\`
2. Report where file was created and whether Pencil launched successfully

## TUI Design with TUI Studio

For terminal UIs, use **TUI Studio** instead of Pencil.

1. Open TUI Studio: \`open -a "TUI Studio"\`
2. Describe the design in detail (layout, components, panes, keybindings)
3. Provide ASCII wireframes of each screen — these are the authoritative mockups
4. Write the design spec to \`${vault}/${project}/TASKNAME/design.md\`

## Tips
- For iterating on existing sketches, provide the .pen file path
- Attach plan files for context when sketching planned features
- Multiple .pen files can be created for multi-screen flows
`;
}

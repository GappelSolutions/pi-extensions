import type { WorkflowConfig } from "../index.js";

interface SkillContext {
  cwd: string;
  gitRoot: string | null;
  project: string;
}

export function buildResearchPrompt(args: string, config: WorkflowConfig, context: SkillContext): string {
  const vault = config.vault;
  const project = context.project;

  return `# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer questions by documenting what exists.

## Project: ${project}
## Vault: ${vault}/${project}/

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless explicitly asked
- DO NOT perform root cause analysis unless explicitly asked
- DO NOT propose future enhancements unless explicitly asked
- DO NOT critique the implementation or identify problems
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Research Query

${args ? `The user wants to research: ${args}` : "Ask the user what they'd like to research."}

## Steps

1. **Read any directly mentioned files first** — read them FULLY (no limit/offset)

2. **Analyze and decompose the research question:**
   - Break down the query into composable research areas
   - Think deeply about patterns, connections, and architectural implications
   - Identify specific components, patterns, or concepts to investigate

3. **Research comprehensively:**
   - Use \`grep\`, \`find\`, and file reads to explore the codebase
   - Search for relevant files, trace data flow, identify conventions
   - Look for integration points and dependencies
   - Find specific file:line references for all findings

4. **Gather metadata:**
   - Run: \`git rev-parse HEAD\` for commit hash
   - Run: \`git branch --show-current\` for branch
   - Get current date/time

5. **Write research document** to:
   \`${vault}/${project}/TASKNAME/YYYY-MM-DD-HHmm-research.md\`

   Where TASKNAME is a kebab-case directory name derived from the research topic.
   Create the directory if needed: \`mkdir -p ${vault}/${project}/TASKNAME\`

   Use this structure:
   \`\`\`markdown
   ---
   date: [ISO datetime with timezone]
   git_commit: [commit hash]
   branch: [branch name]
   repository: ${project}
   topic: "[research question]"
   tags: [research, codebase, relevant-component-names]
   status: complete
   ---

   # Research: [Topic]

   **Date**: [datetime]
   **Git Commit**: [hash]
   **Branch**: [branch]

   ## Research Question
   [Original query]

   ## Summary
   [High-level documentation of findings]

   ## Detailed Findings

   ### [Component/Area 1]
   - Description of what exists (file:line references)
   - How it connects to other components
   - Current implementation details

   ### [Component/Area 2]
   ...

   ## Code References
   - \`path/to/file.py:123\` - Description
   - \`another/file.ts:45-67\` - Description

   ## Architecture Documentation
   [Patterns, conventions, design implementations found]

   ## Open Questions
   [Areas needing further investigation]
   \`\`\`

6. **Present findings** — concise summary with key file references

7. **Handle follow-ups** — if asked, append to the same document with a new section:
   \`## Follow-up Research [timestamp]\`

## Important
- Document what IS, not what SHOULD BE
- Include specific file paths and line numbers
- Research documents should be self-contained
- Keep focus on documenting, not evaluating
`;
}

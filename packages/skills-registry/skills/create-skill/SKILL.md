---
name: create-skill
target: both
description: Create, validate, and install custom local skills. Use when you need to create a new skill (or update an existing skill) that extends agent capabilities with specialized knowledge, workflows, or tool integrations. Also use when asked to add a reusable capability that should persist across sessions.
---

# Creating Skills

Skills are modular packages that extend agent capabilities with specialized knowledge, workflows, and tools. They transform a general-purpose agent into a specialist equipped with procedural knowledge no model fully possesses.

## What Skills Provide

1. **Specialized workflows** — multi-step procedures for specific domains
2. **Tool integrations** — instructions for working with APIs or file formats
3. **Domain expertise** — company-specific knowledge, schemas, business logic
4. **Bundled resources** — scripts, references, and assets for repetitive tasks

## Core Principles

**Concise is key.** The context window is shared. Only add what the agent doesn't already know. Prefer concise examples over verbose explanations.

**Set appropriate degrees of freedom:**

- **High freedom** (text instructions): when multiple approaches are valid
- **Medium freedom** (pseudocode/scripts with params): when a preferred pattern exists
- **Low freedom** (exact scripts): when operations are fragile or consistency is critical

**Progressive disclosure.** Skills load in three levels:

1. Metadata (name + description) — always in context (~100 words)
2. SKILL.md body — loaded when skill triggers (<500 lines)
3. Bundled resources — loaded as needed (unlimited)

## Skill Anatomy

```
skill-name/
├── SKILL.md              # Required — entry point with YAML frontmatter
├── scripts/              # Optional — executable code (Python/Bash)
├── references/           # Optional — docs loaded into context as needed
└── assets/               # Optional — templates, images, fonts for output
```

### SKILL.md

- **Frontmatter** (YAML): `name` and `description` are required. Only these two fields determine when the skill triggers — make the description comprehensive about when to use it.
- **Body** (Markdown): Instructions and guidance. Only loaded after triggering.

### Bundled Resources

- **`scripts/`**: Deterministic code that would otherwise be rewritten each time. Token efficient — can be executed without loading into context.
- **`references/`**: Documentation loaded on demand. Keeps SKILL.md lean. For large files (>10k words), include grep patterns in SKILL.md.
- **`assets/`**: Files used in output (templates, images, fonts). Not loaded into context.

**Avoid duplication** between SKILL.md and reference files. Keep only essential workflow instructions in SKILL.md; move detailed reference material to `references/`.

## Creation Process

### Step 1: Understand the Use Cases

Clarify concrete examples of how the skill will be used:

- What triggers it? What would a user say?
- What functionality should it support?
- What's the expected output?

### Step 2: Plan Reusable Contents

For each use case, identify what would help when repeating the workflow:

- Scripts that would otherwise be rewritten each time
- Reference docs (schemas, API docs) that would need rediscovery
- Assets (templates, boilerplate) that stay consistent

### Step 3: Initialize

A skill you write belongs to you: it lives in your own agent folder, syncs, and
travels when you are shared or installed elsewhere. Your `your-folder` system
prompt names the path. Scaffold it there:

```bash
mkdir -p <your folder>/.agents/skills && cd <your folder>/.agents/skills
bunx skills init <skill-name>
```

This creates `<skill-name>/SKILL.md` with a template. Edit it to fill in the
content. For a fuller scaffold with example resource directories:

```bash
python scripts/init_skill.py <skill-name> --path <your folder>/.agents/skills
```

Write a skill for the whole workspace under the drive root's `.agents/skills`
instead — every agent in the workspace loads it — and only when the user asks
for that.

### Step 4: Write the Skill

**Frontmatter rules:**

- `name`: kebab-case, max 64 chars
- `description`: max 1024 chars, no angle brackets. Include ALL "when to use" info here — the body only loads after triggering.

**Body guidelines:**

- Use imperative form
- Keep under 500 lines — split to reference files if longer
- Include exact commands, code snippets, and examples
- Reference bundled files with clear descriptions of when to read them

**Design patterns for content organization:**

- **Multi-step processes**: See `references/workflows.md`
- **Output format/quality standards**: See `references/output-patterns.md`

### Step 5: Validate

Run the validation script to check the skill structure:

```bash
python scripts/quick_validate.py <your folder>/.agents/skills/<skill-name>
```

Checks: frontmatter format, naming conventions, description length, allowed properties.

### Step 6: Verify It Loads

Written in place, the file *is* the installation — there is nothing to
register. Confirm the next session will see it:

```bash
duet skills
```

Report the skill as ready only once it appears there, with `"scope": "project"`
and a path inside your folder. `"scope": "user"` means a machine-level copy,
which neither syncs nor travels with you.

**Never hand-write into `~/.agents/skills` or `~/.claude/skills`.** Those are
managed link farms and edits there are repaired away. A skill that genuinely
belongs to the machine rather than to you is installed with
`bunx skills add <path> -g -y`, and only when the user asks for that.

### Step 7: Iterate

Use the skill on real tasks, notice struggles, update SKILL.md or resources, and test again.

## Managing Skills

```bash
duet skills                       # What this session actually loads, with paths
bunx skills remove <name> -y      # Remove one from the folder you run it in
```

Deleting the skill's folder removes a hand-written one.

## What NOT to Include

Do not create extraneous files: README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, etc. A skill should only contain what the agent needs to do the job.

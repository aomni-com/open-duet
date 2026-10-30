---
name: add-skill
target: both
description: Add, install, or edit agent skills from external sources — GitHub repos, URLs, or webpages. Use when the user asks to add a skill from GitHub, install a skill from a URL or webpage, import an external skill, edit or update an existing installed skill, modify a skill's SKILL.md or resources, or customize an installed skill.
---

# Add & Edit Skills

Add skills from a source the user names — a GitHub repo, a URL, a webpage — or
edit skills already installed.

## Install into your own folder

A skill installed for you belongs to you: it lives in your agent folder, syncs,
and travels when you are shared or installed elsewhere. Your `your-folder`
system prompt names the path — `<your folder>/.agents/skills/<name>/SKILL.md`.

Install from your own folder, so the install is project-scoped:

```bash
cd <your folder>
bunx skills add owner/repo -y --copy --agent universal
```

- `--copy` writes real files rather than symlinks into a home directory, which
  is what makes the skill survive a sync to another device.
- `--agent universal` writes the one `.agents/skills` copy Duet loads, instead
  of a duplicate per coding tool.
- `-s, --skill <name>` picks one skill out of a multi-skill repo; `-l` lists
  what a repo offers without installing.

The source can be a GitHub shorthand (`owner/repo`), a full GitHub URL, a URL
to a subdirectory (`.../tree/main/skills/<name>`), or a local path.

**`-g` is not the default.** It installs into this machine's home, where the
skill is shared with every agent on this VM, does not sync, does not travel
when you are shared, and disappears with the machine. Use it only when the user
asks for exactly that. Skills under the drive root's `.agents/skills` are the
middle ground: workspace-wide and still synced.

Never hand-write into `~/.agents/skills` or `~/.claude/skills` — those are
managed link farms, and edits there are repaired away.

## Verify what you actually loaded

```bash
duet skills
```

Report the skill as installed only once it appears there. A skill of your own
reads `"scope": "project"` with a path inside your folder; `"scope": "user"` is
a machine-level copy, which is the wrong answer unless the user asked for it.

## Turning a webpage into a skill

When the user gives a URL to a page rather than a repo:

1. **Fetch the content** with `curl`, Firecrawl, or the browser.
2. **Extract** the purpose, workflows, commands, and reference material.
3. **Write it** to `<your folder>/.agents/skills/<name>/SKILL.md`, following the
   frontmatter and body rules in the `create-skill` skill. There is nothing to
   register — the file is the installation.
4. **Validate** before reporting it:

```bash
python ~/.duet/skills/create-skill/scripts/quick_validate.py <your folder>/.agents/skills/<name>
```

## Editing an installed skill

Find which copy you are about to edit — `duet skills` prints the path of every
one, and a name can exist at more than one scope:

- inside your folder (`"scope": "project"`) — yours, edit freely
- under the drive root — the workspace's, so the edit changes it for every
  agent; say so before making it
- `"scope": "user"` — a machine-level copy, including Duet's own built-ins

Edit `SKILL.md` for instructions, `scripts/` for executable code, `references/`
for docs loaded on demand, `assets/` for templates. Validate after editing:

```bash
python ~/.duet/skills/create-skill/scripts/quick_validate.py <path from duet skills>
```

Validation checks: SKILL.md exists with valid YAML frontmatter; `name` is
kebab-case, max 64 chars; `description` is a string, max 1024 chars, no angle
brackets; only `name`, `description`, `license`, `allowed-tools`, `metadata`,
and `compatibility` are allowed.

To customize a built-in rather than fork the world, copy it into your own
folder and edit that copy — project scope shadows a same-named machine skill.

## Removing

```bash
bunx skills remove <name> -y          # from the folder you run it in
bunx skills remove <name> -g -y       # from this machine
```

A skill you wrote by hand is removed by deleting its folder.

## Troubleshooting

- **Not triggering after install?** The `description` is the only thing read
  when deciding to load a skill — make it cover the user's likely phrasing.
- **Not listed by `duet skills`?** Check you installed from your own folder,
  not from somewhere else the session had wandered to.
- **Too large?** Keep SKILL.md under 500 lines; move detail into `references/`
  and point at it.

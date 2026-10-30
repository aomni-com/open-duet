# Lander messaging archive — captured 2026-08-14

Verbatim copy from every lander deleted in the 2026-08 lander reset, plus the
current main-lander messaging. This is the raw material for the messaging
iteration: we start over from here and end with **one main lander + 3–5
campaign landers with precise messaging**, each linking to a campaign we can
tag through onboarding.

Dynamic model list `PUBLIC_FRONTIER_MODELS` resolved at capture time to:
Claude Fable 5.1, Claude Opus 5, Kimi K3, GPT-5.6 Sol.

## Inventory

| Route | Status after reset | Angle |
|---|---|---|
| `/` (en) | kept, renders agent-drive lander for now | agent team + shared workspace |
| `/lp/agent-drive` | deleted (alias of `/`) | agent team + shared workspace |
| `/lp/ai-employee` | deleted | AI employee, paid search |
| `/grow` | deleted | done-for-you growth/ads |
| `/scale-your-expertise` | deleted | package & resell expertise |
| `/headless-agents` | deleted | agent infra for builders |
| `/summer-of-tokens` (+`/apply`) | deleted | founder cohort program |
| `/from/reddit/*` (10 pages) | deleted | reddit ad pain-point variants |
| `/agent-cloud`, `/app-hosting`, `/file-sharing` | kept (SEO feature landers) | — |
| `/for/*`, `/use-cases/*`, `/vs/*` | kept (SEO trees) — untouched | — |

---

# Main lander: `/` (en) — the agent-drive lander

Also served at `/lp/agent-drive` (deleted alias). Robots on the alias:
noindex, follow.

## Metadata
- **Title:** Duet — An AI agent team that knows your business
- **Description:** Generalists like Claude and ChatGPT answer questions. Duet gives you a team of specialist AI agents that runs your business.
- **OG description (differs):** One drive every agent on your team can mount. Shared memory, self-organizing pipelines, and hosting for whatever your agents build.

## Hero *(full-viewport video hero; sticky frosted nav)*
- **Announcement chip** *(links to Decibel funding announcement)*: We raised **$4.5M** to build the workspace every agent works from
- **H1:** An AI agent team that knows *your business*
- **Subhead:** Generalists like Claude and ChatGPT answer questions. Duet gives you a team of specialist AI agents that runs your business.
- **CTA:** Start free *(→ product sign-in, source `lp-agent-drive`; homepage uses source `landing-main`)*

## Section: The problem *(animated "silo shelf" of 5 agent cards)*
- **Eyebrow:** The problem
- **Title:** Your team has ten AI agents that don't talk to each other.
- **Intro:** Every seat is its own silo. One teammate's agent learns the pricing rules, the brand voice, the customer history — and the agent at the next desk knows none of it. The work doesn't compound. It evaporates, seat by seat.
- **Silo cards:** Claude — knows: pricing rules · Codex — knows: brand voice · Cursor — knows: launch plan · Grok — knows: Q3 numbers · Zed — knows: customer history
- **Kicker:** Same company. Five versions of the truth. Zero shared memory.

## Section: Why a team, not one agent
- **H2:** One general agent tries to do everything. Your specialist team knows your business.
- **Body 1:** We train specialist AI agents on your company's goals, workflows, data, and decisions. Each one owns a job while sharing the context the whole team has learned.
- **Body 2:** That focus means better work, delivered faster and at lower cost than a general agent that starts every task without context.
- **Card 1 — One general agent / Broad, but context-free:** It switches between every role and has to rediscover your company whenever the job changes.
- **Card 2 — Your Duet team / Focused, with context:** Every specialist owns a role, works from shared company knowledge, and brings the right context to every task.

## Section: What the workspace does *(bento grid, 5 animated vignettes)*
- **Title:** Not storage. A place where work compounds.
- **One memory, every agent** — The workspace holds shared memory alongside your files. What one agent learns — your brand voice, pricing rules, customer history — every agent on the team knows the next time it wakes up.
- **A workspace that works on itself** — Pipelines keep the workspace alive: auto-organize what agents drop in, pull fresh data from the web on a schedule, roll up reports overnight. Dropbox stores files. Your workspace does the work.
- **Any agent can connect** — Claude Cowork, Codex, OpenClaw, a script — anything that can read and write files can work in the workspace. Connect it in one line. No framework to adopt, no integration to build. *(terminal vignette: `$ duet connect acme/workspace` → "✓ connected — shared memory online")*
- **Hosts what your agents build** — Dashboards, internal tools, one-pagers — anything an agent builds in the workspace can be served at a real URL. The workspace is where agent work lives, not just where it gets parked.
- **Every frontier model, picked per task** — Duet's own agents run on the whole frontier — Claude Fable 5.1, Claude Opus 5, Kimi K3, GPT-5.6 Sol — and route each task to whichever one is best at it, re-deciding as the work changes. You pick a quality level, not a model name, and pay one flat rate whichever model answers.

## Section: Make it yours *(shared TrainSection — survives, also used by kept feature landers)*
- **Title:** Everyone gets the same AI. *You train yours.*
- **Intro:** Point it at how you actually work, and it stops answering like a stranger.
- **Feed chips:** your files · your tone · your tools · your data · your memory · your workflows
- **Facet notes:**
  - files: Reads straight from your docs — the Acme thread, the pricing deck — instead of starting from a blank page.
  - tone: Writes the way you write: your phrasing and rhythm, none of the corporate filler.
  - tools: Knows the tools you live in, so its answer lands where the work already happens.
  - data: Reaches into your live data for real specifics, not a hedged, generic guess.
  - memory: Remembers your past sessions and decisions, so it picks up where you left off instead of starting cold.
  - workflows: Learns the plays you run and walks them end to end, so the repeatable work just happens.

## Section: Realtime collaboration *(live demo doc with roaming cursors)*
- **Title:** Agents and people, writing in the same doc.
- **Intro:** Docs in the workspace are live. Your agents draft, edit, and comment alongside your team in real time — a research agent fills in the findings, a writing agent tightens the draft, you accept or reject the changes. Every edit is signed, human or agent.
- **Bullets:** Co-edit live — named cursors for every agent and teammate. · Agents can propose changes as suggestions you approve with one click. · A doc doubles as a task board — agents claim work and hand off to each other.

## Section: For companies *(share-cascade diagram)*
- **Title:** Enterprise AI rollout, shaped like a folder.
- **Intro:** Create a company folder, share it with your employees, and every one of their agents inherits the same context, rules, and memory. Data governance rides the same flow as normal file sharing — no new mental model, no rollout project.
- **Bullets:** Company folders with per-team access — agents and people follow the same rules. · Shared memory scoped to the folder, so context stays where it belongs. · Works alongside the Claude and Codex seats your company already pays for.
- **Caption:** Share once — every seat's agent inherits the same context and rules.

## Trust line
- Trusted by teams at **growing** companies

## FAQ — "Questions teams ask first."
1. **My team already pays for Claude seats. Why do we need this?** — That is exactly who this is for. Each Claude seat is brilliant and amnesiac — what one teammate's agent learns, the others never see. The workspace is the shared layer underneath: every agent reads from it, writes to it, and remembers through it.
2. **How is this different from Dropbox or Google Drive?** — Those store your files and wait. A Duet workspace works: it keeps shared agent memory next to your files, runs pipelines that organize and refresh data on a schedule, and hosts what your agents build at real URLs. Storage is the substrate — the work layer is the product.
3. **Which agents can use it?** — Any of them. Claude, Codex, Duet's own agents, or your own scripts — if it can read and write files, it can work in the workspace. There is no proprietary framework and no per-agent integration to build.
4. **Which AI models does Duet run on?** — All the best ones — Claude Fable 5.1, Claude Opus 5, Kimi K3, GPT-5.6 Sol — and you never have to choose between them. Duet routes every task to the model that is strongest at it and re-decides as the work changes: a deep refactor, a long call transcript, and a quick draft do not all need the same model. You pick a quality level, not a model name, and the rate is flat whichever model answers.
5. **Does this replace the AI tools my team already uses?** — No — it connects them. Your team keeps the agents they love. The workspace is what the company buys around them so their work adds up instead of evaporating per seat.
6. **How does sharing work for a company?** — Like file sharing, because it is file sharing. Create a folder, share it with your team, and every employee's agent gets the same context with the same access rules. Enterprise data sharing rides the flow people already understand.
7. **Is my data private?** — Every workspace runs in your own dedicated environment with its own memory and files. Your data is not pooled with other customers, and you control which agents and people can reach each folder.

## Final CTA *(email capture over animated mesh gradient)*
- **Eyebrow:** One workspace for every agent on your team
- **H2:** Give your agents one place to work.
- **Subhead:** Create a workspace, point your agents at it, and watch ten silos become one team.
- **Tagline:** Dropbox syncs your files. Duet syncs your AI.
- **Email capture:** `user@example.invalid` · **Get early access** · success: **You're on the list — we'll be in touch soon.** *(then offers Calendly booking)*
- **Trust bullets:** Free to start · No credit card · Works with any agent

---

# `/lp/ai-employee` — paid-search lander (deleted)

## Metadata
- **Title:** Duet — The AI Employee That Runs Your Business
- **Description:** Duet is an AI employee that does the work, not just chat. It runs your business 24/7 on your own cloud server — bookkeeping, outbound, support, reporting — with no code. Start free.
- **OG description:** An AI coworker that actually does the work and runs 24/7 on your own cloud server. No code. Start free.

## Hero
- **Eyebrow:** The AI employee for your business
- **H1:** Hire an AI coworker that *actually does the work.*
- **Subhead:** Duet is an AI agent that runs your business 24/7 on your own cloud server — bookkeeping, outbound, support, reporting and more. It does the job end to end, not just chat. No code.
- **CTA:** Start free *(source `lp-ai-employee`)* · **Trust line:** Free to start. No credit card required.

## Value props
- **It does the work, not just chat** — Duet takes the whole job end to end — drafts the email and sends it, builds the report and ships it. A coworker that finishes tasks, not a chatbot that answers questions.
- **Runs 24/7 on your own cloud server** — Every workspace gets its own always-on cloud server with persistent memory and files. Work keeps running while you sleep — no laptop open, no babysitting.
- **No code, set up in minutes** — Describe the work in plain English. No automations to wire, no scripts to maintain. You are running your first task minutes after you sign up.

## How it works — "From sign-up to done in three steps."
- **01 — Tell it what you need done:** Describe a job the way you would brief a new hire — "reconcile last month's books", "follow up with every inbound lead". Plain English, no setup.
- **02 — It does the work on your server:** Duet connects your tools, does the task on its own cloud server, and remembers context across runs so it gets sharper every time.
- **03 — Review, approve, repeat:** See exactly what it did, approve anything that leaves your workspace, and put recurring work on a schedule so it just keeps happening.

## What it runs for you — "Real jobs, handed off for good."
- Jobs: Bookkeeping · Sales outbound · Customer support · Reporting · Inbox triage · SEO & content *(linked to `/use-cases/by-job/*`)*

## FAQ — "Questions operators ask first."
1. **What does an AI employee actually do?** — Duet handles real operational work — bookkeeping, sales outbound, customer support replies, reporting, inbox triage, SEO and content. You brief it like a teammate and it does the task end to end, not just suggest answers.
2. **Is it really no-code?** — Yes. You describe what you want in plain English. There are no flows to build or scripts to maintain — most people run their first real task within minutes of signing up.
3. **What does it cost? Is there a free start?** — You can start for free, no credit card required. Paid plans add more usage and capacity as you hand off more work.
4. **Is my data private?** — Every workspace runs on its own dedicated cloud server with its own memory and files. Your data and your agent's work stay in your own environment, not pooled with everyone else.
5. **How is this different from ChatGPT?** — ChatGPT answers in a chat window and forgets when you close the tab. Duet is a coworker on an always-on server: it actually does the work, runs 24/7, remembers context, and can operate on a schedule without you in the loop.
6. **How fast can I get set up?** — Minutes. Sign up, describe a job, and Duet starts working. No onboarding project, no implementation team.

## Final CTA
- **H2:** Put your first AI employee to work today.
- **Subhead:** Set it up in minutes. Hand off the work that has been piling up and watch it get done.
- **CTA:** Start free · **Trust bullets:** Free to start · No credit card · Set up in minutes

---

# `/summer-of-tokens` (+ `/apply`) — cohort program (deleted)

## Metadata
- **Title:** Summer of Tokens — Build an agent business with Duet
- **Description:** Ten founders. One month. $500 in frontier credits each. Build an agent that runs a real business — yours or your clients'. We fund your first client, concierge onboarding, and a platform that runs what you build. Apply now.

## Hero *(full-bleed beach-mascot illustration, light-only)*
- **Eyebrow:** Duet presents · build an agent business this summer
- **H1:** Summer of **Tokens**
- **Subhead:** Every business wants AI. Almost none know how to implement it. That's your business.
- **Second line:** We fund your first client
- **CTA:** Apply now · **Microcopy:** Apply by July 1

## Stats band *(die-cut ticket card)*
- **10** Founders selected · **$500** Frontier credits for each founder · **Jul 4-Aug 4** Build sprint timeline · **$1,000** Prize credits for winners

## The program
- **H2:** Build your agent business. We'll fund your first client.
- **Intro:** Ten entrepreneurs. One funded month. Build an agent that runs a real business — yours or your clients'. Walk away with a live agent, your first client, and a path to revenue.
- **A month of frontier AI, funded** — Each founder gets $500 in frontier model credits — Claude Opus, GPT-5.5, and more. Enough to build and run real client agents, not just tinker. Think a month of Claude Max, except you also get a cloud workspace that builds AND runs your stuff.
- **A real build sprint: July 4 to August 4** — One focused month to take your agent from an empty workspace to a live business. Your agent works on its own cloud server, day and night, while you steer. Build it once and it keeps running — for you or your clients.
- **Freedom from babysitting your tools** — Call it Independence Day for founders: describe the work, your agent runs it on a schedule, and you go touch grass. Build it once, and it keeps running without you — for you or your clients.
- **Storefront day and a prize pool** — We close with a storefront day where the cohort pitches their agent business — what they built, who they're selling to, and what they'd need to scale. The top two or three founders win $1,000 in Duet credits to keep building.

## Our promise *(handwritten quote card)*
> Tokens shouldn't be the thing standing between you and the business you want to build. So this summer, we're covering them. Ten founders, a month of runway, and a workspace that doesn't just help you build — it runs what you build while you're at the beach. We'll be in it with you the whole month. The best part? You walk away with an agent you can sell.
> — Example User — Founder and CEO, Duet

## Final CTA *(beach-bike photo)*
- **H2:** Spend your summer building a business, not babysitting tools.
- **Subhead:** Ten spots. One month. $500 in frontier credits, concierge onboarding, and a platform that runs what you build. Tell us what you'd build and claim yours.
- **Check bullets:** $500 in frontier credits · July 4 to August 4 · Storefront day + $1,000 prize

## `/summer-of-tokens/apply`
- **H1:** Apply for **Summer of Tokens** · **Subhead:** Ten founders. One funded month. Tell us what agent you'll build, who you'd sell it to, and how it keeps running once the month is over.
- Form sections: Who you are (name, email, Duet account email, LinkedIn, social, country, timezone) · What you will build and sell (what agent, who buys it, own business vs clients, "How will it keep running after the month? This is how we judge winners", portfolio link) · Building in public (weekly posting commitment, audience size, recent post link) · Commitment (hours/week, storefront day attendance)
- Success: **Application received.** — We review every one. Watch your inbox.

---

# `/from/reddit/*` — 10 reddit ad landers (deleted)

All rendered one shared template (`RedditLandingPage`), robots noindex+nofollow,
CTA → product sign-in with `?from=reddit-<slug>`.

**Shared template copy:** paired layout section heading "Your problem. *Duet's fix.*" (eyebrow "Problem → fix", pain cards labeled "The snag"); stacked layout headings "Sound *familiar?*" (eyebrow "The problem") and "What changes *with Duet*" (eyebrow "The fix"). Trust strip: "1 minute to set up" · "First agent running in 2" · "7-day free trial". Hero footnote "No credit card required"; final-CTA footnote "No credit card required. Works with Claude and Codex."

## `/from/reddit/rate-limits` — Claude Max subscribers hitting rate limits
- **Headline:** You pay $200/month for Claude. **You still get rate limited.**
- **Subheadline:** Duet runs Claude Code and Codex straight on the API — so you can run as many agents as you want, as long as you want, without a single "try again in 4 hours."
- **Pain points:** (1) You pay $200/month for Claude Max. Two hours into real Claude Code work, you hit the limit — and spend the rest of the day waiting. (2) You try to run three agents in parallel. One goes, two sit in a queue. Your "unlimited" plan has very real ceilings. (3) One big task burns your whole daily allowance. Nothing left for the afternoon. You're paying for potential you can't actually use.
- **Fixes:** **Run all day, every day** — Duet is on the API, not a consumer plan. No daily caps, no 4-hour lockouts. Your agents run as long as the work takes — at 2pm and at 2am. · **Ten agents at once, no queue** — Spin up 3, 5, 10 agents and they all run in parallel. Refactor in one, write tests in another, draft docs in a third. Nothing waits in line. · **Know what your plan is using** — Monthly credits and reserve overage stay visible in your dashboard. Choose the plan for your normal month, then let manual or automatic topups handle a shipping sprint.
- **Final CTA:** Your agents, finally uncapped. · Button: Hire your first agent

## `/from/reddit/laptop-lid` — CLI-agent users whose sessions die on sleep
- **Headline:** Your agent shouldn't die **when you close your laptop.**
- **Subheadline:** Duet runs your agents on a persistent cloud server — not your laptop. Close the lid, kick off work overnight, pick up from your phone. The work keeps going whether you're at your desk or not.
- **Pain points:** (1) You're 45 minutes into a complex task. Your laptop goes to sleep, the session dies, and the context is gone. Start over. (2) You kick off a long-running job before bed and wake up to a dead terminal and zero progress — because it was running on your machine. (3) So you SSH into a VPS to keep things alive. Now you're babysitting infrastructure instead of shipping.
- **Fixes:** **Runs on a server, not your laptop** — Every Duet workspace lives on its own always-on cloud machine. Close the lid, lose your wifi, reboot your laptop — your agent keeps working. No SSH, no VPS, no Docker to babysit. · **Kick off work, then walk away** — Start a long task and leave. Agents run overnight and on a schedule, then ping you when they're done. Your progress stops depending on your screen staying open. · **Pick up from any device** — Start on your laptop, check from your phone on the train, finish from another machine. Same session, same context, always exactly where you left it.
- **Final CTA:** Your work shouldn't stop when you do. · Button: Hire your first agent

## `/from/reddit/multi-model` — Claude vs Codex debate threads
- **Headline:** Not Claude OR Codex. **Claude AND Codex. In one workspace.**
- **Subheadline:** Duet runs Claude Code and Codex on the same persistent server. Use Claude for complex reasoning. Switch to Codex when you're hitting limits. Zero context lost.
- **Pain points:** (1) Claude Code is better at reasoning. Codex doesn't rate limit. You shouldn't have to choose — but you're forced to. (2) You switch models mid-task and lose all your context. Now you spend 10 minutes re-explaining the codebase to a fresh session. (3) You run Claude for architecture, Codex for execution, and something else for docs. Three tools, three setups, three monthly subscriptions.
- **Fixes:** **Switch models, keep context** — Start with Claude Code for architecture. Switch to Codex for parallel execution. Your full conversation history and codebase context carries over. · **No rate limits on either model** — Duet connects to both via API. When Claude hits limits, Codex keeps running. You're never blocked waiting for one model to reset. · **One persistent workspace** — All your agents, all your models, one place. No switching between tools. No re-uploading context. Just ship.
- **Final CTA:** The best AI coding setup uses both models. · Button: Hire your first agent

## `/from/reddit/small-team` — tiny startup teams needing leverage
- **Headline:** Three people. Six agents. **The output of twenty.**
- **Subheadline:** Duet agents don't just answer questions — they do the work. Research, code reviews, the morning report, the internal tool you keep meaning to build. Your headcount stays at three. Your output doesn't.
- **Pain points:** (1) You're the founder, the PM, the engineer, and the QA team. The work that actually matters keeps slipping, because there are only so many hours in your day. (2) You tried Claude or ChatGPT, but it's single-player and forgets everything. Every task starts from scratch, and your cofounder can't see what it did. (3) Hiring would help — but you're not ready to add $150K of headcount for work that's really only twenty hours a week.
- **Fixes:** **Agents that finish the job** — Hand an agent a real task — "pull our churn numbers and draft the update" — and it runs the whole thing, not just the first reply. Specialized, persistent, and sharper every time you use it. · **Your whole team, one workspace** — Everyone sees every agent run. No shared logins, no "what did the AI say?" in Slack. Assign work to a person or an agent from the exact same place. · **Leverage, not headcount** — Agents cost a few dollars a run, not a salary — and they keep working after you close your laptop. Spin up a research analyst, an ops manager, and a junior dev without adding a seat.
- **Final CTA:** Stay lean. Ship like a giant. · Button: Hire your first agent

## `/from/reddit/shared-login` — teams sharing one ChatGPT login
- **Headline:** Your best hire is an AI agent. **Now they work alongside your team.**
- **Subheadline:** Durable AI sessions, visible event history, shared files, and finished outputs—all in one workspace for your team.
- **Pain points:** (1) Your AI tools live in one app. Your work lives in another. Every output is a copy-paste away from being lost or out of date. (2) Your team shares a single ChatGPT login. Nobody knows who ran what, prompts get overwritten, and nothing carries between teammates. (3) Agents do the work, then a human has to chase down what happened, what's left, and who owns the next step. The handoff is the bottleneck.
- **Fixes:** **Agents work where your team works** — Assign tasks to a human or an AI agent from the same interface. Duet handles the handoff automatically. · **Full visibility into what agents are doing** — No black boxes. Watch agents work, review their outputs, and step in whenever you want. · **Mix and match for any workflow** — Some tasks are better handled by people. Some by AI. Duet lets you split work intelligently and keep everything in sync.
- **Final CTA:** People and agents. Same workspace. · Button: See how it works

## `/from/reddit/agency-scale` — agency operators with fragmented stacks
- **Headline:** Your entire growth stack. **One place to run it.**
- **Subheadline:** Duet gives your team a single workspace to manage projects, run AI agents, monitor campaigns, and ship work without switching between 12 different tabs.
- **Pain points:** (1) Your agency runs on Notion, Slack, Asana, ClickUp, Airtable, and 6 client portals. Half your day is finding the thing instead of doing the thing. (2) Agents your team uses are scattered across 4 different apps. Nobody knows what's running, what just broke, or who owns the output. (3) Every new client = a new tool stack. Your team onboards into a different system every Monday and never gets fast at any of them.
- **Fixes:** **One dashboard, zero context switching** — See every project, task, agent output, and team update in a single unified view. No more hunting across tools. · **Real-time control over every moving part** — Trigger actions, review outputs, reassign tasks, and course-correct, all from the same screen where you started. · **Built for how teams actually work** — Duet structures work around your workflows, not the other way around. Customize views, permissions, and pipelines to match your team.
- **Final CTA:** One workspace. Every client. · Button: Get early access

## `/from/reddit/build-run` — AI-app-builder users with stale one-shot builds
- **Headline:** Built an app with AI. **It keeps running it.**
- **Subheadline:** Describe what your team needs. Duet builds it, then keeps it going — checking your data, updating your dashboards, alerting you when something changes. Every day, automatically.
- **Pain points:** (1) You used an AI app builder to create a dashboard. It worked once. Now the data is stale and nobody maintains it. (2) You pay for 6 SaaS tools that each do one thing. You still copy-paste between them. None of them do exactly what you need. (3) You're the founder and the ops team. Every manual process costs you hours — but building automations is a project in itself.
- **Fixes:** **Internal tools, built in minutes** — Describe what you need — a competitor tracker, a daily report, a lead monitor. Duet builds it. No developers. No setup guides. Just working software. · **It runs itself. Forever.** — Your tools run on a schedule — every morning, every hour, whatever you set. Data stays fresh. Reports get delivered. You never have to check in. · **Stop buying SaaS. Build what you need.** — Why pay $200/month for a tool that does 80% of what you want? Duet builds exactly what your team needs and runs it for a fraction of the cost.
- **Final CTA:** Internal tools that run themselves. · Button: Hire your first agent

## `/from/reddit/d2c-content` — solo D2C founders drowning in content
- **Headline:** You run the store. **We'll run the software.**
- **Subheadline:** You handle the hard parts — product, brand, customers. Duet handles the soft parts: the software, the content, the AI. One idea becomes Reels, posts, blogs, and landing pages, posted across every channel — on autopilot.
- **Pain points:** (1) You're the founder, the buyer, and the support team. Somehow you're also supposed to pump out Reels, TikToks, and emails every single day. (2) An agency wants $5K a month and three days for one video. Freelancers ghost. Either way, content never ships as fast as your store needs it. (3) Even when a piece is done, you're still the one resizing it, captioning it, and posting it to five channels at the right time.
- **Fixes:** **Every format, from one idea** — Hand Duet a product or a hook. It writes the script, generates the images, edits the video, and drafts the blog — Reels, TikToks, posts, and landing pages, all from a single brief. · **An agency's output, minus the retainer** — Duet uses the best model for each step — Claude and GPT for copy, GPT Image and Gemini for visuals, Seedance and Kling for video. Studio-grade content at a fraction of agency cost. · **Posted everywhere, while you sleep** — Duet formats each piece per channel and publishes on schedule — TikTok, Reels, Shorts, your blog, your store. You wake up to content already live.
- **Final CTA:** You run the store. We'll run the rest. · Button: Start your content engine — free

## `/from/reddit/fractional-engineer` — non-technical teams stuck in the eng backlog
- **Headline:** Build the internal tool your team actually needs. **In hours. Not sprints.**
- **Subheadline:** Duet gives non-technical teams a way to build internal dashboards, approval workflows, and ops tools with AI. No engineering backlog required.
- **Pain points:** (1) You filed an engineering ticket for an internal dashboard 3 months ago. It's still in the backlog. Meanwhile your team is operating on screenshots and Slack messages. (2) You can't justify hiring a full-time engineer just to build the 5 small tools your team actually needs. So they don't get built. (3) You tried a no-code builder. It was fine until you needed real logic. Now your "tool" is a Frankenstein of 12 Zaps, an Airtable, and a prayer.
- **Fixes:** **Describe it, Duet builds it** — Tell Duet what you need in plain language. It generates the logic, UI, and connections. You review and ship it. · **Pre-built templates for common ops workflows** — Onboarding flows, approval chains, reporting dashboards, content queues. Start from a template and customize in minutes. · **Connects to your existing stack** — Duet integrates with Notion, Airtable, Slack, Google Sheets, and dozens more. Your internal tool plugs into the tools your team already uses.
- **Final CTA:** Skip the engineering backlog. · Button: Build your first tool free

## `/from/reddit/internal-tools-bypass` — devs juggling multiple LLM APIs
- **Headline:** Stop picking a model. **Start picking results.**
- **Subheadline:** Duet connects to every major AI model: GPT, Claude, Gemini, Llama, and more. Route tasks to the right model automatically. No API wrangling. No vendor lock-in.
- **Pain points:** (1) You wired up three different APIs to compare models. Now you maintain three SDKs, three billing dashboards, and three sets of prompts that all drift apart. (2) You're paying GPT-4 prices for tasks a smaller model could nail. Burning budget on overkill because switching is too painful. (3) You bet on one model 6 months ago. Now a competitor is twice as good for half the price, and you have nothing to show for the migration cost.
- **Fixes:** **All your models, one interface** — Access OpenAI, Anthropic, Google, and open-source models from a single workspace. Switch or mix models per task with one click. · **Smart routing by task type** — Duet can automatically send writing tasks to one model, code to another, and analysis to a third, based on performance and cost. · **No lock-in, ever** — Your workflows, prompts, and outputs belong to you. Swap providers any time without rebuilding anything.
- **Final CTA:** Every model. One workspace. · Button: Try every model free

---

# `/grow` — GROWTH-ON-AUTOPILOT campaign (deleted)

No email ask up front: hero scans your website and drafts a growth brief live,
then asks for the email to "save a spot" in a 15-business founding cohort.

## Metadata
- **Title:** Duet — We run the ads. You run the business.
- **Description:** Type your website and watch Duet draft your growth plan — channels, budget moves, even your first ads — in about 20 seconds. Growth, handled for you.
- **OG description:** See the growth plan we'd run for your business before you give us anything — even your email. Duet plans, writes and runs your ads, so you never think about growth again.

## Hero *(website-scan console, no email first)*
- **Eyebrow:** Duet Growth — your marketing, in automatic mode
- **Headline:** We run the ads. / *You run the business.*
- **Reading line:** Duet plans **your campaigns**, writes your ads, and **moves the budget** to what works. **Type your website** and watch it draft your plan.
- Input placeholder `yourcompany.com` · button **Show me my growth plan**
- Scan stages: Reading {domain} · Working out what you sell — and who buys it · Choosing the channels worth paying for · Writing your first ads
- Scan-error fallback: "Some sites block robots or just take too long. Try another address — or leave your email and we'll draft your plan by hand and send it over." · **Send me my plan**

## Growth-brief dialog
- Byline: Growth brief · drafted in {N}s from {domain}
- Sections: Who we'd go after · The first moves · Ads we'd run this week · Live within two weeks
- Ad mocks: "{domain} · Sponsored" — "Drafts, written from {domain} — the real versions go live in your first two weeks."
- Sticky ask: **Want this plan running for real?** · 15 founding spots · button **Save my spot**
- Success: Spot held for {Company} — from here, growth is our problem, not yours.
- Fine print: Plan, ads and budget — everything handled, inside a cap you set once. Founding members lock in below launch price. No spam, unsubscribe anytime.

## Section: Automatic mode
- **Title:** Everything a growth team does. Running while you work.
- **Intro:** Most businesses know ads would work for them. They just don't have anyone to run them — so nothing runs. Duet is that someone: the planning, the writing, the launching, the daily tuning. All of it, handled — inside a monthly cap you set once.
- **Plans your growth** — A strategy grounded in what your site actually sells and who buys it — not a template. Re-drafted as real results come in.
- **Writes your ads** — Headlines, copy and creative in your voice, for each channel — written, tested and replaced without you lifting a finger.
- **Moves the budget** — Spend flows daily toward what converts — across Google, Meta, Reddit and LinkedIn — and away from what doesn't.
- **Reports in plain words** — A weekly note a busy owner actually reads: what ran, what it cost, what it brought in. No dashboard to learn.
- **CTA band:** See the plan we'd run for your business — before you give us anything. Even your email. · **Scan my website**

## FAQ — "What an owner asks before handing over the ads."
- **What does it cost?** — Your ad budget stays yours, paid straight to the channels. Duet runs on a monthly plan with included credits; paid-reserve topups cover overage during a busy campaign.
- **How much ad budget do I need?** — Your plan starts on one or two channels inside a cap you set once — enough to learn what converts, then scale what does. We never spend past your cap.
- **How much control do I keep?** — As much as you want — most owners keep none. You set a monthly cap once and Duet never spends past it; everything inside the cap is handled. If you'd rather sign off on ads or budget moves, turn approvals on and it waits for you.
- **Which channels can it run?** — Google Search, Meta, Reddit and LinkedIn at launch. Your plan says which are worth paying for first — most businesses only need two.
- **Do I need my own ad accounts?** — If you have them, we plug in and keep your history. If you don't, we set them up in your name — they're yours either way, including if you leave.
- **What if the plan is wrong?** — The scan is a first draft from your website alone. In the cohort it's rebuilt with you — your margins, your best customers, your goals — then re-tuned every week from live results.
- **Why a cohort?** — We're onboarding 15 businesses first so every account gets real attention while we sharpen the autopilot. Founding members lock in below launch price.
- **Who's behind this?** — The team behind Aomni — our AI agents already work inside 5,000+ businesses. During the first cohort you'll talk to the people building it, not a support queue.

## Closing capture
- **Title:** Growth that runs itself. Yours to keep.
- **Body:** Rather start with your email? Leave it below — we'll read your site, draft your plan by hand, and send it over. No call required.
- Button **Get my plan by email** · success: You're in — we'll reach out before the first cohort kicks off.
- Credibility: Built by the team behind Aomni — AI agents already working inside 5,000+ businesses.
- *(Deliberately omitted the shared 5,000+ trust strip — would contradict the 15-business scarcity.)*
- Footer cross-link: Sell your expertise instead? Duet for experts → `/scale-your-expertise`

---

# `/scale-your-expertise` — PACKAGE-&-RESELL campaign (deleted)

## Metadata
- **Title:** Duet — Sell what you know, not the hours you have
- **Description:** Package the work only you can do into an agent, sell it again and again, and earn past your hours. Get early access.
- **OG description:** Turn your expertise into an agent that drafts the work while you sleep — packaged once, sold a hundred times. Get early access.

## Hero *(email-capture hero)*
- **Eyebrow:** For experts with an audience — no code needed
- **Headline:** Sell what you know, / *not the hours you have.*
- **Reading line:** Teach it **your method** once. It becomes **a packaged agent** that drafts the work — then **sold to your own audience**, again and again.
- Button **Get early access** · success: You're on the list — we'll reach out before we open the first cohort.
- Trust: A first cohort of ~20 experts this quarter — founding sellers lock in our lowest fee. No spam, we never share your email, unsubscribe anytime.

## Section: The trap
- **Title:** Your calendar is your ceiling.
- **Intro:** You trade hours for money, and the hours run out. Your best clients wait weeks; the rest you turn away. Your knowledge is worth a fortune — and you can sell it only one meeting at a time. Picture a fractional CFO who packages their monthly-close review: the agent drafts each client's variance memo in their voice, they skim, approve, and send — the same expertise, delivered a hundred times over.
- **Package it once** — Teach an agent the job you could do in your sleep. It drafts the work; you approve it.
- **Sell it again and again** — The same expertise, delivered a hundred times to the audience you already have — without a hundred meetings on your calendar.
- **Serve past your calendar** — Someone three timezones ahead gets your method at their 9am — no meeting booked, no reply owed from you.
- **Your name, not the recipe** — Customers hire the result. Your method stays under the hood; your name stays on the work.
- **CTA band:** Your calendar caps your income. Your expertise shouldn't. · **Get early access**

## FAQ — "What an expert asks before putting their name on it."
- **Do I need to code?** — No. You teach it in plain language — the way you'd brief a sharp new hire, from your own method.
- **Will it sound like me?** — Yes — it learns from your writing and your examples of great vs. wrong output, so drafts land in your voice. And you sign off before anything ships, so nothing off-voice reaches a customer.
- **How long until it's ready to sell?** — Mostly the time it takes to teach it your method — a few focused sessions, not months. When the drafts consistently pass your review, it's ready.
- **Who owns what I teach it?** — You do, fully. Customers get the results, never the recipe. We never resell what you build or train shared models on it. Take it down anytime.
- **Where do customers come from?** — Day one, you sell to the audience you already have — no new distribution to figure out. The Duet marketplace, shaped with this first cohort, is upside on top.
- **What does it cost?** — Free to build. You set the price; Duet takes a cut only when it sells. Founding sellers lock in below launch price.

## Closing capture
- **Title:** You already know the work. Now sell it more than once.
- **Body:** We want to talk to a first cohort of experts before we open the doors. Leave your email and we'll be in touch.
- Footer cross-link: Build agents for clients? Duet for builders → `/headless-agents`

---

# `/headless-agents` — TECHNICAL campaign (deleted)

## Metadata
- **Title:** Duet — Headless agent infrastructure, on a backend that's yours
- **Description:** Build powerful agents for your clients on a backend of their own — deployed to infrastructure we run so you never babysit servers. Get early access.
- **OG description:** Ship agents to your clients on their own managed backend. You bring the logic; we bring the infrastructure. Get early access.

## Hero *(email-capture hero)*
- **Eyebrow:** For builders who ship agents to clients
- **Headline:** You build the agent. / *You keep the backend.*
- **Reading line:** Every client gets **a real agent**, on **its own dedicated backend**, run on **infrastructure we operate** — and yours to export anytime.
- Button **Get early access** · success: You're on the list — we'll reach out before we open the first cohort.
- Trust: We're taking a first cohort of ~15 builders this quarter. No spam, we never share your email, unsubscribe anytime.

## Section: The part that isn't the agent
- **Title:** Six months of plumbing, already built.
- **Intro:** Auth, state, storage, per-client isolation, deploys, scaling. It's the Supabase-and-a-Node-repo you'd otherwise stand up and babysit for every client — every agent product needs it, and none of it is the agent. It's built, and it comes with each client you take on.
- **Your own backend** — A dedicated database, auth, jobs, and state for each client — not multi-tenant rows behind a filter, and not a shared sandbox you rent by the token.
- **Safe to sell to serious clients** — Each client runs in an isolated backend, so you can take on regulated or competing work without architecting around a shared database.
- **Headless by design** — Your UI, your brand, your API. We're the backend; the surface your client sees is yours to build and ship.
- **Deploy and scale, handled** — You ship to infrastructure we run, patch, and scale. No servers to provision, and no on-call rotation to own.
- **CTA band:** Ship the agent. Skip the six months of plumbing. · **Get early access**

## FAQ — "What a builder asks before trusting a backend."
- **Do I have to run any servers?** — No. We provision, patch, scale, and keep it up. You get your own backend without operating one.
- **Can I use my own models and code?** — Yes. Ship your agent as a standard Node or Python container that talks to the backend over a typed API, with your own model keys. No framework to adopt, no rewrite.
- **How do I deploy it?** — Push your container; we stand up its backend — data, auth, state, jobs — and wire the endpoints. No servers to configure, no YAML to babysit.
- **Where does my clients' data live?** — Each client gets its own database instance and auth tenant — separate credentials, separate storage, no shared tenant_id column. One client's data can never reach another's.
- **What will it cost?** — Usage-based, per client backend — not seats or unpredictable tokens. We set the rate with the first cohort; founding builders lock in below launch price.
- **Is it really mine — or am I locked in?** — Your data lives in a standard Postgres database you can dump anytime, and your agent runs against an open, documented API — no proprietary runtime. Leave with your code and a full export; there's nothing to reverse-engineer.

## Closing capture
- **Title:** Build the agent. Keep the backend.
- **Body:** We're building it now, onboarding a first cohort of builders by hand. Leave your email and we'll be in touch.
- Footer cross-link: Deliver by hand, no code? Duet for experts → `/scale-your-expertise`

## Shared campaign-parts copy (deleted with these landers)
- Trust strip (scale + headless only): **Trusted by 5,000+ businesses** — logos: Stravito, Panzura, Semperis, Social+, Furiosa, Parallax
- Campaign footer: © Duet · user@example.invalid · Privacy · per-lander cross-link

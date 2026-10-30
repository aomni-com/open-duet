# Choices ledger — metered VM compute fees

Every decision made on your behalf while building this feature, re-audited
against the code that actually shipped rather than the pass that introduced it.
Ranked least-confident first: read the top three and you have seen everything
that could plausibly be wrong.

---

## Needs your call

These are product or policy decisions I could not make for you. Nothing is
blocked on them; each has a working default recorded.

### 2. The fee is labelled "VM compute"

**Why that word.** The adjacent settings surface already calls this exact
machine "VM telemetry", so "Workspace compute" would be a second name for one
thing; the row's own subline already carries the workspace name; and at 390 px
the neighbouring credit labels already truncate, which "Workspace compute" would
join and "VM compute" does not.

**Why you might disagree.** Your own product vocabulary rule says the container
is a **Workspace** and "Drive" is only the files tab. That points the other way.

**Cost to change:** one string in `en` and `es-419`.

### 3. The weekly VM snapshot cron is disabled, and should stay that way

**What it did.** Cloned every active workspace's whole VM weekly as a backup,
kept the newest, deleted the rest.

**What I found.** It never worked. `--copy-tags` is a boolean exe.dev only
accepts as `--copy-tags=false`; the client sent `--copy-tags true` as two
arguments, so exe read `true` as the positional new-name and rejected the whole
command. The account proves it: seventeen VMs, zero snapshot copies, ever.

**Why this now matters more, not less.** Someone disabled that cron during this
build, on the grounds that each workspace was carrying peer VMs. That was not
happening. But I **fixed the bug**, so re-enabling it now would start genuinely
cloning every active workspace — which is exactly the cost that comment feared.

**Decision you own:** whether workspace backups are worth roughly doubling VM
count, now that the mechanism actually functions.

---

## Worth a look

### 4. One test fixture stopped exercising the workspace-creation gate

**What I did.** The new 1/3/10 limit broke seven suites that provision more than
one workspace per user. Five were given real plan capacity, which keeps the gate
live. One — `prepareWorkspaceForRegistration` — was **bypassed outright**,
because suites built on it provision dozens of workspaces for a single actor and
no plan covers that.

**Why it might be wrong.** Bypassing is how coverage quietly gets easier. The
argument that it is safe: the limit's real coverage runs through the API path in
`auth-workspaces.test.ts` and `apps/api`, at every boundary (0/1, 2/3, 9/10,
concurrent creates, transfer-at-capacity). That fixture only touched the gate
incidentally — it exists to register VMs.

**This is the single place in the whole build where a test got easier**, which
is why it is listed above the sound entries.

### 5. The exe.dev API key is deliberately over-scoped, and never expires

**What I did.** Minted the replacement key with more commands than the code
calls today — `rename`, `comment`, `tag`, every `share` subcommand, `domain *`,
`whoami`, `ssh-key generate-api-key` — and with no expiry.

**Why.** A minimally-scoped key is exactly what caused the outage this feature
hit: the old key was fine until something needed `stat`, and then it was a
fleet-wide failure plus a re-mint. A 30-day key would have produced the same
outage on a timer.

**What I excluded, and why:** `team *` and `billing *` (account administration
and money) and `ssh-key add`/`remove` (credential lifecycle). A compromised
backend token should not be able to disband the team, change the subscription,
or mint credentials for itself.

**The trap for whoever re-mints next:** `--cmds` is **not validated** by
exe.dev. An unrecognised name is accepted silently and the key simply cannot run
it — `share` alone yields 403, because the grantable name is the full
`share set-public`. Exercise every scope on a throwaway canary; a clean mint
proves nothing.

### 6. The gap clamp is conservative on purpose, and its original justification was wrong

**What I did.** `VM_USAGE_MAX_POINT_GAP_MS = 35 minutes`. An interval longer
than that bills nothing.

**What changed.** I first justified 35 minutes as "2× the observed maximum" from
gaps of 61–1,049 s. That measurement came from probing over **SSH**, which is
not the transport production uses. Over HTTPS the cadence is a flat 600–601 s.

**Why the number stayed anyway.** A larger clamp only ever *accepts* more
intervals, so erring high costs nothing, while erring low would silently stop
billing during ordinary jitter. It only needs to stay well below a real outage.

---

## Sound

### 7. Storage is stored raw and adjusted only where it is displayed

Your call: store `fs_used_gb` exactly as the provider reports it, and subtract
the image allowance in the one projection that draws the quota bar. The
telemetry chart deliberately shows the raw figure — it answers "what is on the
disk", while the bar answers "how much of your allowance have you used". A fresh
VM reads **0**, pinned by a named test so the day the image grows past the
constant produces a failing test rather than a quietly wrong bar.

### 8. The charge reconciles servicing itself

The ledger does not reconcile servicing, and a trial's entitlement depends on
its balance staying above the $1 floor. Without an explicit reconcile after an
applied fee, a trial could drop below the floor and stay fully serviced until
some unrelated event fired. It has a named test that drains a trial to just
above the floor and watches the fee cross it.

### 11. Two slicing corrections made during the build

The plan had slice 03 delete a function while slice 05 deleted its only caller,
which would have left the build broken between them — the call site moved with
its function. And slice 07 originally claimed it *closed* the
create-and-destroy evasion; it only narrows it, because a VM emits no metrics
for its first four to five minutes. Both spec files were corrected in place
rather than shipped as written.

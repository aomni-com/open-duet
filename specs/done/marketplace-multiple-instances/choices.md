# Choices ledger

## Sound

### Numeric collision suggestions advance any trailing number

- **When:** Commit `58cd171ca` (`marketplace: project multiple installed instances`).
- **The choice:** When `Customer Portal` collides, the form proposes `Customer
  Portal 2`. If the user had already typed `Portal 2026`, it proposes `Portal 2027`.
  The user may edit that value and nothing is installed until they confirm again.
  The unbuilt alternative would remember whether every trailing number came from
  the user or from an earlier suggestion, then branch the suffix rule accordingly.
- **The gap:** The product required editable `Name 2` / `Name 3` suggestions but did
  not distinguish user-authored numbers from generated suffixes.
- **The reach:** This affects only the value prefilled after a server path collision;
  it never changes or submits an agent automatically.
- **Verdict:** **Sound.** The rare edge stays visible and reversible, so tracking
  suffix provenance would add state without protecting user data.
- **Confidence:** Medium.

### Preserve subscription query order in the instance list

- **When:** Commit `58cd171ca` (`marketplace: project multiple installed instances`).
- **The choice:** Suppose the subscription query returns the canonical Website
  Builder first and Customer Portal second. Detail keeps that order. It does not
  silently reorder them alphabetically, by health, or by path. The unbuilt
  alternative would make the marketplace own a sorting policy users never asked
  for and future code would have to preserve.
- **The gap:** The product fixed which instances belong in the list and how they are
  identified, but did not prescribe their order.
- **The reach:** Marketplace detail inherits the query's stable order. A deliberate
  product sort can be added later without first undoing a hidden client policy.
- **Verdict:** **Sound.** Preserving source order is the smallest behavior and does
  not manufacture a new product rule.
- **Confidence:** High.

### One ordinary detach transition owns the install-count decrement

- **When:** Closeout regression after commit `4dd698202`.
- **The choice:** Uninstalling a marketplace agent and deleting that installed agent
  are two doors into the same event: one live subscription becomes detached. Both
  now call `detachMarketplaceAgentSubscription`, and that transition decrements the
  listing count exactly once for a counted `subscribe` row. A one-time clone was
  never counted, and a detached row cannot decrement again. Marketplace takedown is
  the explicit exception: it zeros the public listing first, then uses a lower-level
  ownership release while draining subscriptions in bounded batches. The unbuilt
  alternative would copy counter arithmetic into every current and future caller,
  which already allowed direct agent deletion to drift from uninstall.
- **The gap:** The product required one count per live instance but did not specify
  which lifecycle function owns the decrement when several actions can detach it.
- **The reach:** Future ordinary detach paths inherit correct counting by using the
  same transition. Takedown remains visibly separate because its bounded drain has
  different public-count semantics.
- **Verdict:** **Sound.** One transition owns one invariant, while the exceptional
  takedown path stays explicit instead of being hidden behind flags.
- **Confidence:** High.

### Prefer the installed agent's slug when its display name is absent

- **When:** Commit `58cd171ca` (`marketplace: project multiple installed instances`).
- **The choice:** A subscription normally displays the joined agent's human name.
  If that name is absent, it displays the installed agent's actual workspace slug;
  only a missing agent join falls back to the publisher's listing name. For
  example, an older unnamed agent registered as `website-builder-2` remains
  recognizable as that workspace agent instead of being labeled with the
  publisher's generic `website-builder`. The unbuilt alternative would prefer the
  listing fallback even when a more specific installed row exists.
- **The gap:** Duplicate fallbacks were allowed, but the fallback priority for a
  joined unnamed agent was unspecified.
- **The reach:** Marketplace labels and ordinary Agents-map identity stay aligned
  during roster convergence and for legacy unnamed agents. Agent ID remains the
  actual identity.
- **Verdict:** **Sound.** The installed row is stronger evidence about the local
  object than publisher metadata.
- **Confidence:** High.

### Keep publisher consent across collision correction

- **When:** Commit `a355000a1` (`marketplace: install and open exact agent instances`).
- **The choice:** A user approves an unverified publisher, but the requested local
  folder collides. The form returns with an editable suggested name; confirming the
  corrected name retries without showing the same consent sheet again. Cancelling
  and starting a new install still asks normally. The unbuilt alternative would
  treat a workspace-local naming correction as if the publisher's code or requested
  capabilities had changed.
- **The gap:** The product fixed naming before consent and required explicit
  collision confirmation, but did not say whether that correction invalidates
  consent already granted in the same open ceremony.
- **The reach:** Only same-ceremony collision recovery. It does not persist consent
  across cancellation, navigation, or a later install.
- **Verdict:** **Sound.** The consented publisher payload is unchanged; repeating the
  sheet would add ceremony without adding information.
- **Confidence:** High.

### Show the derived folder without making it an editor

- **When:** Commit `a355000a1` visual review.
- **The choice:** Additional-install naming shows a labeled **Agent folder** preview
  such as `agents/customer-portal`, with enough contrast to read it, but the only
  editable field is the human name. The unbuilt alternatives were an unlabeled
  low-contrast code string or a raw path field requiring its own validation and
  support model.
- **The gap:** The product required a live derived-path preview but did not prescribe
  how to distinguish it from helper text.
- **The reach:** Initial installs remain pathless. Only Add another and collision
  recovery expose this small read-only explanation of the server collision target.
- **Verdict:** **Sound.** It explains the derived identity without turning an
  implementation detail into another user-controlled contract.
- **Confidence:** High.

### Treat an unresolved workspace role as read-only

- **When:** Commit `4dd698202` (`marketplace: present multiple installed agent instances`).
- **The choice:** Marketplace write controls appear only after the current workspace
  is positively identified as owner or editor. If identity data is still loading or
  a future role is unknown, installed rows remain readable but Install, Add another,
  and changelog acknowledgement do not briefly appear. The unbuilt alternative
  would treat every role except the explicit viewer role as writable and rely on a
  later API rejection.
- **The gap:** The product defined owner, editor, and viewer behavior but did not say
  how incomplete membership data should render during client convergence.
- **The reach:** Any future role or partially loaded identity fails closed in the
  marketplace UI. The server remains the real authorization boundary.
- **Verdict:** **Sound.** Unknown is not permission, and a positive role check avoids
  flashing an action the current identity has not established.
- **Confidence:** High.

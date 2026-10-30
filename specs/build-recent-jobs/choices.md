# Implementation choices

## Discovery and requests

### Fetch only while the modal is open

- **When:** Build Recent jobs implementation.
- **Decision:** The header shows a Recent jobs control once a default chat exists. Its list is fetched when opened and refreshed at the existing active-activity cadence. Closing the modal stops its polling. I declined an always-running request or a count on the trigger.
- **Gap:** The request did not prescribe preload, refresh cadence, or a count.
- **Rationale:** An unopened list does not need a background request. Existing session invalidation reaches this child-query cache, and polling an open list also catches work delegated elsewhere.
- **Consequence:** Opening may briefly show loading; an open modal stays current without adding idle requests for every Build view.

### Use existing short session links

- **When:** Build Recent jobs implementation.
- **Decision:** Child rows link through the existing short session address. The router reads the child's actual owner and opens its Work page. I declined requiring the modal to load an agent roster and construct an owner-specific URL.
- **Gap:** The request specified the destination, not how to resolve the assigned agent.
- **Rationale:** The existing redirect already owns session-owner resolution. Reusing it keeps cross-agent delegation independent of roster availability.
- **Consequence:** Navigation includes the existing session-resolution loading state; no parent hint is added to the URL.

## Empty owners

### Hide the trigger before the first chat exists

- **When:** Build Recent jobs implementation.
- **Decision:** A Build owner with no default chat has no Recent jobs trigger. Once its default chat exists, the control appears even if its child list is empty. I declined creating a chat just to open the list or querying with an absent parent ID.
- **Gap:** The request did not prescribe the first-use state.
- **Rationale:** Children belong to a real conversation; the existing default-chat alias supplies its ID. An owner with no conversation has nothing to query.
- **Consequence:** A newly created owner gets the control after starting its first chat; a chat without delegated work gets the ordinary empty state.

## Presentation

### Keep the quiet header control and make rows visibly navigable

- **When:** Final Build Recent jobs review.
- **Decision:** Use the existing small chat-header button and dialog. Add a trailing arrow to each job row and center the existing narrow-header icon/label pairs. I declined a new full-width jobs panel or a separate visual style.
- **Gap:** The request specified a modal, not its button styling or row affordance.
- **Rationale:** Discovery should fit beside the chat's existing Archive action. The arrows make the destination obvious, and the scoped alignment correction keeps both controls readable on mobile.
- **Consequence:** Build keeps its current layout; long lists scroll inside the modal.

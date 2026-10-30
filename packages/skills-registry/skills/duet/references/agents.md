# Other agents in the workspace

Your system prompt lists your parent and your children. Everything else about
other agents — the full list, naming one, sending one a message — is here.

Every call below needs the workspace slug. Derive it once:

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"
```

## Listing agents

```bash
curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agents" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq '.items[] | {slug, name, anchorPath}'
```

An agent's folder is its `anchorPath`. Agents whose folders sit directly under
the same parent folder as yours are your siblings; the workspace's own agent,
slug `root`, owns the drive root and is the parent of every top-level agent.
Hand work down to a child; reach a sibling only when the work belongs to no
child of yours; go to your parent to report or to ask, never to hand it a task.

## Naming an agent in a message

Write `<Agent name="…" slug="…" />`. The app renders it as a link to the agent,
so the reader can open it. It only names the agent; it sends it nothing.

## Sending an agent a message and waiting for its reply

One mechanism serves every direction: a message into the agent's home chat —
the conversation the user reads on its page. `sourceSessionId` is what tells it
who is asking; without it your message arrives unattributed and it cannot
answer you. Generate one request id and reuse it on every retry.

```bash
CLIENT_REQUEST_ID="$(bun -e 'console.log(crypto.randomUUID())')"
WAIT_PATH="/v1/ws/$WORKSPACE_SLUG/agents/<agent-slug>/sessions/default/messages/wait"
WAIT_BODY="$(mktemp)"
REQUEST_BODY="$(jq -n --arg id "$CLIENT_REQUEST_ID" --arg sid "$DUET_SESSION_ID" \
  '{prompt:"<message>",sourceSessionId:$sid,clientRequestId:$id}')"
WAIT_STATUS="$(curl -sS -o "$WAIT_BODY" -w '%{http_code}' -X POST \
  "$DUET_API_URL$WAIT_PATH" -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' -d "$REQUEST_BODY")"
while [ "$WAIT_STATUS" = 202 ] || [ "$WAIT_STATUS" = 000 ]; do # 202: deadline elapsed; 000: connection dropped. Both mean retry, identical body
  WAIT_STATUS="$(curl -sS -o "$WAIT_BODY" -w '%{http_code}' -X POST \
    "$DUET_API_URL$WAIT_PATH" -H "Authorization: Bearer $DUET_API_KEY" \
    -H 'Content-Type: application/json' -d "$REQUEST_BODY")"
done
```

A dropped connection is the same case as a 202: repeating the identical request
(same `clientRequestId`) resumes the original wait rather than starting a
second turn, and if the turn finished while you were gone, the retry returns
its terminal immediately.

**Never message the agent whose message started your turn.** It is blocked
waiting for your turn to end, so a message back to it will never be read. End
your turn by asking instead: your question resolves its wait, and the answer
arrives as your next turn. The same holds for your parent whenever its message
is what woke you.

## When it asks you something back

HTTP 200 carries a terminal. If `terminal.event.type` is `"ask"`, that agent
needs an answer from you before it can finish; what it is asking is at
`terminal.event.questions`. Answer with the SAME `sourceSessionId` attribution
and the same retry discipline:

```bash
SESSION_ID="$(jq -er .sessionId "$WAIT_BODY")"
ANSWER_ID="$(bun -e 'console.log(crypto.randomUUID())')"
ANSWER_BODY="$(jq -n --arg id "$ANSWER_ID" --arg sid "$DUET_SESSION_ID" \
  '{answer:"<your answer>",sourceSessionId:$sid,clientRequestId:$id}')"
WAIT_STATUS="$(curl -sS -o "$WAIT_BODY" -w '%{http_code}' -X POST \
  "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agent/sessions/$SESSION_ID/answer/wait" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' -d "$ANSWER_BODY")"
while [ "$WAIT_STATUS" = 202 ] || [ "$WAIT_STATUS" = 000 ]; do # same rule: retry, identical body
  WAIT_STATUS="$(curl -sS -o "$WAIT_BODY" -w '%{http_code}' -X POST \
    "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agent/sessions/$SESSION_ID/answer/wait" \
    -H "Authorization: Bearer $DUET_API_KEY" \
    -H 'Content-Type: application/json' -d "$ANSWER_BODY")"
done
```

The 200 body carries the next terminal, which may ask again. `complete` is the
end; the result is at `terminal.event.result`. Any other terminal type also ends
the wait; report it honestly rather than retrying.

## When another agent asks you to do something

Its message arrives as `<session_message … session_id="…" agent_slug="…">`, so
you always know who is asking. If you need something from that agent before you
can finish, end your turn by asking: the session that messaged you is blocked
until your turn ends, and a message back to it will never be read.


# Human identity cutover

Human keys retain their bearer hash and user identity while current membership
owns workspace access. Managed VM, App and OAuth credentials keep their existing
bindings. The [security model](../../../../../SECURITY.md) owns this policy.

The additive device-login migration expires a row when any former grant or
machine-name field is present, including an empty array or empty name. It clears
all four fields; an identity-only row is unchanged. The existing migration
component remains the sole batch and progress owner. Its local proof is in
[the additive receipt](additive-expiry-receipt.json).

## Held strict source

Deploy the additive backend and promote the new API before retiring old rows.
Run the existing human-key and device-code migrations, then verify their completed
status and refresh complete credential-free censuses in each environment. The
schema-tightening source must remain separate until those prerequisites hold:
human rows have no scopes or workspace bindings; device rows have none of the
four former fields; no retired sync credential or credential peer metadata
remains. Also require zero human rows carrying managed-only app or OAuth binding,
audience or browser-rotation metadata; the earlier grant census did not examine
those fields. A complete empty census makes a new sync-credential deletion migration
unnecessary.

The strict schema removes the human grant fields, keeps all app/OAuth/workspace
bindings and browser rotation metadata in the managed variant, and removes retired sync credentials
and their peer field. Device login stores only its approval and polling identity.
Migration handlers retain explicitly typed historical input locally so replay
does not require legacy fields in the live schema.

The shared credential-kind enum, API credential-identity adapter, file-actor
adapter, session principal/sender and rate-limit owner then remove unreachable
sync-credential branches. Independent sync-machine identity and the mirror actor
grammar remain; file activity already resolves that identity through machines.
Historical audit and analytics event labels remain historical facts.

The existing raw admin reader owns the operational census; no parallel identity
diagnostic remains solely to report that migration completed. Root owns live
migrations, refreshed censuses and deployment of this separately held source.
The [strict receipt](strict-identity-receipt.json) records local verification;
it does not certify that live prerequisites have completed.

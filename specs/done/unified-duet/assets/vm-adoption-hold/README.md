# Admission during adoption certification

First adoption certifies the target before releasing user work. The temporary
boot input `DUET_RUNTIME_ADOPTION_IN_PROGRESS=1` initializes the gateway's
existing maintenance gate, including the agent controller, synchronously before
durable-input and wake recovery can resume. It introduces no second admission
owner or credential. Agent, Train, backup and desktop admissions use that same
gate. Certification itself remains the ordinary successful-sync/uptime contract.

The migrator stops the still-held gateway after certification, removes the
temporary service drop-in, and starts it normally. Keeping the hold installed
until that stop prevents an automatic restart from opening admission early.
Durable work then resumes through the
existing recovery owner. Removing the temporary boot input in slice 10 ends this
adoption-specific behavior.

[receipt.json](receipt.json) records the narrow checks. The controlled
[startup omission](startup-red.txt.gz) proves that simply holding HTTP start
requests would miss recovery during construction. The full
[gateway test file](gateway-green.txt.gz) stayed green, and the independent
[review](review.txt.gz) also ran the new admission and related maintenance tests.
This proves the source admission contract; it does not certify a VM migration.

The [frozen adoption payload](adoption-runtime/README.md) has its own exact
native execution receipt; earlier runtime payload receipts cannot substitute
for that constructed inventory.

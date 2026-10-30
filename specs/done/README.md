# Shipped rationale

Each folder here is a feature that shipped, rewritten from a build plan into the
layer the code cannot hold: why it works this way, what must stay true, and
which alternatives were tried and rejected. The implementation remains the
source of truth for mechanics — a closed spec points into it rather than
restating it.

Read the folder whose name matches the feature you are about to touch, and read
it *before* changing that area: the invariants and dead ends are there so you
don't re-derive them or re-walk them.

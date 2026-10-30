# Admission hold choice

**Settled:** Reuse the existing maintenance gate for the first target boot and
release it through an ordinary restart after certification. New work cannot
enter the target during its recoverable adoption window, while durable pending
input and wakes remain available for the normal recovery path. One temporary
boot input supports the fleet transition and is removed after convergence;
there is no new operator endpoint or permanent maintenance service.

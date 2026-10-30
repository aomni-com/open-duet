# npm publisher ownership handoff

The repo-owned publisher now has its GitHub Actions credential. The existing
credential was encrypted inside the former repository for the new repository’s
public key; only the sealed envelope crossed the operator machine. No credential
bytes are retained in this evidence.

[The receipt](receipt.json) binds the successful workflow, destination secret
metadata, tested sealing source and cleanup. The copied workflow and Python
files are frozen one-time evidence, not another supported release mechanism.
The temporary workflow is disabled and its remote branch and encrypted artifact
are deleted. The original checkout and main branch were untouched.

The old publisher remains available until the replacement is confirmed in npm
and a clean registry install passes. A configured secret is not evidence of npm
publication permission or a shipped release.

# Emergency exception for `main`

This runbook documents an emergency exception to the repository's normal merge checks. It does not create a GitHub ruleset, grant bypass permissions, or authorize a particular emergency change.

An earlier read-only GitHub check on 2026-11-01 found `main` unprotected. A later check that day found branch protection enabled, with `build (20)`, `build (22)`, and `analyze (javascript-typescript)` required, and no repository rulesets. The protection does not enforce those checks for administrators and requires zero approving reviews. These settings can change: verify the live rules and bypass scope before relying on this runbook. The proposed `constitution.md` is not an adopted policy.

## Scope and authority

- Use the exception only for an urgent incident where waiting for the normal checks would prolong material harm, such as an active security incident or a production outage. An inconvenient or failing check alone is not an emergency.
- The owner decides whether the incident qualifies and explicitly authorizes the specific change and bypass. An agent may prepare evidence and a proposed fix, but may not authorize or execute the bypass on the owner's behalf.
- Limit the exception to the affected pull request and the minimum blocked requirements needed to respond. Do not disable protection for everyone, use force-push, delete the branch, or treat the exception as approval for unrelated deployment, data migration, or credential rotation.
- If the change cannot be made through a pull request, stop and ask the owner for a separate recovery decision; this runbook does not grant a direct-push exception.

## Configure when branch protection is adopted

If replacing or supplementing the current branch protection with a ruleset, the owner should keep normal required checks enabled and grant bypass only to the narrowest eligible owner-controlled actor that GitHub supports for the repository. Choose **For pull requests only** for that actor, rather than an unconditional or exempt bypass. This retains a pull request record and avoids granting a general direct-push path. The currently observed administrator exemption is broader than this proposed setting. Verify the effective rules and eligible actor in the repository's live settings; available roles and features depend on GitHub's configuration and plan.

GitHub documents the bypass options in [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository). Other applicable rulesets or branch protection rules can still block the pull request; investigate those rules instead of disabling them indiscriminately.

## During an incident

1. Open or identify the emergency pull request. Record the incident, why the normal path cannot wait, the exact commit SHA, the blocked checks or rules, and the smallest proposed change. Keep vulnerability details private as described in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability).
2. Run the checks that are available and relevant to the change. Record passing, failing, and unavailable checks separately, with links to their results. State the risk of every check that could not pass; do not describe an unrun check as passed.
3. Record the owner's explicit approval of that pull request and exception in an appropriate durable record. Use a private security advisory or another owner-controlled private record if a public pull request would disclose a vulnerability or sensitive data. Never record credentials, tokens, page contents, or customer data.
4. The owner uses the configured pull-request-only bypass, if available, and records the resulting merge SHA and time. If the owner is unavailable, authorization is unclear, or the configured rules do not permit this path, stop and escalate to the owner.

## After the bypass

As soon as the incident is contained:

1. Run the skipped or failed checks against the merged SHA, or record why a check still cannot run. If the change is unsafe or verification fails, the owner decides whether to revert or authorize a follow-up fix.
2. Verify that the normal protection and required checks still apply to `main`; remove any temporary access granted specifically for the incident. Do not assume a successful bypass changed or restored the rules.
3. Complete the incident record with the reason, owner approval, pull request and merge SHA, checks and outcomes, bypass used, any remaining risk, and follow-up or rollback decision. Link the record to the pull request when doing so is safe.

For security vulnerabilities, follow the private reporting process in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability); do not open a public issue containing the vulnerability details.

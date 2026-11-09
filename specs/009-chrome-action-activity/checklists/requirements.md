# Requirements checklist: Chrome action activity

**Purpose**: Owner review of scope, observable behavior, privacy, and status semantics before implementation.
**Created**: 2026-11-09
**Feature**: [spec.md](../spec.md)
**Review Ownership**: Owner. No item has been reviewed yet.

## Scope and user outcomes

- [ ] CHK001 The Actions view is clearly separate from the popup's existing diagnostic log.
- [ ] CHK002 Batch groups represent only child calls that reached extension dispatch.
- [ ] CHK003 Three batch runs and four actual clicks are distinguishable without showing a planned-step manifest.
- [ ] CHK004 Retention through tab close and clearing at browser-session end match the requested lifetime.

## Status correctness

- [ ] CHK005 “Sent” is distinct from site acceptance.
- [ ] CHK006 The meanings of not_sent, partially_sent, sent, and unknown are clear and testable.
- [ ] CHK007 A multi-click operation can report a confirmed first click and a later unattempted or uncertain click without guessing.
- [ ] CHK008 Site effects are included only when the extension observed them.

## Privacy and storage

- [ ] CHK009 Hostname-only page identity is sufficient without a title or full URL.
- [ ] CHK010 The Owner accepts showing bounded element labels by default and can erase them immediately.
- [ ] CHK011 The prohibited-data list excludes form values, raw inputs, page output, URLs, and credentials.
- [ ] CHK012 A 500-event cap and visible truncation marker are sufficient.
- [ ] CHK013 Session storage is the intended lifetime and scope.

## Security and compatibility

- [ ] CHK014 Finish markers can only reach connections that received a child call for the trusted session and batch.
- [ ] CHK015 Reconnects, profile switches, concurrency, service-worker restarts, and lost finish markers have explicit behavior.
- [ ] CHK016 Mixed-version behavior is specified for the optional internal protocol message.
- [ ] CHK017 Existing popup controls and diagnostic log behavior remain compatible.

## Verification and acceptance

- [ ] CHK018 Each acceptance criterion has a corresponding focused test or isolated UI scenario.
- [ ] CHK019 The feature scope excludes commits, pushes, deploys, external services, and authenticated live-site actions.
- [ ] CHK020 The Owner has reviewed the spec and plan before code changes begin.

## Notes

- These boxes are reviewer-owned and remain unchecked until the Owner evaluates each criterion.
- Checking an item means the requirement is understood, not that implementation or CI is complete.

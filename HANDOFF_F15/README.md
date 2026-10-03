# ATLAS VPS → Claude Cloud handoff

This branch is an isolated transfer branch only. It is not production and must not be merged blindly.

## Authoritative identities

- Cloud base commit: `96cc21bae176c27de38eab0a62c66fc102831fb8`
- VPS source commit: `f15f8793e134e2e795b4aed2bb2fc77b60d60ec8`
- Expected reconstructed tree: `1c90bed24ea5e9f49e1afc48058757ab077d5c41`
- Patch SHA-256: `038e0e011c63a7613c5983fcb446285f4333dfa07e96d45d6d61bb2a687a0a66`

## Reconstruct the verified VPS tree

Do not merge this handoff branch. Fetch it only as a source of transfer files.

From the Cloud repository:

```bash
git fetch origin vps/handoff-f15
mkdir -p /tmp/atlas-vps-handoff
git show origin/vps/handoff-f15:HANDOFF_F15/atlas-96cc-tree-to-f15.patch.xz > /tmp/atlas-vps-handoff/atlas-96cc-tree-to-f15.patch.xz
echo '038e0e011c63a7613c5983fcb446285f4333dfa07e96d45d6d61bb2a687a0a66  /tmp/atlas-vps-handoff/atlas-96cc-tree-to-f15.patch.xz' | sha256sum -c -
xz -dc /tmp/atlas-vps-handoff/atlas-96cc-tree-to-f15.patch.xz > /tmp/atlas-vps-handoff/atlas-tree.patch
```

Verify the exact Cloud base exists:

```bash
git rev-parse 96cc21bae176c27de38eab0a62c66fc102831fb8
```

Then create an isolated worktree (preferred) or isolated local branch at that exact base and apply the tree patch:

```bash
git worktree add -b atlas-vps-handoff /tmp/atlas-vps-f15 96cc21bae176c27de38eab0a62c66fc102831fb8
cd /tmp/atlas-vps-f15
git apply --check --binary /tmp/atlas-vps-handoff/atlas-tree.patch
git apply --index --binary /tmp/atlas-vps-handoff/atlas-tree.patch
git write-tree
```

`git write-tree` must return exactly:

`1c90bed24ea5e9f49e1afc48058757ab077d5c41`

Stop on any mismatch. Do not resolve conflicts manually. A local reconstruction commit may be created only after the tree matches. Its commit SHA will differ from the VPS commit because the histories diverged; the tree hash above is the content authority.

## Additional verified files

Retrieve them with `git show origin/vps/handoff-f15:HANDOFF_F15/<filename>` as needed.

- `no-sourced-fact-27-redacted.json` — 27 real `NO_SOURCED_FACT` cases, literal email addresses redacted.
- `security-test-b9d941c8.patch` — validated test-only security patch reference.
- `contact-safe-6d6f660d.patch` — low-priority contact-safe patch reference.
- `continuous-fresh-INCOMPLETE.diff` — rejected/incomplete reference only; do not apply blindly.

Checksums:

- `no-sourced-fact-27-redacted.json`: `c017d5e2657d1df03e112b6807567882e4d6d105c9008267ec0ab154cafa5de2`
- `security-test-b9d941c8.patch`: `5dcf80d0bf7d40349f87cfd04f13b3d13fda1e4cb4533a44e6d154d11d413c1b`
- `contact-safe-6d6f660d.patch`: `d1d0742dd0040118d5c48e9325c999ff00820e14cfafd6fa9062171dad77e64e`
- `continuous-fresh-INCOMPLETE.diff`: `ba7a2420c2912f5a5795381e0e5fd4396230189d40259a673f8b3efe033cd6ad`

## Safety boundary

No deployment, push from Claude, live DB write, outbound change, pilot authorization, commercial send, `.env` change or Constitution change is part of this handoff.
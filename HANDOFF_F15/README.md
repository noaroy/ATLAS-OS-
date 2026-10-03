# ATLAS VPS → Claude Cloud handoff

This branch is an isolated transfer branch only. It is not production and must not be merged blindly.

## Authoritative identities

- Cloud base commit: `96cc21bae176c27de38eab0a62c66fc102831fb8`
- VPS source commit: `f15f8793e134e2e795b4aed2bb2fc77b60d60ec8`
- Expected reconstructed tree: `1c90bed24ea5e9f49e1afc48058757ab077d5c41`
- XZ patch SHA-256: `038e0e011c63a7613c5983fcb446285f4333dfa07e96d45d6d61bb2a687a0a66`

## Reconstruct the patch

From the repository root after fetching this branch:

```bash
cat HANDOFF_F15/atlas-96cc-tree-to-f15.patch.xz.b64.part* | base64 -d > /tmp/atlas-96cc-tree-to-f15.patch.xz
sha256sum /tmp/atlas-96cc-tree-to-f15.patch.xz
xz -dc /tmp/atlas-96cc-tree-to-f15.patch.xz > /tmp/atlas-tree.patch
```

The SHA-256 must match the value above.

Then create an isolated worktree or branch at the exact Cloud base and verify/apply:

```bash
git rev-parse 96cc21bae176c27de38eab0a62c66fc102831fb8
git switch -c atlas-vps-handoff 96cc21bae176c27de38eab0a62c66fc102831fb8
git apply --check --binary /tmp/atlas-tree.patch
git apply --index --binary /tmp/atlas-tree.patch
git write-tree
```

`git write-tree` must return exactly:

`1c90bed24ea5e9f49e1afc48058757ab077d5c41`

Stop on any mismatch. Do not resolve conflicts manually.

## Additional files

- `no-sourced-fact-27-redacted.json` — 27 real `NO_SOURCED_FACT` cases, literal email addresses redacted.
- `security-test-b9d941c8.patch` — validated test-only security patch reference.
- `contact-safe-6d6f660d.patch` — low-priority contact-safe patch reference.
- `continuous-fresh-INCOMPLETE.diff` — rejected/incomplete reference only; do not apply blindly.

Checksums:

- `no-sourced-fact-27-redacted.json`: `c017d5e2657d1df03e112b6807567882e4d6d105c9008267ec0ab154cafa5de2`
- `security-test-b9d941c8.patch`: `5dcf80d0bf7d40349f87cfd04f13b3d13fda1e4cb4533a44e6d154d11d413c1b`
- `contact-safe-6d6f660d.patch`: `d1d0742dd0040118d5c48e9325c999ff00820e14cfafd6fa9062171dad77e64e`
- `continuous-fresh-INCOMPLETE.diff`: `ba7a2420c2912f5a5795381e0e5fd4396230189d40259a673f8b3efe033cd6ad`

No deployment, live DB write, outbound change, pilot authorization or send is part of this handoff.
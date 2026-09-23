---
name: preview
description: Push the branch and print its Vercel preview URL with the protection bypass.
user_invocable: true
---

# /preview — show it to someone

`/preview`

Commits whatever is in the tree, pushes the branch, waits for its Vercel
preview deployment and prints the URL. No PR, no tracker write, no checks.

## Phase 1: commit and push

```bash
BRANCH=$(git branch --show-current)
if [ -z "$BRANCH" ]; then
  echo "Detached HEAD — no branch to push. Check one out, or run /dev to create one." >&2
  exit 1
fi
git add -A
git commit -m "wip: $BRANCH"   # skip when the tree is clean
git push -u origin HEAD
```

`HEAD`, never a hard-coded branch name: the push always targets whatever
branch is actually checked out. That still requires an actual branch —
`git push -u origin HEAD` fails on a detached checkout (there is nothing for
`HEAD` to name) — so Phase 1 stops and asks for a branch (or a run of `/dev`)
instead of attempting it. A push to `staging` is refused by `bash-guard`
gate (f) anyway. Gate (f) is NOT profile-gated — it holds on every machine.

If the commit is empty and the branch is already pushed, skip straight to
Phase 2 and print the URL for the existing deployment.

## Phase 2: wait for the deployment

```bash
SHA=$(git rev-parse HEAD)
```

Poll for the deployment of that sha until its state is `READY` (or `ERROR`,
which is a result too). Either tool works:

```bash
vercel ls --meta githubCommitSha="$SHA"
```

or the Vercel MCP `list_deployments` filtered to the project and that sha.
Poll every 10 s, give up after 10 minutes and print what the last state was —
a build that is still going is a fact worth reporting, not a failure.

On `ERROR`, print the deployment's inspect URL and the last 30 log lines and
stop. Do not try to fix the build here; that is what the session is for.

## Phase 3: print the URL with the bypass

A preview deployment sits behind Vercel Deployment Protection, so a bare URL
302s anyone who is not logged into the Vercel team — including the person you
are sending it to.

```bash
echo "${DEPLOYMENT_URL}?x-vercel-protection-bypass=${VERCEL_AUTOMATION_BYPASS_SECRET}&x-vercel-set-bypass-cookie=samesitenone"
```

`x-vercel-set-bypass-cookie=samesitenone` matters: without it the bypass
applies to that one request and every in-page navigation lands back on the
login screen.

If `VERCEL_AUTOMATION_BYPASS_SECRET` is not in the environment, print the bare
URL and say plainly that the recipient will need to be logged into the Vercel
team.

## Phase 4: report

One line: the branch, the sha, the URL. Nothing else.

## What /preview deliberately does NOT do

- No build, lint, test or Playwright run. CI owns them (spec section 7), and
  the preview deployment IS the build.
- No PR. That is `/ship`.
- No tracker write.

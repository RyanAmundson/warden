#!/bin/sh
set -u
if [ $# -ne 1 ] || ! printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "usage: npm run release -- <major.minor.patch>" >&2
  exit 2
fi
version=$1
tag=v$version
again="run npm run release -- $version again"
fail() {
  echo "release: $1 Next action: $2." >&2
  exit 2
}
root=$(git rev-parse --show-toplevel) || fail "this is not a git checkout." "run the release from the Warden checkout"
cd "$root" || exit 1
branch=$(git branch --show-current)
[ "$branch" = main ] || fail "the release runs on main, and this checkout is on ${branch:-a detached HEAD}." "run git switch main, then $again"
[ -z "$(git status --porcelain)" ] || fail "the working tree has uncommitted changes." "commit or discard them, then $again"
origin=$(git remote get-url origin) || fail "this checkout has no origin remote." "add the GitHub remote as origin, then $again"
current=$(node -p 'require("./package.json").version') || fail "node cannot read package.json." "install Node.js, then $again"

echo "release: 1/6 bump the version to $version and commit"
if [ "$current" != "$version" ]; then
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    fail "tag $tag already exists, and package.json says $current." "choose a version that has no tag, then run npm run release -- <that version>"
  fi
  npm version --no-git-tag-version "$version" >/dev/null || fail "npm version $version failed." "fix what npm names, then $again"
  node -e 'const fs = require("fs"); for (const p of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) { const m = JSON.parse(fs.readFileSync(p, "utf8")); m.version = process.argv[1]; fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n"); }' "$version" || fail "node could not write the version into the plugin manifests." "fix what node names, then $again"
  if ! git commit -q -m "Warden $version" package.json package-lock.json .claude-plugin/plugin.json .codex-plugin/plugin.json; then
    git checkout -- package.json package-lock.json .claude-plugin/plugin.json .codex-plugin/plugin.json
    fail "the pre-commit hook refused the version commit." "fix what the hook names, then $again"
  fi
fi

echo "release: 2/6 tag $tag and push main and the tag"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag "$tag" || fail "git tag $tag failed." "fix what git names, then $again"
git push -q --atomic origin main "refs/tags/$tag" || fail "the push of main and $tag was refused." "fix what git push names, then $again"

echo "release: 3/6 install the global warden from $tag"
npm install -g --loglevel=error --no-audit --no-fund "git+$origin#$tag" || fail "npm install -g of $tag failed." "fix what npm names, then $again"

echo "release: 4/6 pin Warden's pre-commit hook to $tag"
sh scripts/install-hooks.sh "$tag" || fail "install-hooks.sh $tag failed." "fix what it names, then $again"

echo "release: 5/6 recompile Warden's own lock with $version, commit, and push"
warden compile >/dev/null || fail "warden compile failed." "fix what warden compile names, then $again"
git add .warden || fail "git add .warden failed." "fix what git names, then $again"
if ! git diff --cached --quiet; then
  git commit -q -m "Warden's own lock is compiled by $version" || fail "the pre-commit hook refused the lock commit." "fix what the hook names, then $again"
fi
git push -q origin main || fail "the push of the lock commit was refused." "fix what git push names, then $again"

echo "release: 6/6 confirm warden --version"
installed=$(warden --version) || fail "warden --version failed." "fix what it names, then $again"
[ "$installed" = "$version" ] || fail "warden on PATH is $(command -v warden), which prints $installed." "put $(npm prefix -g)/bin first on PATH, then $again"
echo "release: warden $version is released, installed, and pinned"

#!/usr/bin/env bash
# Create the deterministic source archive uploaded with GitHub releases.
#
# The archive is exactly the named commit. The model-data catalog is committed
# source, so refreshing it is a separate reviewed change that must be committed
# before the commit being archived; hydrating here would have no effect.
#
# Usage:
#   ./scripts/create-source-archive.sh --version <version> --ref <git-ref> --out <archive.tar.gz>

set -euo pipefail

version=""
source_ref="HEAD"
output=""
invocation_dir="$PWD"

usage() {
    echo "Usage: $0 --version <version> [--ref <git-ref>] --out <archive.tar.gz>"
}

require_value() {
    if [[ $# -lt 2 || -z "$2" ]]; then
        echo "$1 requires a value" >&2
        usage >&2
        exit 1
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            require_value "$@"
            version="$2"
            shift 2
            ;;
        --ref)
            require_value "$@"
            source_ref="$2"
            shift 2
            ;;
        --out)
            require_value "$@"
            output="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$version" || -z "$output" ]]; then
    usage >&2
    exit 1
fi

if [[ ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
    echo "Invalid version: $version" >&2
    exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

commit="$(git rev-parse --verify --end-of-options "${source_ref}^{commit}")"

package_version="$(git show "${commit}:packages/coding-agent/package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
if [[ "$package_version" != "$version" ]]; then
    echo "Version ${version} does not match package version ${package_version} at ${source_ref}" >&2
    exit 1
fi

if [[ "$output" != /* ]]; then
    output="$invocation_dir/$output"
fi
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

temporary_archive="$(mktemp "${output}.tmp.XXXXXX")"
manifest="$(mktemp "${output}.manifest.XXXXXX")"
validation_root="$(mktemp -d "${output}.validation.XXXXXX")"
trap 'rm -f "$temporary_archive" "$manifest"; rm -rf "$validation_root"' EXIT

# Archive the resolved commit itself. The model-data catalog is committed source,
# so overlaying working-tree copies would let uncommitted bytes reach a release
# artifact that claims to be this commit.
archive_mtime="$(git show -s --format=%ct "$commit")"

archive_root="pi-${version}"
git archive --format=tar --prefix="${archive_root}/" --mtime="@${archive_mtime}" "$commit" \
    | gzip -n -9 > "$temporary_archive"
tar -tzf "$temporary_archive" > "$manifest"

required_paths=(
    "package.json"
    "package-lock.json"
    "scripts/build-binaries.sh"
    "packages/ai/src/models.generated.ts"
    "packages/ai/src/image-models.generated.ts"
    "packages/ai/src/providers/data/.manifest.json"
    "packages/coding-agent/package.json"
    "packages/coding-agent/src/utils/image-resize-worker.ts"
    "packages/coding-agent/src/core/export-html/template.css"
)

for path in "${required_paths[@]}"; do
    if ! grep -Fxq "${archive_root}/${path}" "$manifest"; then
        echo "Source archive is missing required path: $path" >&2
        exit 1
    fi
done

if ! awk -v prefix="${archive_root}/" 'index($0, prefix) != 1 { exit 1 }' "$manifest"; then
    echo "Source archive contains a path outside ${archive_root}/" >&2
    exit 1
fi

if grep -Eq '(^|/)node_modules/|(^|/)packages/coding-agent/binaries/' "$manifest"; then
    echo "Source archive contains generated dependencies or binaries" >&2
    exit 1
fi

tar -xzf "$temporary_archive" -C "$validation_root"
node "${validation_root}/${archive_root}/packages/ai/scripts/check-model-data.ts"

mv "$temporary_archive" "$output"
trap 'rm -f "$manifest"; rm -rf "$validation_root"' EXIT
printf '%s\n' "$output"

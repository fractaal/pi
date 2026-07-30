#!/usr/bin/env node
// Stage the fractal fork's four packages for publishing under the @fractaal scope.
//
// Upstream's scripts/publish.mjs publishes @earendil-works/*; this is its fork
// counterpart. It rewrites each manifest (scope, version, and the internal
// @earendil-works/* aliases) into a staging directory, then packs a tarball so the
// exact bytes can be inspected before anything immutable happens on npm.
//
// It deliberately does NOT publish. `npm publish` from a non-interactive shell hits
// EOTP/browser-auth (and has been captcha-blocked), so this prints the commands to
// run in a real terminal instead. npm versions are immutable: a bad publish burns
// the version permanently, which has already happened once (@fractaal/pi-coding-agent@0.80.2).
//
//   Usage: node scripts/publish-fractal.mjs <version>
//   e.g.:  node scripts/publish-fractal.mjs 0.83.0-fractal.1

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+-fractal\.\d+$/.test(version)) {
	console.error("usage: node scripts/publish-fractal.mjs <x.y.z-fractal.N>");
	process.exit(1);
}

// Publish order is dependency order: pi-ai, then agent-core (depends on ai), then
// tui, then coding-agent (depends on all three).
const PACKAGES = [
	{ dir: "packages/ai", name: "@fractaal/pi-ai", ship: ["dist", "README.md"] },
	{ dir: "packages/agent", name: "@fractaal/pi-agent-core", ship: ["dist", "README.md"] },
	{ dir: "packages/tui", name: "@fractaal/pi-tui", ship: ["dist", "native", "README.md"] },
	{
		dir: "packages/coding-agent",
		name: "@fractaal/pi-coding-agent",
		ship: ["dist", "docs", "examples", "CHANGELOG.md", "README.md", "containerization.md"],
		buildSignature: "fractal",
	},
];

// Upstream package name -> fork package name. Applied to dependencies so the
// published tree resolves entirely within @fractaal.
const ALIASES = {
	"@earendil-works/pi-ai": "@fractaal/pi-ai",
	"@earendil-works/pi-agent-core": "@fractaal/pi-agent-core",
	"@earendil-works/pi-tui": "@fractaal/pi-tui",
};

const stageRoot = join(repo, ".publish", version);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

const results = [];

for (const pkg of PACKAGES) {
	const source = join(repo, pkg.dir);
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	const stage = join(stageRoot, pkg.name.replace("@", "").replace("/", "-"));
	mkdirSync(stage, { recursive: true });

	// `files` may list entries that do not exist in a given build (e.g. the
	// coding-agent shrinkwrap); npm skips those silently, so mirror that here.
	const shipped = [];
	for (const entry of pkg.ship) {
		const from = join(source, entry);
		if (!existsSync(from)) continue;
		cpSync(from, join(stage, entry), { recursive: true });
		shipped.push(entry);
	}
	if (!shipped.includes("dist")) {
		console.error(`error: ${pkg.name} has no dist/ — run \`npm run build\` at the repo root first`);
		process.exit(1);
	}

	manifest.name = pkg.name;
	manifest.version = version;
	if (pkg.buildSignature) {
		manifest.piConfig = { ...(manifest.piConfig ?? {}), buildSignature: pkg.buildSignature };
	}
	for (const group of ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"]) {
		const deps = manifest[group];
		if (!deps) continue;
		for (const [dep, forkName] of Object.entries(ALIASES)) {
			// Keep the upstream key so the fork's own `import "@earendil-works/..."`
			// statements still resolve; only the resolution target changes.
			if (deps[dep] !== undefined) deps[dep] = `npm:${forkName}@${version}`;
		}
	}
	writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", stageRoot], {
		cwd: stage,
		encoding: "utf8",
	});
	if (pack.status !== 0) {
		console.error(`error: npm pack failed for ${pkg.name}\n${pack.stderr}`);
		process.exit(1);
	}
	const [packed] = JSON.parse(pack.stdout);
	results.push({ name: pkg.name, stage, tarball: join(stageRoot, packed.filename), files: packed.entryCount, size: packed.unpackedSize });
}

console.log(`\nStaged ${results.length} packages at ${version}\n`);
for (const r of results) {
	console.log(`  ${r.name.padEnd(30)} ${String(r.files).padStart(5)} files  ${(r.size / 1e6).toFixed(1)} MB`);
}

console.log(`\nRun these in a real terminal (npm publish needs interactive auth):\n`);
for (const r of results) {
	console.log(`  npm publish ${r.tarball} --access public --tag fractal`);
}
console.log(`\nThen verify:\n`);
for (const r of results) {
	console.log(`  npm view ${r.name}@${version} version`);
}
console.log();

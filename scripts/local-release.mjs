#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";
import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";

// Same list scripts/publish.mjs publishes, so the local smoke exercises exactly the package family a
// release ships. Names are read from the manifests at pack time rather than hardcoded, so this works both
// on the plain source tree and after scripts/fractal-identity.mjs has applied the published fork identity.
const packages = PUBLISHABLE_PACKAGES;

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated npm directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run npm run test:published before building
  --skip-install       Only create tarballs; do not create an isolated npm install
  --help               Show help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) throw new Error("--out requires a directory");
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) return mkdtempSync(join(tmpdir(), "pi-local-release-"));

	const outDir = resolve(options.outDir);
	if (isInsidePath(outDir, repoRoot)) throw new Error(`Output directory must be outside the repository: ${outDir}`);
	if (existsSync(outDir)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		rmSync(outDir, { force: true, recursive: true });
	}
	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function createPiShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "pi.cmd"))) {
			writeFileSync(join(installDirectory, "pi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\pi.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "pi.ps1"), '& "$PSScriptRoot/node_modules/.bin/pi.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "pi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\pi.exe" %*\r\n');
		writeFileSync(join(installDirectory, "pi.ps1"), '& "$PSScriptRoot/node_modules/.bin/pi.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "pi"), join(installDirectory, "pi"));
}

/** Verify the npm package's CLI reports its package version. */
function assertReportedVersion(label, executable, expectedVersion) {
	const reported = run(executable, ["--version"], { capture: true }).trim();
	if (reported !== expectedVersion) {
		throw new Error(`${label} reports version ${JSON.stringify(reported)}, expected exactly ${expectedVersion}`);
	}
	console.log(`  ${label} --version -> ${reported}`);
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);
if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const nodeInstallDirectory = join(outDir, "node");
mkdirSync(tarballDirectory, { recursive: true });

if (!options.skipCheck) run("npm", ["run", "check"], { cwd: repoRoot });

for (const pkg of packages) {
	run("npm", ["run", "clean"], { cwd: pkg.directory });
	run("npm", ["run", pkg.directory === "packages/ai" ? "build:offline" : "build"], { cwd: pkg.directory });
}

if (!options.skipTest) run("npm", ["run", "test:published"], { cwd: repoRoot });

const tarballs = packReleasePackages(packages, tarballDirectory);
const upstreamNames = new Map(packages.map((pkg) => [pkg.name, pkg.upstreamName]));
for (const pkg of packages) upstreamNames.set(readPackageJson(pkg.directory).name, pkg.upstreamName);

if (!options.skipInstall) {
	installCodingAgentConsumer(nodeInstallDirectory, tarballs, "npm", upstreamNames);
	smokeTestCodingAgentConsumer(nodeInstallDirectory);
	createPiShim(nodeInstallDirectory);

	const releaseVersion = readPackageJson("packages/coding-agent").version;
	assertReportedVersion(
		"npm install",
		join(nodeInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi"),
		releaseVersion,
	);
}

console.log("\nLocal npm release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nTarballs:");
for (const tarball of tarballs.values()) console.log(`  ${tarball}`);

if (!options.skipInstall) {
	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi")} --help`);
}

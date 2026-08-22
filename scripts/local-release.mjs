#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";

// Same list scripts/publish.mjs publishes, so the local smoke exercises exactly the
// package family a release ships. Names are read from the manifests at pack time
// rather than hardcoded, so this works both on the plain source tree and after
// scripts/fractal-identity.mjs has applied the published fork identity.
const packages = PUBLISHABLE_PACKAGES;

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
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
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
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

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) {
		return mkdtempSync(join(tmpdir(), "pi-local-release-"));
	}

	const outDir = resolve(options.outDir);

	if (isInsidePath(outDir, repoRoot)) {
		throw new Error(`Output directory must be outside the repository: ${outDir}`);
	}

	if (existsSync(outDir)) {
		if (!options.force) {
			throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		}
		rmSync(outDir, { force: true, recursive: true });
	}

	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	if (!commandExists("bun")) {
		throw new Error("Bun is required for the local binary release build.");
	}
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	run("./scripts/build-binaries.sh", [
		"--skip-install",
		"--skip-deps",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	]);
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = platform.startsWith("windows-") ? `pi-${platform}.zip` : `pi-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
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

function packPackage(pkg, tarballDirectory) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name && packageJson.name !== pkg.upstreamName) {
		throw new Error(
			`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name} or ${pkg.upstreamName}`,
		);
	}

	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	const packed = JSON.parse(output)[0];
	return { name: packageJson.name, tarball: join(tarballDirectory, packed.filename) };
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);

if (rootPackageJson.name !== "pi-monorepo") {
	throw new Error("Run this script from the repository root");
}

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");
const binaryDirectory = join(outDir, "bun");
mkdirSync(tarballDirectory, { recursive: true });

// Release artifacts always use a freshly generated, strictly validated catalog,
// including when checks or tests are explicitly skipped.
run("npm", ["run", "generate:models"], { cwd: repoRoot });

if (!options.skipCheck) {
	run("npm", ["run", "check"], { cwd: repoRoot });
}

for (const pkg of packages) {
	run("npm", ["run", "clean"], { cwd: pkg.directory });
	run("npm", ["run", pkg.directory === "packages/ai" ? "build:offline" : "build"], { cwd: pkg.directory });
}

if (!options.skipTest) {
	run("./test.sh", [], { cwd: repoRoot });
}

// Keyed by the name each manifest actually carries, so the isolated install
// resolves the same specifiers a consumer would after publication.
const tarballs = new Map();
// Internal dependency edges keep the upstream key and alias it to the fork package
// (`"@earendil-works/pi-ai": "npm:@fractaal/pi-ai@X"`). npm resolves that alias from
// the registry, where an unpublished version does not exist, so the isolated install
// also needs overrides under the upstream key pointing at the local tarball.
const localSpecifierNames = new Map();
for (const pkg of packages) {
	const packed = packPackage(pkg, tarballDirectory);
	tarballs.set(packed.name, packed.tarball);
	localSpecifierNames.set(packed.name, [...new Set([packed.name, pkg.upstreamName])]);
}

function installManifest(installDirectory) {
	const dependencies = Object.fromEntries(
		[...tarballs].map(([name, tarball]) => [name, fileSpecifier(installDirectory, tarball)]),
	);
	const overrides = Object.fromEntries(
		[...tarballs].flatMap(([name, tarball]) =>
			localSpecifierNames.get(name).map((alias) => [alias, fileSpecifier(installDirectory, tarball)]),
		),
	);
	return `${JSON.stringify({ private: true, dependencies, overrides }, undefined, "\t")}\n`;
}

/**
 * The published version is the exact package version. A build signature is internal
 * routing state and must never reach a product-visible version string, so assert it
 * against the real artifacts rather than trusting the constant it is derived from.
 */
function assertReportedVersion(label, executable, expectedVersion) {
	const reported = run(executable, ["--version"], { capture: true }).trim();
	if (reported !== expectedVersion) {
		throw new Error(`${label} reports version ${JSON.stringify(reported)}, expected exactly ${expectedVersion}`);
	}
	console.log(`  ${label} --version -> ${reported}`);
}

let binaryPlatform;
if (!options.skipInstall) {
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);

	mkdirSync(nodeInstallDirectory, { recursive: true });
	writeFileSync(join(nodeInstallDirectory, "package.json"), installManifest(nodeInstallDirectory));

	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: nodeInstallDirectory });
	createPiShim(nodeInstallDirectory);

	if (!options.skipBunInstall) {
		if (!commandExists("bun")) {
			throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
		}
		mkdirSync(bunInstallDirectory, { recursive: true });
		writeFileSync(join(bunInstallDirectory, "package.json"), installManifest(bunInstallDirectory));
		run("bun", ["install", "--production", "--ignore-scripts"], { cwd: bunInstallDirectory });
		createPiShim(bunInstallDirectory);
	}

	const releaseVersion = readPackageJson("packages/coding-agent").version;
	console.log("\nVerifying reported versions:");
	assertReportedVersion("node install", join(nodeInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi"), releaseVersion);
	assertReportedVersion(
		"bun binary",
		join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "pi.exe" : "pi"),
		releaseVersion,
	);
	if (!options.skipBunInstall) {
		assertReportedVersion(
			"bun install",
			join(bunInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi"),
			releaseVersion,
		);
	}
}

console.log("\nLocal release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nTarballs:");
for (const tarball of tarballs.values()) {
	console.log(`  ${tarball}`);
}

if (!options.skipInstall) {
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	console.log(`  ${join(outDir, `pi-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "pi.exe" : "pi")} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "pi.cmd" : "pi")} --help`);
	}
}

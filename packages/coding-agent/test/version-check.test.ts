import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("resolves this fork's own dist-tag instead of the upstream version api", async () => {
		vi.doMock("../src/config.ts", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/config.ts")>()),
			BUILD_SIGNATURE: "fractal",
			PACKAGE_NAME: "@fractaal/pi-coding-agent",
		}));
		const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ latest: "0.80.3", fractal: "0.83.0-fractal.2", requested: String(input) }),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.resetModules();
		const { getLatestPiRelease: forkAware } = await import("../src/utils/version-check.ts");

		// Returning the installed package name is the point: the self-update guard
		// installs unconditionally when the reported name differs, so a fork build
		// reporting upstream's name would replace itself with upstream.
		await expect(forkAware("0.83.0-fractal.1")).resolves.toEqual({
			packageName: "@fractaal/pi-coding-agent",
			version: "0.83.0-fractal.2",
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("registry.npmjs.org");
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("pi.dev");
		vi.doUnmock("../src/config.ts");
	});

	it("reports no fork update rather than falling back to upstream when the registry fails", async () => {
		vi.doMock("../src/config.ts", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/config.ts")>()),
			BUILD_SIGNATURE: "fractal",
			PACKAGE_NAME: "@fractaal/pi-coding-agent",
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request) => new Response("nope", { status: 503 })),
		);
		vi.resetModules();
		const { getLatestPiRelease: forkAware } = await import("../src/utils/version-check.ts");

		await expect(forkAware("0.83.0-fractal.1")).resolves.toBeUndefined();
		vi.doUnmock("../src/config.ts");
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

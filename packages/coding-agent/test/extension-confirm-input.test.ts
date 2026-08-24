import { beforeAll, describe, expect, it } from "vitest";
import { ExtensionConfirmInputComponent } from "../src/modes/interactive/components/extension-confirm-input.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("ExtensionConfirmInputComponent", () => {
	it("renders an opt-in Markdown body and the optional input copy", () => {
		const component = new ExtensionConfirmInputComponent(
			"Confirm Goal",
			"# Ship it\n\n- First criterion\n- `exact-token`",
			() => {},
			() => {},
			{
				messageFormat: "markdown",
				markdownTheme: getMarkdownTheme(),
				inputLabel: "Comments or reservations (optional)",
				inputPlaceholder: "Write additional comments or reservations here…",
			},
		);

		const output = component.render(72).join("\n");
		expect(output).toContain("Ship it");
		expect(output).toContain("First criterion");
		expect(output).toContain("exact-token");
		expect(output).toContain("Comments or reservations (optional)");
		expect(output).toContain("Write additional comments or reservations here…");
	});

	it("returns the optional input with a decline decision", () => {
		let result: { confirmed: boolean; input?: string } | undefined;
		const component = new ExtensionConfirmInputComponent(
			"Confirm",
			"Body",
			(value) => {
				result = value;
			},
			() => {},
		);

		component.handleInput("A reservation");
		component.handleInput("\t");
		component.handleInput("h");
		component.handleInput("\n");

		expect(result).toEqual({ confirmed: false, input: "A reservation" });
	});

	it("cancels without submitting the typed input", () => {
		let submitted = false;
		let cancelled = false;
		const component = new ExtensionConfirmInputComponent(
			"Confirm",
			"Body",
			() => {
				submitted = true;
			},
			() => {
				cancelled = true;
			},
		);

		component.handleInput("A reservation");
		component.handleInput("\u001b");

		expect(cancelled).toBe(true);
		expect(submitted).toBe(false);
	});
});

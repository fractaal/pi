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

	function dialog() {
		const submitted: Array<{ confirmed: boolean; input?: string }> = [];
		let cancelled = false;
		const component = new ExtensionConfirmInputComponent(
			"Confirm",
			"Body",
			(value) => submitted.push(value),
			() => {
				cancelled = true;
			},
		);
		const press = (...keys: string[]) => {
			for (const key of keys) component.handleInput(key);
		};
		return { submitted, press, cancelled: () => cancelled };
	}

	const ENTER = "\r";
	const TAB = "\t";
	const UP = "\u001b[A";
	const LEFT = "\u001b[D";
	const RIGHT = "\u001b[C";

	it("accepts with Enter", () => {
		const { submitted, press } = dialog();
		press(ENTER);
		expect(submitted).toEqual([{ confirmed: true }]);
	});

	it("declines when the user moves right to Decline", () => {
		const { submitted, press } = dialog();
		press(RIGHT, ENTER);
		expect(submitted).toEqual([{ confirmed: false }]);
	});

	it("returns to Accept when the user moves back left", () => {
		const { submitted, press } = dialog();
		press(RIGHT, LEFT, ENTER);
		expect(submitted).toEqual([{ confirmed: true }]);
	});

	it("does not submit when the user presses Enter after typing a reservation", () => {
		const { submitted, press } = dialog();
		press(UP, ..."nah", ENTER);
		expect(submitted).toEqual([]);
	});

	it("returns a typed reservation with the decision the user then chooses", () => {
		const { submitted, press } = dialog();
		press(TAB, ..."A reservation", ENTER, RIGHT, ENTER);
		expect(submitted).toEqual([{ confirmed: false, input: "A reservation" }]);
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

		component.handleInput("\t");
		component.handleInput("A reservation");
		component.handleInput("\u001b");

		expect(cancelled).toBe(true);
		expect(submitted).toBe(false);
	});
});

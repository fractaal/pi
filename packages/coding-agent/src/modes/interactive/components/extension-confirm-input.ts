import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIConfirmWithInputResult } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionConfirmInputOptions {
	tui?: TUI;
	timeout?: number;
	markdownTheme?: MarkdownTheme;
	messageFormat?: "plain" | "markdown";
	inputLabel?: string;
	inputPlaceholder?: string;
}

export class ExtensionConfirmInputComponent extends Container implements Focusable {
	private readonly input: Input;
	private readonly inputLabel: string | undefined;
	private readonly inputPlaceholder: string | undefined;
	private readonly messageFormat: "plain" | "markdown";
	private readonly markdownTheme: MarkdownTheme | undefined;
	private readonly onSubmitCallback: (result: ExtensionUIConfirmWithInputResult) => void;
	private readonly onCancelCallback: () => void;
	private readonly titleText: Text;
	private readonly baseTitle: string;
	private readonly choiceText: Text;
	private countdown: CountdownTimer | undefined;
	private _focused = false;
	private inputFocused = true;
	private confirmed = true;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputFocused;
	}

	constructor(
		title: string,
		message: string,
		onSubmit: (result: ExtensionUIConfirmWithInputResult) => void,
		onCancel: () => void,
		opts?: ExtensionConfirmInputOptions,
	) {
		super();
		this.baseTitle = title;
		this.messageFormat = opts?.messageFormat ?? "plain";
		this.inputLabel = opts?.inputLabel;
		this.inputPlaceholder = opts?.inputPlaceholder;
		this.markdownTheme = opts?.markdownTheme;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		if (this.messageFormat === "markdown" && this.markdownTheme) {
			this.addChild(new Markdown(message, 1, 0, this.markdownTheme));
		} else {
			this.addChild(new Text(message, 1, 0));
		}
		this.addChild(new Spacer(1));
		if (this.inputLabel) this.addChild(new Text(theme.fg("accent", this.inputLabel), 1, 0));
		if (this.inputPlaceholder) this.addChild(new Text(theme.fg("muted", this.inputPlaceholder), 1, 0));
		this.input = new Input();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.choiceText = new Text("", 1, 0);
		this.addChild(this.choiceText);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${keyHint("tui.input.submit", "submit")}  tab switch field  ${keyHint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateChoiceText();

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (keyData === "\t") {
			this.inputFocused = !this.inputFocused;
			this.input.focused = this._focused && this.inputFocused;
			this.updateChoiceText();
			return;
		}
		if (this.inputFocused) {
			if (kb.matches(keyData, "tui.input.submit") || keyData === "\n") {
				this.submit();
				return;
			}
			this.input.handleInput(keyData);
			return;
		}
		if (keyData === "\u001b[D" || keyData === "\u001b[A" || keyData === "h" || keyData === "k")
			this.confirmed = false;
		if (keyData === "\u001b[C" || keyData === "\u001b[B" || keyData === "l" || keyData === "j") this.confirmed = true;
		if (kb.matches(keyData, "tui.input.submit") || keyData === "\n") this.submit();
		this.updateChoiceText();
	}

	private submit(): void {
		const input = this.input.getValue();
		this.onSubmitCallback({ confirmed: this.confirmed, ...(input ? { input } : {}) });
	}

	private updateChoiceText(): void {
		const accept = this.confirmed ? theme.fg("accent", "→ Accept") : `  ${theme.fg("text", "Accept")}`;
		const decline = this.confirmed ? `  ${theme.fg("text", "Decline")}` : theme.fg("accent", "→ Decline");
		const field = this.inputFocused ? theme.fg("accent", "input") : theme.fg("muted", "choices");
		this.choiceText.setText(`${accept}    ${decline}    ${theme.fg("muted", `[${field}]`)}`);
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}

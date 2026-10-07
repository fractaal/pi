import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIConfirmWithInputResult } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

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
	private readonly hintText: Text;
	private countdown: CountdownTimer | undefined;
	private _focused = false;
	// The decision is the primary action; the comment is optional, so the choices start focused.
	private inputFocused = false;
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
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
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
		const enter = kb.matches(keyData, "tui.select.confirm") || keyData === "\n";
		if (this.inputFocused) {
			// Enter leaves the comment rather than submitting, so typing a reservation never accepts by accident.
			if (enter || kb.matches(keyData, "tui.input.tab") || kb.matches(keyData, "tui.select.down")) {
				this.setInputFocused(false);
				return;
			}
			this.input.handleInput(keyData);
			return;
		}
		if (enter) {
			this.submit();
			return;
		}
		if (kb.matches(keyData, "tui.input.tab") || kb.matches(keyData, "tui.select.up")) {
			this.setInputFocused(true);
			return;
		}
		// Accept is drawn first, so left selects it and right selects Decline.
		if (matchesKey(keyData, "left")) this.confirmed = true;
		else if (matchesKey(keyData, "right")) this.confirmed = false;
		this.updateChoiceText();
	}

	private setInputFocused(inputFocused: boolean): void {
		this.inputFocused = inputFocused;
		this.input.focused = this._focused && inputFocused;
		this.updateChoiceText();
	}

	private submit(): void {
		const input = this.input.getValue();
		this.onSubmitCallback({ confirmed: this.confirmed, ...(input ? { input } : {}) });
	}

	private updateChoiceText(): void {
		const option = (label: string, selected: boolean) => {
			if (!selected) return `  ${theme.fg(this.inputFocused ? "muted" : "text", label)}`;
			return this.inputFocused ? theme.fg("muted", `→ ${label}`) : theme.fg("accent", theme.bold(`→ ${label}`));
		};
		this.choiceText.setText(`${option("Accept", this.confirmed)}    ${option("Decline", !this.confirmed)}`);
		this.hintText.setText(
			this.inputFocused
				? `${keyHint("tui.select.confirm", "done")}  ${keyHint("tui.select.cancel", "cancel")}`
				: `${rawKeyHint("←→", "choose")}  ${rawKeyHint("↑", "comment")}  ${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`,
		);
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}

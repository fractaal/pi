// Session activity marks shared by sidebar rows and other plugins' entries, without the row's glyph dependencies.
import type { SidebarRow } from "./model.ts";

/** A conversation running a turn where its row has no icon: a small spinner (a still ¾ ring with reduced motion). */
export function WorkingMark() {
	return <span className="working-mark" role="img" aria-label="Working" title="Working" />;
}

/** An answer the owner has not read: a steady blue dot. */
export function UnreadMark() {
	return <span className="unread-dot" role="img" aria-label="New answer" title="New answer" />;
}

/** The Familiar's corner mark: working (the spinner), else an unread answer (the dot), else nothing. */
export function SessionDot({ worker }: { worker: SidebarRow["worker"] }) {
	if (worker.busy.length) return <WorkingMark />;
	if (worker.unread) return <UnreadMark />;
	return null;
}

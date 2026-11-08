import { MarkdownView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_VISUAL_WRITING } from "./types";
import { VisualWritingView } from "./view";

export default class VisualWritingPlugin extends Plugin {
	private ribbonIconEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		// 1. Register the Visual Writing custom view
		this.registerView(
			VIEW_TYPE_VISUAL_WRITING,
			(leaf: WorkspaceLeaf) => new VisualWritingView(leaf, this)
		);

		// 2. Register ribbon icon ('git-branch') to toggle the Visual Writing View
		this.ribbonIconEl = this.addRibbonIcon(
			"git-branch",
			"Toggle Visual Writing View",
			() => {
				void this.toggleVisualWritingView();
			}
		);
		this.ribbonIconEl.addClass("visual-writing-ribbon-icon");

		// 3. Register command: "Open Visual Writing view for active note"
		this.addCommand({
			id: "open-visual-writing-view",
			name: "Open Visual Writing view for active note",
			callback: () => {
				void this.activateViewForActiveNote();
			},
		});

		// Additional convenience command to toggle the view
		this.addCommand({
			id: "toggle-visual-writing-view",
			name: "Toggle Visual Writing view",
			callback: () => {
				void this.toggleVisualWritingView();
			},
		});

		// Command to toggle the background grid on or off
		this.addCommand({
			id: "toggle-visual-writing-grid",
			name: "Toggle Visual Writing canvas grid",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(
					VIEW_TYPE_VISUAL_WRITING
				);
				for (const leaf of leaves) {
					if (leaf.view instanceof VisualWritingView) {
						leaf.view.toggleGrid();
					}
				}
			},
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_VISUAL_WRITING);
		if (this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
	}

	/**
	 * Toggles the Visual Writing view in the right sidebar or adjacent split pane.
	 */
	async toggleVisualWritingView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_VISUAL_WRITING
		);
		if (existingLeaves.length > 0) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_VISUAL_WRITING);
			return;
		}
		await this.activateViewForActiveNote();
	}

	/**
	 * Opens or reveals the Visual Writing view and binds it to the currently active Markdown note.
	 */
	async activateViewForActiveNote(): Promise<void> {
		const { workspace } = this.app;
		const activeFile: TFile | null = workspace.getActiveFile();

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_VISUAL_WRITING);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			const activeMarkdownView = workspace.getActiveViewOfType(MarkdownView);
			if (activeMarkdownView) {
				leaf = workspace.getLeaf("split", "vertical");
			} else {
				leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			}
			await leaf.setViewState({
				type: VIEW_TYPE_VISUAL_WRITING,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);

		if (activeFile && leaf.view instanceof VisualWritingView) {
			await leaf.view.loadFile(activeFile);
		}
	}
}

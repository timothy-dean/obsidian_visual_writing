import {
	App,
	FuzzySuggestModal,
	ItemView,
	MarkdownRenderer,
	Menu,
	Notice,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import type VisualWritingPlugin from "./main";
import {
	ComputedCardLayout,
	DropPosition,
	ROOT_PARENT_ID,
	VIEW_TYPE_VISUAL_WRITING,
	VisualBlock,
} from "./types";
import {
	extractFrontmatter,
	generateBlockId,
	getBulletIndentDepth,
	getChildren,
	isBulletListBlock,
	normalizeHierarchy,
	parseMarkdown,
	serializeTree,
	stripBaseIndentation,
} from "./parser";

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
]);

const CARD_WIDTH = 340;
const COLUMN_GAP = 110;
const SIBLING_GAP = 32;
const ROOT_GAP = 48;
const DEFAULT_CARD_HEIGHT = 150;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.0;

/**
 * Fuzzy modal for picking an existing image in the Obsidian vault to embed into a card.
 */
class ImagePickerModal extends FuzzySuggestModal<TFile> {
	private onSelectCallback: (file: TFile) => void;

	constructor(app: App, onSelectCallback: (file: TFile) => void) {
		super(app);
		this.onSelectCallback = onSelectCallback;
		this.setPlaceholder("Select an image from your vault to embed...");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onSelectCallback(item);
	}
}

export class VisualWritingView extends ItemView {
	plugin: VisualWritingPlugin;
	private currentFile: TFile | null = null;
	private blocks: VisualBlock[] = [];
	private frontmatter = "";
	private editingBlockId: string | null = null;
	private focusedBlockId: string | null = null;
	private isSaving = false;
	private lastSavedSnapshot = "";

	// Canvas Pan & Zoom State
	private panX = 80;
	private panY = 80;
	private zoom = 1.0;
	private showGrid = true;
	private isPanning = false;
	private isSpacePressed = false;
	private panStartClientX = 0;
	private panStartClientY = 0;
	private panOriginX = 0;
	private panOriginY = 0;

	// Card Freeform Drag & Structural Drop State
	private draggingBlockId: string | null = null;
	private dragStartClientX = 0;
	private dragStartClientY = 0;
	private dragOriginCardX = 0;
	private dragOriginCardY = 0;
	private dragSubtreeOrigins = new Map<string, { x: number; y: number }>();
	private hoverTargetBlockId: string | null = null;
	private hoverDropPosition: DropPosition | null = null;

	// Cached card heights and layouts
	private measuredHeights = new Map<string, number>();
	private cardLayouts = new Map<string, ComputedCardLayout>();
	private cardElements = new Map<string, HTMLElement>();

	// UI containers
	private headerBarEl!: HTMLElement;
	private fileTitleEl!: HTMLElement;
	private toggleGridBtn!: HTMLButtonElement;
	private zoomReadoutBtn!: HTMLButtonElement;
	private canvasViewportEl!: HTMLElement;
	private canvasWorldEl!: HTMLElement;
	private svgLayerEl!: SVGSVGElement;
	private cardsLayerEl!: HTMLElement;

	private debouncedSave: () => void;
	private debouncedExternalRefresh: (file: TFile) => void;

	constructor(leaf: WorkspaceLeaf, plugin: VisualWritingPlugin) {
		super(leaf);
		this.plugin = plugin;

		// 400ms debounced auto-save for card text edits
		this.debouncedSave = debounce(
			() => {
				void this.saveToFile();
			},
			400,
			true
		);

		// Debounced refresh when active note is modified externally
		this.debouncedExternalRefresh = debounce(
			(file: TFile) => {
				if (
					this.currentFile &&
					file.path === this.currentFile.path &&
					!this.isSaving
				) {
					void this.reloadFromExternalModify(file);
				}
			},
			350,
			true
		);
	}

	getViewType(): string {
		return VIEW_TYPE_VISUAL_WRITING;
	}

	getDisplayText(): string {
		return this.currentFile
			? `Visual Writing: ${this.currentFile.basename}`
			: "Visual Writing";
	}

	getIcon(): string {
		return "git-branch";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("visual-writing-view");

		this.buildToolbar(container);
		this.buildCanvasStage(container);

		// Listen to active file changes in the workspace
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === "md") {
					if (!this.currentFile || this.currentFile.path !== activeFile.path) {
						void this.loadFile(activeFile);
					}
				}
			})
		);

		// Listen to external vault modifications on the active file
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					file instanceof TFile &&
					this.currentFile &&
					file.path === this.currentFile.path
				) {
					this.debouncedExternalRefresh(file);
				}
			})
		);

		// Listen to file rename or deletion
		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (
					file instanceof TFile &&
					this.currentFile &&
					file.path === this.currentFile.path
				) {
					this.updateToolbarStatus();
					(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (
					file instanceof TFile &&
					this.currentFile &&
					file.path === this.currentFile.path
				) {
					this.currentFile = null;
					this.blocks = [];
					this.editingBlockId = null;
					this.renderCanvas();
				}
			})
		);

		const initialFile = this.app.workspace.getActiveFile();
		if (initialFile && initialFile.extension === "md") {
			await this.loadFile(initialFile);
		} else {
			this.renderEmptyState("Open a Markdown note to begin visual writing.");
		}
	}

	async onClose(): Promise<void> {
		if (this.currentFile && this.blocks.length > 0) {
			await this.saveToFile();
		}
		this.contentEl.empty();
	}

	/**
	 * Public entry point so the main plugin can bind a specific file to the view.
	 */
	public async loadFile(file: TFile): Promise<void> {
		this.currentFile = file;
		this.editingBlockId = null;
		this.measuredHeights.clear();

		const rawText = await this.app.vault.read(file);
		this.lastSavedSnapshot = rawText;

		const { frontmatter } = extractFrontmatter(rawText);
		this.frontmatter = frontmatter;
		this.blocks = parseMarkdown(rawText);

		// Reset pan/zoom nicely when switching files
		this.panX = 80;
		this.panY = 80;
		this.zoom = 1.0;
		this.applyViewportTransform();

		this.updateToolbarStatus();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.renderCanvas();
	}

	private async reloadFromExternalModify(file: TFile): Promise<void> {
		const rawText = await this.app.vault.read(file);
		if (rawText === this.lastSavedSnapshot) {
			return;
		}

		const { frontmatter } = extractFrontmatter(rawText);
		const incomingBlocks = parseMarkdown(rawText);

		const activeEl = document.activeElement;
		let activeCardId: string | null = this.editingBlockId;
		let selectionStart: number | null = null;
		let selectionEnd: number | null = null;

		if (activeEl instanceof HTMLTextAreaElement && activeEl.dataset.blockId) {
			activeCardId = activeEl.dataset.blockId;
			selectionStart = activeEl.selectionStart;
			selectionEnd = activeEl.selectionEnd;
		}

		this.lastSavedSnapshot = rawText;
		this.frontmatter = frontmatter;
		this.blocks = incomingBlocks;
		this.updateToolbarStatus();
		this.renderCanvas(activeCardId ?? undefined, selectionStart, selectionEnd);
	}

	/**
	 * Atomically saves the current block tree back to the active Markdown file
	 * using `this.app.vault.process(file, (data) => ...)` as required.
	 */
	public async saveToFile(): Promise<void> {
		if (!this.currentFile) return;

		const file = this.currentFile;
		this.isSaving = true;
		try {
			await this.app.vault.process(file, (currentData) => {
				const { frontmatter } = extractFrontmatter(currentData);
				const preservedFrontmatter = frontmatter || this.frontmatter;
				const serialized = serializeTree(this.blocks, preservedFrontmatter);
				this.lastSavedSnapshot = serialized;
				return serialized;
			});
			this.updateToolbarStatus();
		} catch (err) {
			console.error("Visual Writing: Failed to save note:", err);
			new Notice("Visual Writing: Failed to save changes to file.");
		} finally {
			this.isSaving = false;
		}
	}

	private buildToolbar(container: HTMLElement): void {
		this.headerBarEl = container.createDiv({ cls: "vw-toolbar" });

		const leftGroup = this.headerBarEl.createDiv({ cls: "vw-toolbar-left" });
		const iconSpan = leftGroup.createSpan({ cls: "vw-toolbar-icon" });
		setIcon(iconSpan, "git-branch");

		this.fileTitleEl = leftGroup.createSpan({
			cls: "vw-toolbar-title",
			text: "No active note",
		});

		const rightGroup = this.headerBarEl.createDiv({ cls: "vw-toolbar-actions" });

		// Add Root Card button
		const addRootBtn = rightGroup.createEl("button", {
			cls: "vw-toolbar-btn clickable-icon",
			attr: {
				"aria-label": "Add root card",
				title: "Add root card",
			},
		});
		const addRootIcon = addRootBtn.createSpan({ cls: "vw-btn-icon" });
		setIcon(addRootIcon, "plus");
		addRootBtn.createSpan({ text: "New Card", cls: "vw-btn-label" });
		this.registerDomEvent(addRootBtn, "click", () => {
			this.addRootBlock();
		});

		// Auto-Arrange Tree button (resets custom x/y to clean left-to-right flow)
		const tidyBtn = rightGroup.createEl("button", {
			cls: "vw-toolbar-btn clickable-icon",
			attr: {
				"aria-label": "Auto-arrange cards into clean Left-to-Right tree",
				title: "Auto-arrange cards into clean Left-to-Right tree",
			},
		});
		const tidyIcon = tidyBtn.createSpan({ cls: "vw-btn-icon" });
		setIcon(tidyIcon, "layout-grid");
		tidyBtn.createSpan({ text: "Auto-Arrange", cls: "vw-btn-label" });
		this.registerDomEvent(tidyBtn, "click", () => {
			this.resetToAutoLayout();
		});

		// Toggle Grid button
		this.toggleGridBtn = rightGroup.createEl("button", {
			cls: `vw-toolbar-btn clickable-icon ${this.showGrid ? "is-active" : ""}`,
			attr: {
				"aria-label": "Toggle background grid on or off",
				title: "Toggle background grid on or off",
			},
		});
		const gridIcon = this.toggleGridBtn.createSpan({ cls: "vw-btn-icon" });
		setIcon(gridIcon, "grid");
		this.toggleGridBtn.createSpan({ text: "Grid", cls: "vw-btn-label" });
		this.registerDomEvent(this.toggleGridBtn, "click", () => {
			this.toggleGrid();
		});

		// Zoom Controls Group
		const zoomGroup = rightGroup.createDiv({ cls: "vw-zoom-controls" });

		const zoomOutBtn = zoomGroup.createEl("button", {
			cls: "vw-toolbar-btn clickable-icon",
			attr: { "aria-label": "Zoom Out", title: "Zoom Out" },
		});
		setIcon(zoomOutBtn, "minus");
		this.registerDomEvent(zoomOutBtn, "click", () => {
			this.zoomByStep(-0.15);
		});

		this.zoomReadoutBtn = zoomGroup.createEl("button", {
			cls: "vw-toolbar-btn vw-zoom-readout",
			text: "100%",
			attr: {
				"aria-label": "Reset zoom to 100%",
				title: "Click to reset zoom to 100%",
			},
		});
		this.registerDomEvent(this.zoomReadoutBtn, "click", () => {
			this.setZoomCentered(1.0);
		});

		const zoomInBtn = zoomGroup.createEl("button", {
			cls: "vw-toolbar-btn clickable-icon",
			attr: { "aria-label": "Zoom In", title: "Zoom In" },
		});
		setIcon(zoomInBtn, "plus");
		this.registerDomEvent(zoomInBtn, "click", () => {
			this.zoomByStep(0.15);
		});

		const fitViewBtn = zoomGroup.createEl("button", {
			cls: "vw-toolbar-btn clickable-icon",
			attr: {
				"aria-label": "Zoom to fit all cards",
				title: "Zoom to fit all cards",
			},
		});
		setIcon(fitViewBtn, "maximize-2");
		this.registerDomEvent(fitViewBtn, "click", () => {
			this.zoomToFit();
		});
	}

	private buildCanvasStage(container: HTMLElement): void {
		this.canvasViewportEl = container.createDiv({
			cls: "vw-canvas-viewport",
			attr: { tabindex: "0" },
		});

		this.canvasWorldEl = this.canvasViewportEl.createDiv({
			cls: "vw-canvas-world",
		});

		// SVG layer for Bezier connector curves between parent -> children and siblings
		this.svgLayerEl = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg"
		);
		this.svgLayerEl.classList.add("vw-connections-svg");
		this.canvasWorldEl.appendChild(this.svgLayerEl);

		this.cardsLayerEl = this.canvasWorldEl.createDiv({
			cls: "vw-cards-layer",
		});

		this.setupCanvasNavigation();
	}

	/**
	 * Sets up Obsidian Canvas-style navigation:
	 * - Drag canvas background (or Space+Drag, or Middle Mouse Drag) to pan
	 * - Double-click empty canvas to create a new card at that spot
	 * - Wheel to pan or zoom (Ctrl/Cmd+Wheel or plain Wheel when outside active scroll)
	 */
	private setupCanvasNavigation(): void {
		// Spacebar hold for panning cursor
		this.registerDomEvent(window, "keydown", (evt: KeyboardEvent) => {
			if (
				evt.code === "Space" &&
				!(document.activeElement instanceof HTMLTextAreaElement) &&
				!(document.activeElement instanceof HTMLInputElement)
			) {
				this.isSpacePressed = true;
				this.canvasViewportEl?.addClass("is-space-pan");
			}
		});

		this.registerDomEvent(window, "keyup", (evt: KeyboardEvent) => {
			if (evt.code === "Space") {
				this.isSpacePressed = false;
				this.canvasViewportEl?.removeClass("is-space-pan");
			}
		});

		// Panning via mouse drag on canvas background, middle-mouse, or Space+drag
		this.registerDomEvent(
			this.canvasViewportEl,
			"pointerdown",
			(evt: PointerEvent) => {
				const target = evt.target as HTMLElement;
				const isBackgroundClick =
					target === this.canvasViewportEl ||
					target === this.canvasWorldEl ||
					target === this.cardsLayerEl ||
					target instanceof SVGElement;

				const shouldStartPan =
					evt.button === 1 ||
					(evt.button === 0 && (isBackgroundClick || this.isSpacePressed));

				if (!shouldStartPan) return;

				if (isBackgroundClick && this.editingBlockId) {
					this.exitEditMode();
				}

				evt.preventDefault();
				this.isPanning = true;
				this.panStartClientX = evt.clientX;
				this.panStartClientY = evt.clientY;
				this.panOriginX = this.panX;
				this.panOriginY = this.panY;

				this.canvasViewportEl.addClass("is-panning");
				this.canvasViewportEl.setPointerCapture(evt.pointerId);
			}
		);

		this.registerDomEvent(
			this.canvasViewportEl,
			"pointermove",
			(evt: PointerEvent) => {
				if (this.isPanning) {
					const dx = evt.clientX - this.panStartClientX;
					const dy = evt.clientY - this.panStartClientY;
					this.panX = this.panOriginX + dx;
					this.panY = this.panOriginY + dy;
					this.applyViewportTransform();
				}
			}
		);

		this.registerDomEvent(
			this.canvasViewportEl,
			"pointerup",
			(evt: PointerEvent) => {
				if (this.isPanning) {
					this.isPanning = false;
					this.canvasViewportEl.removeClass("is-panning");
					if (this.canvasViewportEl.hasPointerCapture(evt.pointerId)) {
						this.canvasViewportEl.releasePointerCapture(evt.pointerId);
					}
				}
			}
		);

		// Double-click empty canvas to create a new root card right at that canvas coordinate
		this.registerDomEvent(
			this.canvasViewportEl,
			"dblclick",
			(evt: MouseEvent) => {
				const target = evt.target as HTMLElement;
				const isBackground =
					target === this.canvasViewportEl ||
					target === this.canvasWorldEl ||
					target === this.cardsLayerEl ||
					target instanceof SVGElement;
				if (!isBackground || !this.currentFile) return;

				const worldPt = this.screenToWorld(evt.clientX, evt.clientY);
				this.addRootBlock(
					Math.round(worldPt.x - CARD_WIDTH / 2),
					Math.round(worldPt.y - 40)
				);
			}
		);

		// Wheel zoom & pan (like Obsidian Canvas)
		this.registerDomEvent(
			this.canvasViewportEl,
			"wheel",
			(evt: WheelEvent) => {
				// If user is scrolling inside an active textarea that overflows, let it scroll unless Ctrl/Meta is held
				const target = evt.target as HTMLElement | null;
				if (
					!evt.ctrlKey &&
					!evt.metaKey &&
					target instanceof HTMLTextAreaElement &&
					target.scrollHeight > target.clientHeight
				) {
					return;
				}

				evt.preventDefault();

				// Ctrl/Cmd + wheel or pinch-to-zoom zooms at pointer; Shift+wheel pans horizontally; plain wheel zooms or pans
				if (evt.ctrlKey || evt.metaKey || evt.deltaMode === 0) {
					// If trackpad two-finger pan (deltaX != 0 and no ctrlKey), pan smoothly
					if (!evt.ctrlKey && !evt.metaKey && Math.abs(evt.deltaX) > 0) {
						this.panX -= evt.deltaX;
						this.panY -= evt.deltaY;
						this.applyViewportTransform();
						return;
					}

					// Wheel zoom centered at mouse cursor
					const zoomFactor = evt.deltaY < 0 ? 1.1 : 0.9;
					this.zoomAtScreenPoint(
						this.zoom * zoomFactor,
						evt.clientX,
						evt.clientY
					);
				} else {
					this.panX -= evt.deltaX;
					this.panY -= evt.deltaY;
					this.applyViewportTransform();
				}
			},
			{ passive: false }
		);
	}

	private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this.canvasViewportEl.getBoundingClientRect();
		const localX = clientX - rect.left;
		const localY = clientY - rect.top;
		return {
			x: (localX - this.panX) / this.zoom,
			y: (localY - this.panY) / this.zoom,
		};
	}

	private zoomByStep(delta: number): void {
		this.setZoomCentered(this.zoom + delta);
	}

	private setZoomCentered(targetZoom: number): void {
		const rect = this.canvasViewportEl.getBoundingClientRect();
		const centerX = rect.left + rect.width / 2;
		const centerY = rect.top + rect.height / 2;
		this.zoomAtScreenPoint(targetZoom, centerX, centerY);
	}

	private zoomAtScreenPoint(
		targetZoom: number,
		clientX: number,
		clientY: number
	): void {
		const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
		const rect = this.canvasViewportEl.getBoundingClientRect();
		const mouseX = clientX - rect.left;
		const mouseY = clientY - rect.top;

		// Keep the world coordinate under the cursor stationary
		const worldX = (mouseX - this.panX) / this.zoom;
		const worldY = (mouseY - this.panY) / this.zoom;

		this.zoom = clampedZoom;
		this.panX = mouseX - worldX * this.zoom;
		this.panY = mouseY - worldY * this.zoom;

		this.applyViewportTransform();
	}

	public zoomToFit(): void {
		if (this.cardLayouts.size === 0) return;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		for (const layout of this.cardLayouts.values()) {
			minX = Math.min(minX, layout.x);
			minY = Math.min(minY, layout.y);
			maxX = Math.max(maxX, layout.x + layout.width);
			maxY = Math.max(maxY, layout.y + layout.height);
		}

		const boundsWidth = Math.max(maxX - minX, CARD_WIDTH);
		const boundsHeight = Math.max(maxY - minY, DEFAULT_CARD_HEIGHT);

		const viewportRect = this.canvasViewportEl.getBoundingClientRect();
		const padding = 100;
		const availWidth = Math.max(viewportRect.width - padding * 2, 200);
		const availHeight = Math.max(viewportRect.height - padding * 2, 200);

		const fitZoom = Math.min(
			1.15,
			Math.max(
				MIN_ZOOM,
				Math.min(availWidth / boundsWidth, availHeight / boundsHeight)
			)
		);

		this.zoom = fitZoom;
		this.panX =
			(viewportRect.width - boundsWidth * this.zoom) / 2 - minX * this.zoom;
		this.panY =
			(viewportRect.height - boundsHeight * this.zoom) / 2 - minY * this.zoom;

		this.applyViewportTransform();
	}

	private applyViewportTransform(): void {
		if (!this.canvasWorldEl || !this.canvasViewportEl) return;

		this.canvasWorldEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;

		// Scale the background dot grid smoothly with pan & zoom
		const gridSize = 24 * this.zoom;
		this.canvasViewportEl.style.backgroundSize = `${gridSize}px ${gridSize}px`;
		this.canvasViewportEl.style.backgroundPosition = `${this.panX}px ${this.panY}px`;

		if (this.zoomReadoutBtn) {
			this.zoomReadoutBtn.setText(`${Math.round(this.zoom * 100)}%`);
		}
	}

	public toggleGrid(forceState?: boolean): void {
		this.showGrid = typeof forceState === "boolean" ? forceState : !this.showGrid;
		if (this.canvasViewportEl) {
			this.canvasViewportEl.toggleClass("is-grid-hidden", !this.showGrid);
		}
		if (this.toggleGridBtn) {
			this.toggleGridBtn.toggleClass("is-active", this.showGrid);
		}
	}

	private updateToolbarStatus(): void {
		if (!this.fileTitleEl) return;

		if (!this.currentFile) {
			this.fileTitleEl.setText("No active note");
			return;
		}

		this.fileTitleEl.setText(this.currentFile.basename);
	}

	private renderEmptyState(message: string): void {
		this.cardsLayerEl.empty();
		while (this.svgLayerEl.firstChild) {
			this.svgLayerEl.removeChild(this.svgLayerEl.firstChild);
		}
		const emptyEl = this.cardsLayerEl.createDiv({ cls: "vw-empty-state" });
		const iconEl = emptyEl.createDiv({ cls: "vw-empty-icon" });
		setIcon(iconEl, "file-text");
		emptyEl.createDiv({ cls: "vw-empty-text", text: message });
	}

	/**
	 * Clears custom freeform X/Y coordinates and snaps all cards back into a clean
	 * Left-to-Right tree layout (children on the right, siblings stacked underneath).
	 */
	public resetToAutoLayout(): void {
		for (const block of this.blocks) {
			delete block.x;
			delete block.y;
		}
		this.renderCanvas();
		this.zoomToFit();
		void this.saveToFile();
	}

	/**
	 * Computes Left-to-Right tree positions for all blocks:
	 * - Depth determines X column (`depth * (CARD_WIDTH + COLUMN_GAP)`), so children appear to the right of their parent.
	 * - Siblings are stacked vertically underneath one another, with each parent's subtree reserving vertical space.
	 * - Any block with user-dragged custom `(x, y)` coordinates uses its custom position.
	 */
	private computeTreeLayout(): Map<string, ComputedCardLayout> {
		const layouts = new Map<string, ComputedCardLayout>();
		const subtreeHeights = new Map<string, number>();

		const getCardHeight = (blockId: string): number => {
			return this.measuredHeights.get(blockId) ?? DEFAULT_CARD_HEIGHT;
		};

		// Pass 1: Compute vertical span of each node's subtree
		const measureSubtree = (blockId: string): number => {
			const ownHeight = getCardHeight(blockId);
			const children = getChildren(this.blocks, blockId);
			if (children.length === 0) {
				subtreeHeights.set(blockId, ownHeight);
				return ownHeight;
			}

			let childrenSpan = 0;
			children.forEach((child, idx) => {
				childrenSpan += measureSubtree(child.id);
				if (idx < children.length - 1) {
					childrenSpan += SIBLING_GAP;
				}
			});

			const span = Math.max(ownHeight, childrenSpan);
			subtreeHeights.set(blockId, span);
			return span;
		};

		const rootBlocks = getChildren(this.blocks, ROOT_PARENT_ID);
		for (const root of rootBlocks) {
			measureSubtree(root.id);
		}

		// Pass 2: Assign (x, y) coordinates left-to-right (children on right, siblings underneath)
		const placeSubtree = (
			block: VisualBlock,
			depth: number,
			topY: number
		): void => {
			const ownHeight = getCardHeight(block.id);
			const autoX = depth * (CARD_WIDTH + COLUMN_GAP);
			const autoY = topY;

			const finalX =
				typeof block.x === "number" && !Number.isNaN(block.x)
					? block.x
					: autoX;
			const finalY =
				typeof block.y === "number" && !Number.isNaN(block.y)
					? block.y
					: autoY;

			layouts.set(block.id, {
				id: block.id,
				x: finalX,
				y: finalY,
				width: CARD_WIDTH,
				height: ownHeight,
			});

			const children = getChildren(this.blocks, block.id);
			let childCursorY = finalY;
			for (const child of children) {
				const childSpan = subtreeHeights.get(child.id) ?? getCardHeight(child.id);
				placeSubtree(child, depth + 1, childCursorY);
				childCursorY += childSpan + SIBLING_GAP;
			}
		};

		let currentRootY = 0;
		for (const root of rootBlocks) {
			const rootSpan = subtreeHeights.get(root.id) ?? getCardHeight(root.id);
			placeSubtree(root, 0, currentRootY);
			currentRootY += rootSpan + ROOT_GAP;
		}

		return layouts;
	}

	private enterEditMode(blockId: string): void {
		if (this.editingBlockId === blockId) return;
		this.editingBlockId = blockId;
		this.focusedBlockId = blockId;
		this.renderCanvas(blockId);
	}

	private exitEditMode(): void {
		if (!this.editingBlockId) return;
		this.editingBlockId = null;
		this.focusedBlockId = null;
		void this.saveToFile();
		this.renderCanvas();
	}

	private renderCanvas(
		focusBlockId?: string,
		selectionStart?: number | null,
		selectionEnd?: number | null
	): void {
		if (!this.cardsLayerEl) return;
		this.cardsLayerEl.empty();
		this.cardElements.clear();

		if (!this.currentFile) {
			this.renderEmptyState("Select or open a Markdown note to edit visually.");
			return;
		}

		this.blocks = normalizeHierarchy(this.blocks);
		this.updateToolbarStatus();

		const targetFocusId = focusBlockId ?? this.focusedBlockId;
		if (targetFocusId) {
			this.editingBlockId = targetFocusId;
		}

		// Initial layout pass using cached heights
		this.cardLayouts = this.computeTreeLayout();

		// Render each card into the canvas world
		const depthMap = this.computeDepthMap();
		const blockMap = new Map(this.blocks.map((b) => [b.id, b]));
		for (const block of this.blocks) {
			const depth = depthMap.get(block.id) ?? 0;
			const bulletIndentDepth = getBulletIndentDepth(block, blockMap);
			const layout = this.cardLayouts.get(block.id)!;
			this.renderCardNode(block, depth, bulletIndentDepth, layout);
		}

		this.renderConnectorLines();
		this.applyViewportTransform();

		// Measure actual DOM heights after paint and refine layout + connectors
		requestAnimationFrame(() => {
			this.syncMeasuredHeightsAndReflow();
		});

		if (targetFocusId) {
			const textarea = this.cardsLayerEl.querySelector<HTMLTextAreaElement>(
				`textarea[data-block-id="${targetFocusId}"]`
			);
			if (textarea) {
				textarea.focus({ preventScroll: true });
				if (
					typeof selectionStart === "number" &&
					typeof selectionEnd === "number"
				) {
					textarea.setSelectionRange(selectionStart, selectionEnd);
				} else {
					const len = textarea.value.length;
					textarea.setSelectionRange(len, len);
				}
			}
			this.focusedBlockId = null;
		}
	}

	private computeDepthMap(): Map<string, number> {
		const depthMap = new Map<string, number>();
		const walk = (parentId: string, depth: number) => {
			const children = getChildren(this.blocks, parentId);
			for (const child of children) {
				depthMap.set(child.id, depth);
				walk(child.id, depth + 1);
			}
		};
		walk(ROOT_PARENT_ID, 0);
		return depthMap;
	}

	/**
	 * Measures actual card DOM heights and updates positions & SVG Bezier curves so tall cards
	 * never overlap their siblings below.
	 */
	private syncMeasuredHeightsAndReflow(): void {
		let changed = false;
		for (const [blockId, cardEl] of this.cardElements.entries()) {
			const h = cardEl.offsetHeight;
			if (h > 0 && Math.abs((this.measuredHeights.get(blockId) ?? 0) - h) > 2) {
				this.measuredHeights.set(blockId, h);
				changed = true;
			}
		}

		if (changed && !this.draggingBlockId) {
			this.cardLayouts = this.computeTreeLayout();
			for (const [blockId, layout] of this.cardLayouts.entries()) {
				const cardEl = this.cardElements.get(blockId);
				if (cardEl) {
					cardEl.style.transform = `translate(${layout.x}px, ${layout.y}px)`;
				}
			}
		}
		this.renderConnectorLines();
	}

	/**
	 * Draws smooth SVG Bezier curves connecting:
	 * 1. Parent (right port) -> Child (left port)
	 * 2. Sibling (bottom) -> Next Sibling (top) dashed subtle flow line
	 */
	private renderConnectorLines(): void {
		if (!this.svgLayerEl) return;
		while (this.svgLayerEl.firstChild) {
			this.svgLayerEl.removeChild(this.svgLayerEl.firstChild);
		}

		// Draw Parent -> Child curves (Right edge of parent to Left edge of child)
		for (const block of this.blocks) {
			if (block.parentId === ROOT_PARENT_ID) continue;

			const parentLayout = this.cardLayouts.get(block.parentId);
			const childLayout = this.cardLayouts.get(block.id);
			if (!parentLayout || !childLayout) continue;

			const startX = parentLayout.x + parentLayout.width;
			const startY = parentLayout.y + 32;
			const endX = childLayout.x;
			const endY = childLayout.y + 32;

			const deltaX = Math.max(Math.abs(endX - startX) * 0.5, 45);
			const pathData = `M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${
				endX - deltaX
			} ${endY}, ${endX} ${endY}`;

			const pathEl = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path"
			);
			pathEl.setAttribute("d", pathData);
			pathEl.setAttribute("class", "vw-connector-path vw-parent-child-path");
			this.svgLayerEl.appendChild(pathEl);

			// Port dots at start and end
			const startDot = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"circle"
			);
			startDot.setAttribute("cx", String(startX));
			startDot.setAttribute("cy", String(startY));
			startDot.setAttribute("r", "4");
			startDot.setAttribute("class", "vw-connector-dot");
			this.svgLayerEl.appendChild(startDot);

			const endDot = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"circle"
			);
			endDot.setAttribute("cx", String(endX));
			endDot.setAttribute("cy", String(endY));
			endDot.setAttribute("r", "4");
			endDot.setAttribute("class", "vw-connector-dot");
			this.svgLayerEl.appendChild(endDot);
		}

		// Draw subtle vertical sibling order connectors (Bottom of sibling i -> Top of sibling i+1)
		const parents = new Set<string>([
			ROOT_PARENT_ID,
			...this.blocks.map((b) => b.id),
		]);
		for (const parentId of parents) {
			const siblings = getChildren(this.blocks, parentId);
			for (let i = 0; i < siblings.length - 1; i++) {
				const topLayout = this.cardLayouts.get(siblings[i].id);
				const bottomLayout = this.cardLayouts.get(siblings[i + 1].id);
				if (!topLayout || !bottomLayout) continue;

				const x1 = topLayout.x + 28;
				const y1 = topLayout.y + topLayout.height;
				const x2 = bottomLayout.x + 28;
				const y2 = bottomLayout.y;

				const dy = Math.max(Math.abs(y2 - y1) * 0.4, 14);
				const siblingPath = document.createElementNS(
					"http://www.w3.org/2000/svg",
					"path"
				);
				siblingPath.setAttribute(
					"d",
					`M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
				);
				siblingPath.setAttribute(
					"class",
					"vw-connector-path vw-sibling-flow-path"
				);
				this.svgLayerEl.appendChild(siblingPath);
			}
		}
	}

	private renderCardNode(
		block: VisualBlock,
		depth: number,
		bulletIndentDepth: number,
		layout: ComputedCardLayout
	): void {
		const isEditing = this.editingBlockId === block.id;

		const cardEl = this.cardsLayerEl.createDiv({
			cls: `vw-card ${isEditing ? "is-editing is-focused" : "is-rendered"}`,
			attr: {
				"data-block-id": block.id,
				"data-parent-id": block.parentId,
				"data-depth": String(depth),
				"data-bullet-indent": String(bulletIndentDepth),
			},
		});
		cardEl.style.width = `${layout.width}px`;
		cardEl.style.transform = `translate(${layout.x}px, ${layout.y}px)`;
		this.cardElements.set(block.id, cardEl);

		// Card Header (Drag anywhere via header, Block ID, action controls)
		const cardHeader = cardEl.createDiv({ cls: "vw-card-header" });
		const headerLeft = cardHeader.createDiv({ cls: "vw-card-header-left" });

		const dragHandle = headerLeft.createDiv({
			cls: "vw-drag-handle clickable-icon",
			attr: {
				"aria-label":
					"Drag card anywhere on canvas (drop onto another card to reparent/reorder)",
				title:
					"Drag card anywhere on canvas (drop onto another card to reparent/reorder)",
			},
		});
		setIcon(dragHandle, "grip-vertical");

		if (depth > 0) {
			headerLeft.createSpan({
				cls: "vw-depth-pill",
				text: `L${depth}`,
			});
		}

		if (bulletIndentDepth > 0) {
			headerLeft.createSpan({
				cls: "vw-bullet-indent-pill",
				text: `Indent ×${bulletIndentDepth}`,
				attr: {
					title: `Nested Markdown bullet list item (${bulletIndentDepth * 4} spaces in file)`,
				},
			});
		}

		// Action Controls
		const actionsEl = cardHeader.createDiv({ cls: "vw-card-actions" });

		// Insert Image button
		const insertImgBtn = actionsEl.createEl("button", {
			cls: "vw-action-btn clickable-icon",
			attr: {
				"aria-label": "Insert image from vault or computer",
				title: "Insert image from vault or computer",
			},
		});
		setIcon(insertImgBtn, "image");
		this.registerDomEvent(insertImgBtn, "pointerdown", (e) => {
			e.stopPropagation();
		});
		this.registerDomEvent(insertImgBtn, "click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openInsertImageMenu(e, block);
		});

		// Add Sibling Below (down arrow icon only, tooltip preserved)
		const addSiblingBtn = actionsEl.createEl("button", {
			cls: "vw-action-btn clickable-icon",
			attr: {
				"aria-label": "Add Sibling Underneath (+)",
				title: "Add Sibling Underneath (+)",
			},
		});
		setIcon(addSiblingBtn, "arrow-down");
		this.registerDomEvent(addSiblingBtn, "pointerdown", (e) => {
			e.stopPropagation();
		});
		this.registerDomEvent(addSiblingBtn, "click", (e) => {
			e.stopPropagation();
			this.addSiblingBlock(block.id);
		});

		// Add Child on Right (right arrow icon only, tooltip preserved)
		const addChildBtn = actionsEl.createEl("button", {
			cls: "vw-action-btn clickable-icon",
			attr: {
				"aria-label": "Add Child on Right (+)",
				title: "Add Child on Right (+)",
			},
		});
		setIcon(addChildBtn, "arrow-right");
		this.registerDomEvent(addChildBtn, "pointerdown", (e) => {
			e.stopPropagation();
		});
		this.registerDomEvent(addChildBtn, "click", (e) => {
			e.stopPropagation();
			this.addChildBlock(block.id);
		});

		// Delete (trash)
		const deleteBtn = actionsEl.createEl("button", {
			cls: "vw-action-btn vw-action-delete clickable-icon",
			attr: {
				"aria-label": "Delete card",
				title: "Delete card",
			},
		});
		setIcon(deleteBtn, "trash-2");
		this.registerDomEvent(deleteBtn, "pointerdown", (e) => {
			e.stopPropagation();
		});
		this.registerDomEvent(deleteBtn, "click", (e) => {
			e.stopPropagation();
			this.deleteBlock(block.id);
		});

		// Context menu on header right-click
		this.registerDomEvent(cardHeader, "contextmenu", (e) => {
			e.preventDefault();
			this.openCardContextMenu(e, block);
		});

		// Freeform Canvas Dragging & Structural Drop via Header Pointer Events
		this.setupCardCanvasDrag(cardHeader, cardEl, block);

		const bodyEl = cardEl.createDiv({ cls: "vw-card-body" });

		if (isEditing) {
			this.renderCardEditor(bodyEl, cardEl, block);
		} else {
			this.renderCardPreview(bodyEl, block);
		}
	}

	/**
	 * Renders a clean, standard Obsidian-like note editor inside the card (no split preview below).
	 * When the user finishes editing (clicks outside or presses Esc), the card renders its Markdown and images.
	 */
	private renderCardEditor(
		bodyEl: HTMLElement,
		cardEl: HTMLElement,
		block: VisualBlock
	): void {
		const textarea = bodyEl.createEl("textarea", {
			cls: "vw-card-textarea",
			attr: {
				"data-block-id": block.id,
				placeholder: "Type Markdown, paste or drop images...",
				rows: "1",
			},
		});
		textarea.value = block.content;

		// Auto-resize height based on content
		this.autoResizeTextarea(textarea, block.id);
		requestAnimationFrame(() => this.autoResizeTextarea(textarea, block.id));

		this.registerDomEvent(textarea, "input", () => {
			block.content = isBulletListBlock(textarea.value)
				? stripBaseIndentation(textarea.value)
				: textarea.value;
			this.autoResizeTextarea(textarea, block.id);
			this.updateToolbarStatus();
			this.debouncedSave();
		});

		// Handle pasting image files directly from clipboard into the card
		this.registerDomEvent(textarea, "paste", (evt: ClipboardEvent) => {
			const items = evt.clipboardData?.items;
			if (!items) return;

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						evt.preventDefault();
						void this.saveAndInsertExternalImage(file, block, textarea);
						return;
					}
				}
			}
		});

		// Handle dropping image files from the OS onto the card editor
		this.registerDomEvent(textarea, "drop", (evt: DragEvent) => {
			const files = evt.dataTransfer?.files;
			if (files && files.length > 0) {
				const imageFiles = Array.from(files).filter((f) =>
					f.type.startsWith("image/")
				);
				if (imageFiles.length > 0) {
					evt.preventDefault();
					evt.stopPropagation();
					void (async () => {
						for (const imgFile of imageFiles) {
							await this.saveAndInsertExternalImage(imgFile, block, textarea);
						}
					})();
				}
			}
		});

		// Blur exits edit mode and seamlessly renders the Markdown + images in place
		this.registerDomEvent(textarea, "blur", (evt: FocusEvent) => {
			const related = evt.relatedTarget as Node | null;
			if (related && cardEl.contains(related)) {
				return;
			}
			window.setTimeout(() => {
				if (
					this.editingBlockId === block.id &&
					document.activeElement !== textarea &&
					(!document.activeElement || !cardEl.contains(document.activeElement))
				) {
					this.exitEditMode();
				}
			}, 120);
		});

		// Keyboard shortcuts inside card:
		// Escape or Ctrl/Cmd+Enter -> Exit edit mode & render card
		// Tab -> Indent (make child of previous sibling)
		// Shift+Tab -> Outdent (move to parent's column)
		// Alt+ArrowUp / Alt+ArrowDown -> Reorder siblings
		this.registerDomEvent(textarea, "keydown", (evt: KeyboardEvent) => {
			if (
				evt.key === "Escape" ||
				((evt.ctrlKey || evt.metaKey) && evt.key === "Enter")
			) {
				evt.preventDefault();
				this.exitEditMode();
				return;
			}

			if (evt.key === "Tab") {
				evt.preventDefault();
				if (evt.shiftKey) {
					this.outdentBlock(block.id);
				} else {
					this.indentBlock(block.id);
				}
				return;
			}

			if (evt.altKey && evt.key === "ArrowUp") {
				evt.preventDefault();
				this.moveBlockOrder(block.id, -1);
				return;
			}

			if (evt.altKey && evt.key === "ArrowDown") {
				evt.preventDefault();
				this.moveBlockOrder(block.id, 1);
				return;
			}
		});
	}

	/**
	 * Renders the formatted Markdown & embedded images in the card when not actively editing.
	 */
	private renderCardPreview(bodyEl: HTMLElement, block: VisualBlock): void {
		const renderedEl = bodyEl.createDiv({
			cls: "vw-card-rendered markdown-rendered",
		});

		this.renderMarkdownIntoElement(block.content, renderedEl, true);

		// When images finish loading inside the card, re-measure height and update connectors
		const images = renderedEl.querySelectorAll("img");
		images.forEach((img) => {
			this.registerDomEvent(img, "load", () => {
				this.syncMeasuredHeightsAndReflow();
			});
		});

		// Clicking the card body switches directly into the editor (like Obsidian Canvas cards)
		this.registerDomEvent(renderedEl, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement | null;
			if (!target) return;

			const anchor = target.closest("a");
			if (anchor) {
				if (anchor.hasClass("internal-link")) {
					evt.preventDefault();
					evt.stopPropagation();
					const href = anchor.getAttr("data-href") || anchor.getAttr("href");
					if (href && this.currentFile) {
						void this.app.workspace.openLinkText(
							href,
							this.currentFile.path,
							evt.ctrlKey || evt.metaKey
						);
					}
					return;
				}
				if (anchor.hasClass("external-link")) {
					evt.stopPropagation();
					return;
				}
			}

			if (target instanceof HTMLInputElement && target.type === "checkbox") {
				return;
			}

			const selection = window.getSelection();
			if (selection && selection.toString().length > 0) {
				return;
			}

			this.enterEditMode(block.id);
		});

		// Support dropping an image file from the OS directly onto a rendered card
		this.registerDomEvent(renderedEl, "dragover", (evt: DragEvent) => {
			if (evt.dataTransfer?.types.includes("Files")) {
				evt.preventDefault();
			}
		});

		this.registerDomEvent(renderedEl, "drop", (evt: DragEvent) => {
			const files = evt.dataTransfer?.files;
			if (files && files.length > 0) {
				const imageFiles = Array.from(files).filter((f) =>
					f.type.startsWith("image/")
				);
				if (imageFiles.length > 0) {
					evt.preventDefault();
					evt.stopPropagation();
					void (async () => {
						for (const imgFile of imageFiles) {
							await this.saveAndInsertExternalImage(imgFile, block);
						}
					})();
				}
			}
		});
	}

	/**
	 * Enables dragging any card freely anywhere on the canvas (moving its subtree along with it),
	 * or dropping it onto another card to reparent/reorder in the hierarchy.
	 */
	private setupCardCanvasDrag(
		cardHeader: HTMLElement,
		cardEl: HTMLElement,
		block: VisualBlock
	): void {
		this.registerDomEvent(
			cardHeader,
			"pointerdown",
			(evt: PointerEvent) => {
				if (evt.button !== 0 || this.isSpacePressed) return;
				const target = evt.target as HTMLElement;
				if (target.closest("button")) return;

				evt.preventDefault();
				evt.stopPropagation();

				const layout = this.cardLayouts.get(block.id);
				if (!layout) return;

				this.draggingBlockId = block.id;
				this.dragStartClientX = evt.clientX;
				this.dragStartClientY = evt.clientY;
				this.dragOriginCardX = layout.x;
				this.dragOriginCardY = layout.y;

				// Snapshot initial coordinates of all descendants so the subtree moves smoothly with its parent
				this.dragSubtreeOrigins.clear();
				const collectDescendants = (parentId: string) => {
					for (const child of getChildren(this.blocks, parentId)) {
						const childLayout = this.cardLayouts.get(child.id);
						if (childLayout) {
							this.dragSubtreeOrigins.set(child.id, {
								x: childLayout.x,
								y: childLayout.y,
							});
						}
						collectDescendants(child.id);
					}
				};
				collectDescendants(block.id);

				cardEl.addClass("is-dragging");
				cardHeader.setPointerCapture(evt.pointerId);
			}
		);

		this.registerDomEvent(
			cardHeader,
			"pointermove",
			(evt: PointerEvent) => {
				if (this.draggingBlockId !== block.id) return;

				const dx = (evt.clientX - this.dragStartClientX) / this.zoom;
				const dy = (evt.clientY - this.dragStartClientY) / this.zoom;

				const newX = Math.round(this.dragOriginCardX + dx);
				const newY = Math.round(this.dragOriginCardY + dy);

				block.x = newX;
				block.y = newY;

				const layout = this.cardLayouts.get(block.id);
				if (layout) {
					layout.x = newX;
					layout.y = newY;
				}
				cardEl.style.transform = `translate(${newX}px, ${newY}px)`;

				// Move descendant subtree together with the dragged card
				for (const [descId, origin] of this.dragSubtreeOrigins.entries()) {
					const descBlock = this.blocks.find((b) => b.id === descId);
					const descLayout = this.cardLayouts.get(descId);
					const descEl = this.cardElements.get(descId);
					const descX = Math.round(origin.x + dx);
					const descY = Math.round(origin.y + dy);

					if (descBlock) {
						descBlock.x = descX;
						descBlock.y = descY;
					}
					if (descLayout) {
						descLayout.x = descX;
						descLayout.y = descY;
					}
					if (descEl) {
						descEl.style.transform = `translate(${descX}px, ${descY}px)`;
					}
				}

				this.renderConnectorLines();
				this.updateStructuralDropTarget(evt.clientX, evt.clientY, block.id);
			}
		);

		this.registerDomEvent(
			cardHeader,
			"pointerup",
			(evt: PointerEvent) => {
				if (this.draggingBlockId !== block.id) return;

				cardEl.removeClass("is-dragging");
				if (cardHeader.hasPointerCapture(evt.pointerId)) {
					cardHeader.releasePointerCapture(evt.pointerId);
				}

				const targetId = this.hoverTargetBlockId;
				const dropPos = this.hoverDropPosition;

				this.draggingBlockId = null;
				this.dragSubtreeOrigins.clear();
				this.clearDropIndicators();

				// If dropped onto another card's drop zone, reparent/reorder structurally
				if (targetId && dropPos && targetId !== block.id) {
					this.repositionBlock(block.id, targetId, dropPos);
				} else {
					// Otherwise infer parent/sibling hierarchy from where the card was placed on the canvas
					this.inferHierarchyFromCanvasDrop(block);
					this.blocks = normalizeHierarchy(this.blocks);
					this.renderCanvas();
					void this.saveToFile();
				}
			}
		);
	}

	/**
	 * Detects if the pointer is hovering over another card during a drag to allow
	 * reparenting (drop on right/center = child) or sibling reordering (drop on top/bottom edge).
	 */
	private updateStructuralDropTarget(
		clientX: number,
		clientY: number,
		sourceBlockId: string
	): void {
		this.clearDropIndicators();
		this.hoverTargetBlockId = null;
		this.hoverDropPosition = null;

		const worldPt = this.screenToWorld(clientX, clientY);

		for (const [candidateId, layout] of this.cardLayouts.entries()) {
			if (candidateId === sourceBlockId) continue;
			if (this.isDescendant(sourceBlockId, candidateId)) continue;

			const withinX =
				worldPt.x >= layout.x && worldPt.x <= layout.x + layout.width;
			const withinY =
				worldPt.y >= layout.y && worldPt.y <= layout.y + layout.height;

			if (withinX && withinY) {
				const relY = (worldPt.y - layout.y) / Math.max(layout.height, 1);
				let pos: DropPosition = "inside";
				if (relY < 0.25) {
					pos = "before";
				} else if (relY > 0.75) {
					pos = "after";
				}

				this.hoverTargetBlockId = candidateId;
				this.hoverDropPosition = pos;
				const targetEl = this.cardElements.get(candidateId);
				targetEl?.addClass(`drop-${pos}`);
				return;
			}
		}
	}

	private clearDropIndicators(): void {
		for (const el of this.cardElements.values()) {
			el.removeClass("drop-before", "drop-after", "drop-inside");
		}
	}

	/**
	 * Infers whether a card dragged to a freeform canvas position was moved to be a sibling
	 * in an aligned column (e.g. dragged left/underneath its parent so no indentation is needed)
	 * or placed to the right of a parent card as a child.
	 */
	private inferHierarchyFromCanvasDrop(movedBlock: VisualBlock): void {
		if (typeof movedBlock.x !== "number" || typeof movedBlock.y !== "number") {
			return;
		}

		// Normalize any leading spaces on bullet items so indentation is strictly determined by card location
		if (isBulletListBlock(movedBlock.content)) {
			movedBlock.content = stripBaseIndentation(movedBlock.content);
		}

		const movedX = movedBlock.x;
		const movedY = movedBlock.y;
		const COLUMN_ALIGN_THRESHOLD = CARD_WIDTH * 0.45; // ~153px

		// 1. Check if the card was dragged into horizontal alignment (same X column) with another card
		let closestColumnCard: { block: VisualBlock; layout: ComputedCardLayout; distY: number } | null = null;
		for (const candidate of this.blocks) {
			if (candidate.id === movedBlock.id) continue;
			if (this.isDescendant(movedBlock.id, candidate.id)) continue;

			const layout = this.cardLayouts.get(candidate.id);
			if (!layout) continue;

			if (Math.abs(movedX - layout.x) <= COLUMN_ALIGN_THRESHOLD) {
				const distY = Math.abs(movedY - layout.y);
				if (!closestColumnCard || distY < closestColumnCard.distY) {
					closestColumnCard = { block: candidate, layout, distY };
				}
			}
		}

		if (closestColumnCard) {
			const targetParentId = closestColumnCard.block.parentId;
			movedBlock.parentId = targetParentId;

			// Order siblings in this parent group top-to-bottom by their canvas Y coordinate
			const siblings = this.blocks
				.filter((b) => b.parentId === targetParentId)
				.sort((a, b) => {
					const ay = a.id === movedBlock.id ? movedY : (this.cardLayouts.get(a.id)?.y ?? 0);
					const by = b.id === movedBlock.id ? movedY : (this.cardLayouts.get(b.id)?.y ?? 0);
					return ay - by;
				});
			siblings.forEach((sib, idx) => {
				sib.order = idx;
			});
			return;
		}

		// 2. Otherwise check if the card was dragged to the right of a card (making it a child of that card)
		let bestParentCandidate: { block: VisualBlock; layout: ComputedCardLayout; dist: number } | null = null;
		for (const candidate of this.blocks) {
			if (candidate.id === movedBlock.id) continue;
			if (this.isDescendant(movedBlock.id, candidate.id)) continue;

			const layout = this.cardLayouts.get(candidate.id);
			if (!layout) continue;

			const dx = movedX - (layout.x + layout.width);
			const dy = Math.abs(movedY - layout.y);
			if (dx >= -40 && dx <= COLUMN_GAP * 2.5 && dy <= Math.max(layout.height * 2, 260)) {
				const dist = Math.hypot(dx, dy);
				if (!bestParentCandidate || dist < bestParentCandidate.dist) {
					bestParentCandidate = { block: candidate, layout, dist };
				}
			}
		}

		if (bestParentCandidate) {
			movedBlock.parentId = bestParentCandidate.block.id;
			const siblings = this.blocks
				.filter((b) => b.parentId === bestParentCandidate!.block.id)
				.sort((a, b) => {
					const ay = a.id === movedBlock.id ? movedY : (this.cardLayouts.get(a.id)?.y ?? 0);
					const by = b.id === movedBlock.id ? movedY : (this.cardLayouts.get(b.id)?.y ?? 0);
					return ay - by;
				});
			siblings.forEach((sib, idx) => {
				sib.order = idx;
			});
			return;
		}

		// 3. If dragged to the leftmost root area (left of its current parent), promote to root level
		if (movedBlock.parentId !== ROOT_PARENT_ID) {
			const currentParentLayout = this.cardLayouts.get(movedBlock.parentId);
			if (currentParentLayout && movedX <= currentParentLayout.x + COLUMN_ALIGN_THRESHOLD) {
				movedBlock.parentId = ROOT_PARENT_ID;
				const roots = this.blocks
					.filter((b) => b.parentId === ROOT_PARENT_ID)
					.sort((a, b) => {
						const ay = a.id === movedBlock.id ? movedY : (this.cardLayouts.get(a.id)?.y ?? 0);
						const by = b.id === movedBlock.id ? movedY : (this.cardLayouts.get(b.id)?.y ?? 0);
						return ay - by;
					});
				roots.forEach((r, idx) => {
					r.order = idx;
				});
			}
		}
	}

	private renderMarkdownIntoElement(
		markdown: string,
		containerEl: HTMLElement,
		showPlaceholderWhenEmpty: boolean
	): void {
		containerEl.empty();
		const trimmed = markdown.trim();

		if (!trimmed) {
			if (showPlaceholderWhenEmpty) {
				containerEl.createDiv({
					cls: "vw-card-placeholder",
					text: "Click to write Markdown or insert images...",
				});
			}
			return;
		}

		const sourcePath = this.currentFile?.path ?? "";
		void MarkdownRenderer.render(
			this.app,
			markdown,
			containerEl,
			sourcePath,
			this
		);
	}

	private openInsertImageMenu(evt: MouseEvent, block: VisualBlock): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Insert image from vault...")
				.setIcon("image")
				.onClick(() => {
					this.pickImageFromVault(block);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("Upload image from computer...")
				.setIcon("upload")
				.onClick(() => {
					this.promptImageUploadFromDisk(block);
				})
		);

		menu.showAtMouseEvent(evt);
	}

	private pickImageFromVault(
		block: VisualBlock,
		textarea?: HTMLTextAreaElement
	): void {
		new ImagePickerModal(this.app, (imageFile: TFile) => {
			const sourcePath = this.currentFile?.path ?? "";
			const markdownLink = this.app.fileManager.generateMarkdownLink(
				imageFile,
				sourcePath
			);
			const embedSyntax = markdownLink.startsWith("!")
				? markdownLink
				: `!${markdownLink}`;
			this.insertTextIntoBlock(block, embedSyntax, textarea);
		}).open();
	}

	private promptImageUploadFromDisk(
		block: VisualBlock,
		textarea?: HTMLTextAreaElement
	): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;

		input.addEventListener("change", () => {
			const files = input.files;
			if (!files || files.length === 0) return;
			void (async () => {
				for (const file of Array.from(files)) {
					await this.saveAndInsertExternalImage(file, block, textarea);
				}
			})();
		});

		input.click();
	}

	private async saveAndInsertExternalImage(
		file: File,
		block: VisualBlock,
		textarea?: HTMLTextAreaElement
	): Promise<void> {
		try {
			const arrayBuffer = await file.arrayBuffer();
			const sourcePath = this.currentFile?.path ?? "";
			const rawName =
				file.name && file.name !== "image.png"
					? file.name
					: `Pasted image ${new Date()
							.toISOString()
							.replace(/[:.]/g, "-")}.png`;

			const attachmentPath =
				await this.app.fileManager.getAvailablePathForAttachment(
					rawName,
					sourcePath
				);
			const createdFile = await this.app.vault.createBinary(
				attachmentPath,
				arrayBuffer
			);

			const markdownLink = this.app.fileManager.generateMarkdownLink(
				createdFile,
				sourcePath
			);
			const embedSyntax = markdownLink.startsWith("!")
				? markdownLink
				: `!${markdownLink}`;

			this.insertTextIntoBlock(block, embedSyntax, textarea);
			new Notice(`Inserted image: ${createdFile.name}`);
		} catch (err) {
			console.error("Visual Writing: Failed to insert image:", err);
			new Notice("Visual Writing: Failed to save and insert image.");
		}
	}

	private insertTextIntoBlock(
		block: VisualBlock,
		snippet: string,
		textarea?: HTMLTextAreaElement
	): void {
		if (textarea && document.body.contains(textarea)) {
			const start = textarea.selectionStart ?? textarea.value.length;
			const end = textarea.selectionEnd ?? textarea.value.length;
			const before = textarea.value.slice(0, start);
			const after = textarea.value.slice(end);
			const needsLeadingNewline =
				before.length > 0 && !before.endsWith("\n") ? "\n" : "";
			const needsTrailingNewline =
				after.length > 0 && !after.startsWith("\n") ? "\n" : "";
			const insertion = `${needsLeadingNewline}${snippet}${needsTrailingNewline}`;

			textarea.value = `${before}${insertion}${after}`;
			block.content = textarea.value;

			const newCursor = before.length + insertion.length;
			textarea.focus({ preventScroll: true });
			textarea.setSelectionRange(newCursor, newCursor);
			textarea.dispatchEvent(new Event("input"));
		} else {
			const trimmed = block.content.trimEnd();
			block.content = trimmed ? `${trimmed}\n${snippet}` : snippet;
			void this.saveToFile();
			this.renderCanvas(
				this.editingBlockId === block.id ? block.id : undefined
			);
		}
	}

	private autoResizeTextarea(
		textarea: HTMLTextAreaElement,
		blockId: string
	): void {
		textarea.style.height = "auto";
		const computedHeight = Math.max(textarea.scrollHeight, 80);
		textarea.style.height = `${computedHeight}px`;

		const cardEl = this.cardElements.get(blockId);
		if (cardEl) {
			this.measuredHeights.set(blockId, cardEl.offsetHeight);
			this.syncMeasuredHeightsAndReflow();
		}
	}

	private openCardContextMenu(evt: MouseEvent, block: VisualBlock): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle(
					this.editingBlockId === block.id
						? "Finish editing (Esc)"
						: "Edit card"
				)
				.setIcon(this.editingBlockId === block.id ? "check" : "pencil")
				.onClick(() => {
					if (this.editingBlockId === block.id) {
						this.exitEditMode();
					} else {
						this.enterEditMode(block.id);
					}
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("Insert image from vault...")
				.setIcon("image")
				.onClick(() => this.pickImageFromVault(block))
		);

		menu.addItem((item) =>
			item
				.setTitle("Upload image from computer...")
				.setIcon("upload")
				.onClick(() => this.promptImageUploadFromDisk(block))
		);

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Add child card on right")
				.setIcon("arrow-right")
				.onClick(() => this.addChildBlock(block.id))
		);

		menu.addItem((item) =>
			item
				.setTitle("Add sibling card underneath")
				.setIcon("arrow-down")
				.onClick(() => this.addSiblingBlock(block.id))
		);

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Indent card (Tab)")
				.setIcon("indent")
				.onClick(() => this.indentBlock(block.id))
		);

		menu.addItem((item) =>
			item
				.setTitle("Outdent card (Shift+Tab)")
				.setIcon("outdent")
				.onClick(() => this.outdentBlock(block.id))
		);

		menu.addItem((item) =>
			item
				.setTitle("Move sibling up (Alt+Up)")
				.setIcon("arrow-up")
				.onClick(() => this.moveBlockOrder(block.id, -1))
		);

		menu.addItem((item) =>
			item
				.setTitle("Move sibling down (Alt+Down)")
				.setIcon("arrow-down")
				.onClick(() => this.moveBlockOrder(block.id, 1))
		);

		if (typeof block.x === "number" || typeof block.y === "number") {
			menu.addItem((item) =>
				item
					.setTitle("Snap card back to tree position")
					.setIcon("layout-grid")
					.onClick(() => {
						delete block.x;
						delete block.y;
						this.renderCanvas();
						void this.saveToFile();
					})
			);
		}

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Delete card")
				.setIcon("trash-2")
				.onClick(() => this.deleteBlock(block.id))
		);

		menu.showAtMouseEvent(evt);
	}

	/**
	 * Adds a new root-level card (optionally at specific canvas coordinates when double-clicking).
	 */
	public addRootBlock(customX?: number, customY?: number): void {
		const existingIds = new Set(this.blocks.map((b) => b.id));
		const rootSiblings = getChildren(this.blocks, ROOT_PARENT_ID);
		const newId = generateBlockId("root", existingIds);

		const newBlock: VisualBlock = {
			id: newId,
			parentId: ROOT_PARENT_ID,
			order: rootSiblings.length,
			content: "",
		};

		if (typeof customX === "number" && typeof customY === "number") {
			newBlock.x = customX;
			newBlock.y = customY;
		}

		this.blocks.push(newBlock);
		this.editingBlockId = newId;
		this.focusedBlockId = newId;
		this.renderCanvas(newId);
		void this.saveToFile();
	}

	/**
	 * Adds a new sibling immediately underneath `targetBlockId`.
	 */
	public addSiblingBlock(targetBlockId: string): void {
		const target = this.blocks.find((b) => b.id === targetBlockId);
		if (!target) return;

		const existingIds = new Set(this.blocks.map((b) => b.id));
		const prefix = target.parentId === ROOT_PARENT_ID ? "root" : "sub";
		const newId = generateBlockId(prefix, existingIds);

		const siblings = getChildren(this.blocks, target.parentId);
		for (const sib of siblings) {
			if (sib.order > target.order) {
				sib.order += 1;
			}
		}

		const newBlock: VisualBlock = {
			id: newId,
			parentId: target.parentId,
			order: target.order + 1,
			content: "",
		};

		// If target has a custom freeform position, place the new sibling directly underneath it
		if (typeof target.x === "number" && typeof target.y === "number") {
			const targetLayout = this.cardLayouts.get(target.id);
			const targetHeight = targetLayout?.height ?? DEFAULT_CARD_HEIGHT;
			newBlock.x = target.x;
			newBlock.y = target.y + targetHeight + SIBLING_GAP;
		}

		this.blocks.push(newBlock);
		this.blocks = normalizeHierarchy(this.blocks);
		this.editingBlockId = newId;
		this.focusedBlockId = newId;
		this.renderCanvas(newId);
		void this.saveToFile();
	}

	/**
	 * Adds a new child to the right of `parentBlockId`.
	 */
	public addChildBlock(parentBlockId: string): void {
		const parent = this.blocks.find((b) => b.id === parentBlockId);
		if (!parent) return;

		const existingIds = new Set(this.blocks.map((b) => b.id));
		const children = getChildren(this.blocks, parentBlockId);
		const newId = generateBlockId("sub", existingIds);

		const newBlock: VisualBlock = {
			id: newId,
			parentId: parentBlockId,
			order: children.length,
			content: "",
		};

		// If parent has custom freeform coordinates, place child to the right of parent
		if (typeof parent.x === "number" && typeof parent.y === "number") {
			const parentLayout = this.cardLayouts.get(parent.id);
			const baseX = (parentLayout?.x ?? parent.x) + CARD_WIDTH + COLUMN_GAP;
			if (children.length > 0) {
				const lastChild = children[children.length - 1];
				const lastChildLayout = this.cardLayouts.get(lastChild.id);
				newBlock.x = lastChildLayout?.x ?? baseX;
				newBlock.y =
					(lastChildLayout?.y ?? parent.y) +
					(lastChildLayout?.height ?? DEFAULT_CARD_HEIGHT) +
					SIBLING_GAP;
			} else {
				newBlock.x = baseX;
				newBlock.y = parent.y;
			}
		}

		this.blocks.push(newBlock);
		this.blocks = normalizeHierarchy(this.blocks);
		this.editingBlockId = newId;
		this.focusedBlockId = newId;
		this.renderCanvas(newId);
		void this.saveToFile();
	}

	/**
	 * Deletes `blockId`. Any children of `blockId` are promoted to `block.parentId`
	 * so no child thoughts are accidentally lost.
	 */
	public deleteBlock(blockId: string): void {
		const target = this.blocks.find((b) => b.id === blockId);
		if (!target) return;

		const directChildren = getChildren(this.blocks, blockId);
		if (directChildren.length > 0) {
			const parentSiblings = getChildren(this.blocks, target.parentId);
			for (const sib of parentSiblings) {
				if (sib.order > target.order) {
					sib.order += directChildren.length;
				}
			}
			directChildren.forEach((child, idx) => {
				child.parentId = target.parentId;
				child.order = target.order + idx;
			});
		}

		this.blocks = this.blocks.filter((b) => b.id !== blockId);
		this.measuredHeights.delete(blockId);
		if (this.editingBlockId === blockId) {
			this.editingBlockId = null;
		}

		if (this.blocks.length === 0) {
			this.blocks = [
				{
					id: "root-1",
					parentId: ROOT_PARENT_ID,
					order: 0,
					content: "",
				},
			];
		} else {
			this.blocks = normalizeHierarchy(this.blocks);
		}

		this.renderCanvas();
		void this.saveToFile();
	}

	/**
	 * Indents `blockId` (Tab): makes it the last child of its immediately preceding sibling
	 * and snaps it into its new tree column to the right.
	 */
	public indentBlock(blockId: string): void {
		const block = this.blocks.find((b) => b.id === blockId);
		if (!block) return;

		const siblings = getChildren(this.blocks, block.parentId);
		const currentIndex = siblings.findIndex((s) => s.id === blockId);
		if (currentIndex <= 0) {
			return;
		}

		const previousSibling = siblings[currentIndex - 1];
		const newSiblings = getChildren(this.blocks, previousSibling.id);

		block.parentId = previousSibling.id;
		block.order = newSiblings.length;
		delete block.x;
		delete block.y;

		this.blocks = normalizeHierarchy(this.blocks);
		this.focusedBlockId = blockId;
		this.renderCanvas(blockId);
		void this.saveToFile();
	}

	/**
	 * Outdents `blockId` (Shift+Tab): moves it left to its parent's column right underneath the parent.
	 */
	public outdentBlock(blockId: string): void {
		const block = this.blocks.find((b) => b.id === blockId);
		if (!block || block.parentId === ROOT_PARENT_ID) {
			return;
		}

		const currentParent = this.blocks.find((b) => b.id === block.parentId);
		if (!currentParent) return;

		const targetParentId = currentParent.parentId;
		const auntsAndUncles = getChildren(this.blocks, targetParentId);

		for (const item of auntsAndUncles) {
			if (item.order > currentParent.order) {
				item.order += 1;
			}
		}

		block.parentId = targetParentId;
		block.order = currentParent.order + 1;
		delete block.x;
		delete block.y;

		this.blocks = normalizeHierarchy(this.blocks);
		this.focusedBlockId = blockId;
		this.renderCanvas(blockId);
		void this.saveToFile();
	}

	/**
	 * Moves `blockId` up (`direction = -1`) or down (`direction = 1`) among its siblings.
	 */
	public moveBlockOrder(blockId: string, direction: -1 | 1): void {
		const block = this.blocks.find((b) => b.id === blockId);
		if (!block) return;

		const siblings = getChildren(this.blocks, block.parentId);
		const index = siblings.findIndex((s) => s.id === blockId);
		const swapIndex = index + direction;

		if (swapIndex < 0 || swapIndex >= siblings.length) {
			return;
		}

		const other = siblings[swapIndex];
		const tempOrder = block.order;
		block.order = other.order;
		other.order = tempOrder;

		// Swap custom Y coordinates if set, or let auto-layout position them
		delete block.x;
		delete block.y;
		delete other.x;
		delete other.y;

		this.blocks = normalizeHierarchy(this.blocks);
		this.renderCanvas(this.editingBlockId === blockId ? blockId : undefined);
		void this.saveToFile();
	}

	private isDescendant(ancestorId: string, candidateId: string): boolean {
		if (ancestorId === candidateId) return true;
		const children = getChildren(this.blocks, ancestorId);
		for (const child of children) {
			if (this.isDescendant(child.id, candidateId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Reparents or reorders `sourceId` relative to `targetId` when dropped onto `targetId`,
	 * clearing custom coordinates on the moved subtree so it snaps cleanly to the right/underneath.
	 */
	private repositionBlock(
		sourceId: string,
		targetId: string,
		position: DropPosition
	): void {
		const source = this.blocks.find((b) => b.id === sourceId);
		const target = this.blocks.find((b) => b.id === targetId);
		if (!source || !target) return;

		if (position === "inside") {
			const targetChildren = getChildren(this.blocks, target.id).filter(
				(c) => c.id !== source.id
			);
			source.parentId = target.id;
			source.order = targetChildren.length;
		} else {
			const newParentId = target.parentId;
			const siblings = getChildren(this.blocks, newParentId).filter(
				(s) => s.id !== source.id
			);
			const targetIdx = siblings.findIndex((s) => s.id === target.id);
			const insertIdx = position === "before" ? targetIdx : targetIdx + 1;

			siblings.splice(insertIdx, 0, source);
			source.parentId = newParentId;
			siblings.forEach((sib, idx) => {
				sib.order = idx;
			});
		}

		// Clear custom coordinates on source and its descendants so they snap into their new structural place
		const clearSubtreeCoords = (id: string) => {
			const blk = this.blocks.find((b) => b.id === id);
			if (blk) {
				delete blk.x;
				delete blk.y;
			}
			for (const child of getChildren(this.blocks, id)) {
				clearSubtreeCoords(child.id);
			}
		};
		clearSubtreeCoords(source.id);

		this.blocks = normalizeHierarchy(this.blocks);
		this.renderCanvas();
		void this.saveToFile();
	}
}

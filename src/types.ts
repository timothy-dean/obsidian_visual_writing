export const VIEW_TYPE_VISUAL_WRITING = "visual-writing-view";
export const ROOT_PARENT_ID = "root";

export interface VisualBlock {
	id: string;
	parentId: string; // 'root' or another block id
	order: number;
	content: string;
	x?: number; // Optional freeform canvas X position
	y?: number; // Optional freeform canvas Y position
}

export interface VisualTree {
	blocks: Map<string, VisualBlock>;
	roots: string[]; // block IDs where parentId === 'root' ordered by `order`
}

export interface ComputedCardLayout {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type DropPosition = "before" | "after" | "inside";

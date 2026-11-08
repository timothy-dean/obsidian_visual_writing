import { ROOT_PARENT_ID, VisualBlock, VisualTree } from "./types";

const BLOCK_COMMENT_REGEX =
	/<!--\s*visual-block:([a-zA-Z0-9_-]+)\s+parent:([a-zA-Z0-9_-]+)\s+order:(\d+)(?:\s+x:(-?\d+(?:\.\d+)?)\s+y:(-?\d+(?:\.\d+)?))?\s*-->/g;

const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Matches a Markdown bulleted or numbered list line (e.g., `- item`, `* item`, `+ item`, `1. item`, `- [ ] task`).
 */
const LIST_ITEM_LINE_REGEX = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

export interface ParsedDocument {
	frontmatter: string;
	blocks: VisualBlock[];
}

/**
 * Generates a unique, clean block ID.
 */
export function generateBlockId(prefix = "block", existingIds?: Set<string>): string {
	let candidate = "";
	do {
		const randomPart = Math.random().toString(36).substring(2, 8);
		candidate = `${prefix}-${randomPart}`;
	} while (existingIds && existingIds.has(candidate));
	return candidate;
}

/**
 * Splits off optional YAML frontmatter at the top of a Markdown file so it is preserved intact.
 */
export function extractFrontmatter(text: string): { frontmatter: string; body: string } {
	const match = text.match(FRONTMATTER_REGEX);
	if (match && match.index === 0) {
		return {
			frontmatter: match[0],
			body: text.slice(match[0].length),
		};
	}
	return { frontmatter: "", body: text };
}

/**
 * Checks whether a block's content is a Markdown list item (starts with `- `, `* `, `+ `, or `1. `).
 */
export function isBulletListBlock(content: string): boolean {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		return LIST_ITEM_LINE_REGEX.test(line);
	}
	return false;
}

/**
 * Strips common base indentation from a block's lines while preserving any relative
 * sub-indentation inside a multi-line card.
 */
export function stripBaseIndentation(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
	if (!normalized) return "";

	const lines = normalized.split("\n");
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	if (nonEmptyLines.length === 0) return "";

	// Expand tabs to 4 spaces when measuring leading whitespace
	const getLeadingColumns = (line: string): number => {
		const match = line.match(/^[ \t]*/);
		if (!match) return 0;
		return match[0].replace(/\t/g, "    ").length;
	};

	const minIndent = Math.min(...nonEmptyLines.map(getLeadingColumns));
	if (minIndent === 0) {
		return normalized;
	}

	return lines
		.map((line) => {
			if (line.trim().length === 0) return "";
			const expanded = line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));
			return expanded.slice(minIndent);
		})
		.join("\n");
}

/**
 * Applies `indentDepth` levels of standard Markdown list indentation (4 spaces per level)
 * to every non-empty line of a bulleted list block.
 */
export function applyBulletIndentation(content: string, indentDepth: number): string {
	const clean = stripBaseIndentation(content);
	if (!clean || indentDepth <= 0) {
		return clean;
	}

	const prefix = "    ".repeat(indentDepth);
	return clean
		.split("\n")
		.map((line) => (line.trim().length > 0 ? `${prefix}${line}` : line))
		.join("\n");
}

/**
 * Computes how many consecutive ancestor cards are also bulleted list items.
 * - If a child card is a bulleted list item AND its parent card is a bulleted list item,
 *   its bullet indentation depth is `parentBulletIndentDepth + 1`.
 * - If the card is moved to be a sibling of a root bullet card (or its parent is not a bullet card),
 *   its bullet indentation depth is `0` (no indentation).
 */
export function getBulletIndentDepth(
	block: VisualBlock,
	blockMap: Map<string, VisualBlock>
): number {
	if (!isBulletListBlock(block.content)) {
		return 0;
	}

	let depth = 0;
	let currentParentId = block.parentId;
	const visited = new Set<string>([block.id]);

	while (currentParentId && currentParentId !== ROOT_PARENT_ID) {
		if (visited.has(currentParentId)) break;
		visited.add(currentParentId);

		const parentBlock = blockMap.get(currentParentId);
		if (!parentBlock || !isBulletListBlock(parentBlock.content)) {
			break;
		}

		depth += 1;
		currentParentId = parentBlock.parentId;
	}

	return depth;
}

/**
 * Parses Markdown text into an array of VisualBlock items.
 * If the note contains `<!-- visual-block:... -->` comments, extracts those blocks.
 * If the note does not contain delimiter comments, treats each standard paragraph as a root-level card.
 */
export function parseMarkdown(text: string): VisualBlock[] {
	const { body } = extractFrontmatter(text);
	const normalized = body.replace(/\r\n/g, "\n");

	const matches = Array.from(normalized.matchAll(BLOCK_COMMENT_REGEX));

	if (matches.length === 0) {
		return parsePlainParagraphs(normalized);
	}

	const blocks: VisualBlock[] = [];
	const seenIds = new Set<string>();

	// Handle any leading text before the first delimiter comment as a root block if non-empty
	const firstMatchIndex = matches[0].index ?? 0;
	const leadingText = normalized.slice(0, firstMatchIndex).trim();
	if (leadingText.length > 0) {
		const leadingId = generateBlockId("root", seenIds);
		seenIds.add(leadingId);
		blocks.push({
			id: leadingId,
			parentId: ROOT_PARENT_ID,
			order: 0,
			content: leadingText,
		});
	}

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		let id = match[1];
		const parentId = match[2];
		const order = parseInt(match[3], 10);
		const rawX = match[4] !== undefined ? parseFloat(match[4]) : undefined;
		const rawY = match[5] !== undefined ? parseFloat(match[5]) : undefined;

		if (seenIds.has(id)) {
			id = generateBlockId(id, seenIds);
		}
		seenIds.add(id);

		const contentStart = (match.index ?? 0) + match[0].length;
		const contentEnd =
			i + 1 < matches.length
				? (matches[i + 1].index ?? normalized.length)
				: normalized.length;

		const rawSlice = normalized.slice(contentStart, contentEnd);
		// Trim a single leading newline after the comment and trailing whitespace/newlines before the next comment
		const rawContent = rawSlice.replace(/^\n/, "").replace(/\n+$/, "");

		// If the block is a bulleted list item, normalize away any serialized parent-level indentation
		// so that its indentation is always dynamically determined by its current card location.
		const content = isBulletListBlock(rawContent)
			? stripBaseIndentation(rawContent)
			: rawContent;

		const block: VisualBlock = {
			id,
			parentId,
			order: Number.isNaN(order) ? i : order,
			content,
		};

		if (
			rawX !== undefined &&
			!Number.isNaN(rawX) &&
			rawY !== undefined &&
			!Number.isNaN(rawY)
		) {
			block.x = Math.round(rawX);
			block.y = Math.round(rawY);
		}

		blocks.push(block);
	}

	return normalizeHierarchy(blocks);
}

/**
 * Converts plain Markdown without visual-block comments into blocks.
 */
function parsePlainParagraphs(body: string): VisualBlock[] {
	const trimmed = body.trim();
	if (!trimmed) {
		return [
			{
				id: "root-1",
				parentId: ROOT_PARENT_ID,
				order: 0,
				content: "",
			},
		];
	}

	const paragraphs = trimmed
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	if (paragraphs.length === 0) {
		return [
			{
				id: "root-1",
				parentId: ROOT_PARENT_ID,
				order: 0,
				content: "",
			},
		];
	}

	return paragraphs.map((content, index) => ({
		id: `root-${index + 1}`,
		parentId: ROOT_PARENT_ID,
		order: index,
		content,
	}));
}

/**
 * Ensures all blocks have valid parent references (no orphans or cycles) and contiguous 0..n-1 sibling orders.
 * Also strips any stale leading indentation on bullet blocks so indentation is strictly controlled by card hierarchy.
 */
export function normalizeHierarchy(inputBlocks: VisualBlock[]): VisualBlock[] {
	if (inputBlocks.length === 0) {
		return [
			{
				id: "root-1",
				parentId: ROOT_PARENT_ID,
				order: 0,
				content: "",
			},
		];
	}

	const blockMap = new Map<string, VisualBlock>();
	for (const b of inputBlocks) {
		const normalizedContent = isBulletListBlock(b.content)
			? stripBaseIndentation(b.content)
			: b.content;
		blockMap.set(b.id, { ...b, content: normalizedContent });
	}

	// Guard against missing parents or self/cyclic parenting
	for (const block of blockMap.values()) {
		if (block.parentId !== ROOT_PARENT_ID && !blockMap.has(block.parentId)) {
			block.parentId = ROOT_PARENT_ID;
		}
		if (block.parentId === block.id) {
			block.parentId = ROOT_PARENT_ID;
		}
	}

	// Detect cycles by walking ancestor chains
	for (const block of blockMap.values()) {
		const visited = new Set<string>([block.id]);
		let currParent = block.parentId;
		while (currParent !== ROOT_PARENT_ID) {
			if (visited.has(currParent)) {
				block.parentId = ROOT_PARENT_ID;
				break;
			}
			visited.add(currParent);
			const parentObj = blockMap.get(currParent);
			if (!parentObj) {
				block.parentId = ROOT_PARENT_ID;
				break;
			}
			currParent = parentObj.parentId;
		}
	}

	// Group by parentId and normalize order indices
	const childrenByParent = new Map<string, VisualBlock[]>();
	for (const block of blockMap.values()) {
		const list = childrenByParent.get(block.parentId) ?? [];
		list.push(block);
		childrenByParent.set(block.parentId, list);
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort((a, b) => a.order - b.order);
		siblings.forEach((blk, idx) => {
			blk.order = idx;
		});
	}

	// Flatten in depth-first order
	const orderedResult: VisualBlock[] = [];
	const traverse = (parentId: string) => {
		const children = childrenByParent.get(parentId) ?? [];
		for (const child of children) {
			orderedResult.push(child);
			traverse(child.id);
		}
	};

	traverse(ROOT_PARENT_ID);
	return orderedResult;
}

/**
 * Builds a VisualTree structure from a list of blocks.
 */
export function buildVisualTree(blocks: VisualBlock[]): VisualTree {
	const normalized = normalizeHierarchy(blocks);
	const blockMap = new Map<string, VisualBlock>();
	const roots: string[] = [];

	for (const block of normalized) {
		blockMap.set(block.id, block);
		if (block.parentId === ROOT_PARENT_ID) {
			roots.push(block.id);
		}
	}

	roots.sort((a, b) => {
		const blockA = blockMap.get(a)!;
		const blockB = blockMap.get(b)!;
		return blockA.order - blockB.order;
	});

	return {
		blocks: blockMap,
		roots,
	};
}

/**
 * Returns direct children of a parentId sorted by `order`.
 */
export function getChildren(blocks: VisualBlock[], parentId: string): VisualBlock[] {
	return blocks
		.filter((b) => b.parentId === parentId)
		.sort((a, b) => a.order - b.order);
}

/**
 * Traverses the hierarchy depth-first (Parent -> Children ordered by `order`)
 * and generates clean, valid Markdown containing the delimiting comments.
 *
 * Bullet List Formatting Rule:
 * - If a child card is a bulleted list item and its parent card is also a bulleted list item,
 *   the child card's content is indented with 4 spaces per bullet ancestor level (`    - item`),
 *   and joined with a single newline (`\n`) so standard Markdown parsers render a contiguous nested list.
 * - If a bullet card is moved to be a sibling of the root bullet card, its indentation depth becomes `0`
 *   (no leading spaces).
 */
export function serializeTree(blocks: VisualBlock[], frontmatter = ""): string {
	const normalized = normalizeHierarchy(blocks);
	const blockMap = new Map<string, VisualBlock>();
	const childrenByParent = new Map<string, VisualBlock[]>();

	for (const block of normalized) {
		blockMap.set(block.id, block);
		const list = childrenByParent.get(block.parentId) ?? [];
		list.push(block);
		childrenByParent.set(block.parentId, list);
	}

	for (const list of childrenByParent.values()) {
		list.sort((a, b) => a.order - b.order);
	}

	interface SerializedSegment {
		text: string;
		isBullet: boolean;
	}

	const segments: SerializedSegment[] = [];

	const walkDepthFirst = (parentId: string) => {
		const children = childrenByParent.get(parentId) ?? [];
		for (const block of children) {
			const coordsPart =
				typeof block.x === "number" &&
				typeof block.y === "number" &&
				!Number.isNaN(block.x) &&
				!Number.isNaN(block.y)
					? ` x:${Math.round(block.x)} y:${Math.round(block.y)}`
					: "";
			const header = `<!-- visual-block:${block.id} parent:${block.parentId} order:${block.order}${coordsPart} -->`;

			const isBullet = isBulletListBlock(block.content);
			const indentDepth = isBullet ? getBulletIndentDepth(block, blockMap) : 0;
			const formattedContent = isBullet
				? applyBulletIndentation(block.content, indentDepth)
				: block.content.replace(/\r\n/g, "\n").replace(/\n+$/, "");

			segments.push({
				text: `${header}\n${formattedContent}`,
				isBullet,
			});

			walkDepthFirst(block.id);
		}
	};

	walkDepthFirst(ROOT_PARENT_ID);

	let serializedBody = "";
	for (let i = 0; i < segments.length; i++) {
		if (i > 0) {
			// Join consecutive bullet list blocks with a single newline so Markdown renders them as a tight, nested list
			const separator =
				segments[i - 1].isBullet && segments[i].isBullet ? "\n" : "\n\n";
			serializedBody += separator;
		}
		serializedBody += segments[i].text;
	}
	serializedBody += "\n";

	if (frontmatter) {
		const fm = frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
		return `${fm}${serializedBody}`;
	}
	return serializedBody;
}

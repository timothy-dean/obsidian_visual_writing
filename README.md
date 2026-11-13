# Visual Writing for Obsidian

**Visual Writing** is an Obsidian plugin for non-linear, spatial writing and structural card rearrangement—stored directly inside standard Markdown (`.md`) files using lightweight HTML comments.

Unlike separate canvas files, every card tree you build in Visual Writing stays synchronized in real time with your regular Markdown note, preserving YAML frontmatter, links, embeds, and nested bullet lists.

---

## Key Features

- **Plain-Text Markdown Storage**: Card hierarchy, sibling order, and optional freeform canvas coordinates are stored in hidden HTML comments (`<!-- visual-block:... -->`), keeping your notes readable in any Markdown editor.
- **Interactive 2D Tree Canvas**:
  - **Parent -> Child Flow**: Child cards branch out to the right of their parent card, connected with smooth SVG Bezier curves.
  - **Sibling Stacking**: Sibling cards stack vertically with subtle flow connectors.
  - **Auto-Arrange & Freeform Positioning**: Let the plugin automatically lay out your tree left-to-right, or drag cards (along with their subtrees) anywhere on the canvas.
- **Two-Way Live Sync**: Edit cards in the Visual Writing canvas or edit the underlying Markdown note directly—changes sync automatically in both directions while preserving YAML frontmatter.
- **Smart Nested Bullet Lists**: When both a parent card and its child card are Markdown list items (`- `, `* `, `+ `, `1. `), Visual Writing automatically indents child list items (`4 spaces` per level) and joins consecutive bullet blocks into a contiguous nested list in the Markdown file.
- **Rich Markdown & Image Support**:
  - Renders full Obsidian Markdown (internal `[[wikilinks]]`, external links, tasks, formatting, and embeds) when viewing cards.
  - Insert images via the card toolbar/context menu (from your vault or computer), paste images directly from the clipboard, or drag and drop image files onto any card.

---

## Usage

### Opening the Visual Writing View

1. Click the **Toggle Visual Writing View** icon (`git-branch`) in the left ribbon, or
2. Open the Command Palette (`Ctrl/Cmd + P`) and run one of:
   - **Visual Writing: Open Visual Writing view for active note**
   - **Visual Writing: Toggle Visual Writing view**
   - **Visual Writing: Toggle Visual Writing canvas grid**

If you open an existing Markdown note without `visual-block` comments, each paragraph is automatically loaded as a root-level card.

### Canvas Navigation

| Action | Control |
| :--- | :--- |
| **Pan Canvas** | Drag empty canvas background, `Space + Drag`, `Middle-Click + Drag`, or two-finger trackpad scroll |
| **Zoom In / Out** | `Ctrl/Cmd + Scroll` (or mouse wheel), or use the `-` / `+` toolbar buttons |
| **Reset Zoom (100%)** | Click the zoom percentage readout in the toolbar |
| **Zoom to Fit** | Click the **Maximize** (`maximize-2`) button in the toolbar |
| **Toggle Dot Grid** | Click the **Grid** button in the toolbar or run the command palette action |
| **Auto-Arrange Tree** | Click **Auto-Arrange** in the toolbar to clear custom coordinates and snap all cards into a clean left-to-right tree |
| **Create Root Card** | Click **New Card** in the toolbar, or **double-click** anywhere on the empty canvas |

### Working with Cards & Keyboard Shortcuts

Click any card body to switch from rendered Markdown preview into edit mode.

| Shortcut / Action | Description |
| :--- | :--- |
| `Esc` or `Ctrl/Cmd + Enter` | Finish editing and render Markdown preview |
| `Tab` (while editing) | **Indent card**: make the card a child of its preceding sibling |
| `Shift + Tab` (while editing) | **Outdent card**: promote the card left to its parent's column |
| `Alt + ArrowUp` | Move card up among its siblings |
| `Alt + ArrowDown` | Move card down among its siblings |
| **Drag Card Header** | Move a card (and its descendants) freely on the canvas, or drop onto another card's top/middle/bottom zone to reorder or reparent |
| **Card Header Buttons** | Insert image, add sibling underneath (`↓`), add child to the right (`→`), or delete card (promoting any children so thoughts are never lost) |
| **Right-Click Card Header** | Open the context menu for editing, image insertion, adding children/siblings, indenting/outdenting, reordering, or snapping back to tree layout |

---

## Markdown Format Specification

Visual Writing serializes the tree in depth-first order (`Parent -> Children` ordered by `order`). Each block is preceded by an HTML comment delimiter:

```markdown
<!-- visual-block:root-1 parent:root order:0 -->
# Project Overview
High-level summary of the document.

<!-- visual-block:sub-a1b2c3 parent:root-1 order:0 -->
## Background Research
Notes and supporting details that branch off the overview.

<!-- visual-block:sub-d4e5f6 parent:root-1 order:1 x:480 y:260 -->
## Freeform Card
Optional `x` and `y` attributes are saved when a card is positioned manually on the canvas.
```

### Nested Bullet Lists Example

When bulleted list cards are nested as parent and child cards on the canvas, they serialize into a standard indented Markdown list:

```markdown
<!-- visual-block:root-1 parent:root order:0 -->
- Main topic
<!-- visual-block:sub-1 parent:root-1 order:0 -->
    - Subtopic A
<!-- visual-block:sub-2 parent:sub-1 order:0 -->
        - Supporting detail
```

---

## Installation

### Manual Installation

1. Download or build `main.js`, `manifest.json`, and `styles.css`.
2. In your Obsidian vault, create the folder `.obsidian/plugins/visual-writing/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/visual-writing/`.
4. Reload Obsidian and enable **Visual Writing** under **Settings → Community plugins**.

### Building from Source

```bash
# Install dependencies
npm install

# Run development build with watch mode
npm run dev

# Build for production (typecheck + minified bundle)
npm run build
```

---

## License

[MIT](LICENSE) © Tim Dean

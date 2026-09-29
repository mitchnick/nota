// Styles for the shadow root. They live in JS because a content script cannot
// link a stylesheet into a page without exposing it as a web-accessible file.
// Colors and type follow Knox's default Ubud theme.
;(() => {
	const Nota = globalThis.Nota

	// Knox's UI faces. Chrome ignores @font-face inside a shadow root, so the
	// faces go in the document's font set, under names no page will use.
	// Chrome fetches each file the first time the panel renders text in it.
	const LATIN =
		'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
	const FONTS = [
		['Nota Sans', 'fonts/schibsted-grotesk-latin.woff2', '400 800'],
		['Nota Mono', 'fonts/martian-mono-latin.woff2', '300 700'],
	]

	function loadFonts() {
		const present = new Set(
			[...document.fonts].map((face) => face.family.replace(/"/g, '')),
		)
		for (const [family, file, weight] of FONTS) {
			if (present.has(family)) continue
			const source = `url(${chrome.runtime.getURL(file)})`
			document.fonts.add(
				new FontFace(family, source, { weight, unicodeRange: LATIN }),
			)
		}
	}

	Nota.loadFonts = loadFonts
	Nota.uiCss = `
:host {
	all: initial;
	position: fixed;
	inset: 0;
	z-index: 2147483647;
	pointer-events: none;
	color-scheme: dark;

	/* Knox's Ubud block from code/app/assets/tailwind/knox/theme.css. Keep the
	   names, so another Knox theme block pastes in as-is. */
	--sage-100: oklch(0.965 0.011 142.5); /* Primary text */
	--sage-200: oklch(0.915 0.013 142.5); /* Secondary text */
	--sage-300: oklch(0.800 0.014 142.5); /* Tertiary text, descriptions */
	--sage-400: oklch(0.675 0.014 142.5); /* Muted labels, placeholders */
	--sage-500: oklch(0.534 0.019 142.5); /* Borders, disabled states */
	--sage-600: oklch(0.420 0.024 142.5); /* Strong borders, dividers */
	--sage-700: oklch(0.310 0.026 142.5); /* Surfaces, hover states */
	--sage-800: oklch(0.225 0.024 142.5); /* Raised backgrounds, cards */
	--sage-900: oklch(0.165 0.020 142.5); /* Base background */

	--white: oklch(0.99 0.006 88);

	--accent: oklch(0.81 0.145 62);
	--accent-hover: oklch(0.76 0.145 59);
	--accent-active: oklch(0.7 0.135 56);
	--accent-muted: oklch(0.81 0.145 62 / 0.15);

	--success: oklch(0.75 0.12 148);
	--success-text: oklch(0.87 0.075 148);
	--error: oklch(0.66 0.18 22);
	--error-text: oklch(0.86 0.09 22);
	--error-hover: oklch(0.60 0.18 22);
	--error-active: oklch(0.54 0.17 22);
	--warning: oklch(0.86 0.14 98);
	--warning-text: oklch(0.93 0.09 98);
	--info: oklch(0.75 0.075 235);
	--info-text: oklch(0.87 0.045 235);

	--focus-ring: 0 0 0 3px color-mix(in oklch, var(--accent) 40%, transparent);
	--sans: 'Nota Sans', ui-sans-serif, system-ui, sans-serif;
	--mono: 'Nota Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

	font: 13px/1.45 var(--sans);
	color: var(--sage-100);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; }

[data-kind='edit'] { --kind: var(--success); }
[data-kind='note'] { --kind: var(--warning); }
[data-kind='remove'] { --kind: var(--error); }

.hover, .editing, .mark-box {
	position: absolute;
	top: 0;
	left: 0;
	border-radius: 3px;
}
.hover { border: 2px dashed var(--kind); background: color-mix(in oklch, var(--kind) 8%, transparent); }
.hover-label {
	position: absolute;
	top: 0;
	left: 0;
	padding: 1px 6px;
	border-radius: 4px;
	background: var(--kind);
	color: var(--sage-900);
	font: 500 11px/16px var(--mono);
	white-space: nowrap;
}
.editing { border: 2px solid var(--accent); box-shadow: var(--focus-ring); }
.mark-box { border: 1px dashed var(--kind); }
.mark-box.flash { animation: flash 0.9s ease-out; }
@keyframes flash { from { background: color-mix(in oklch, var(--kind) 35%, transparent); } }
.pin {
	position: absolute;
	top: 0;
	left: 0;
	min-width: 18px;
	height: 18px;
	padding: 0 4px;
	border: 2px solid var(--sage-900);
	border-radius: 9px;
	background: var(--kind);
	color: var(--sage-900);
	font: 600 10px/14px var(--mono);
	pointer-events: auto;
}

.panel, .note-frame, .bubble {
	pointer-events: auto;
	background: var(--sage-800);
	border: 1px solid var(--sage-700);
	box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
}
.panel {
	position: absolute;
	right: 16px;
	bottom: 16px;
	width: 340px;
	max-height: min(70vh, 640px);
	display: flex;
	flex-direction: column;
	border-radius: 12px;
}
.panel.left, .bubble.left { right: auto; left: 16px; }
.header { display: flex; align-items: center; gap: 4px; padding: 8px; }
.tabs { display: flex; flex: 1; gap: 2px; padding: 2px; border-radius: 8px; background: var(--sage-900); }
.tab {
	flex: 1;
	padding: 4px 0;
	border: 0;
	border-radius: 6px;
	background: none;
	color: var(--sage-300);
	font-weight: 500;
}
.tab:hover { color: var(--sage-100); }
.tab[aria-pressed='true'] { background: var(--sage-700); color: var(--white); }
.tab kbd { margin-left: 5px; font: 10px/1 var(--mono); opacity: 0.55; }
.icon-button {
	width: 26px;
	height: 26px;
	border: 0;
	border-radius: 6px;
	background: none;
	color: var(--sage-400);
	font-size: 15px;
}
.icon-button:hover { background: var(--sage-700); color: var(--sage-100); }
.hint { padding: 0 12px 8px; color: var(--sage-300); font-size: 12px; }
.hint.warn { color: var(--warning-text); }
.hint kbd {
	padding: 0 4px;
	border: 1px solid var(--sage-600);
	border-radius: 4px;
	background: var(--sage-900);
	color: var(--sage-200);
	font: 500 12px/16px var(--sans);
}
.error { padding: 0 12px 8px; color: var(--error-text); font-size: 12px; }
.list { flex: 1; overflow-y: auto; padding: 0 8px; overscroll-behavior: contain; }
.group + .group { margin-top: 6px; }
.group-head {
	display: flex;
	justify-content: space-between;
	padding: 6px 4px 4px;
	color: var(--sage-400);
	font: 11px/1.4 var(--mono);
}
.group-head a { color: var(--accent); text-decoration: none; }
.group-head a:hover { color: var(--accent-hover); }
.item {
	position: relative;
	display: flex;
	gap: 8px;
	padding: 6px 28px 6px 4px;
	border-radius: 6px;
	cursor: pointer;
}
.item:hover { background: var(--sage-700); }
.item.flash { animation: item-flash 0.9s ease-out; }
@keyframes item-flash { from { background: var(--sage-600); } }
.badge {
	flex: none;
	min-width: 18px;
	height: 18px;
	padding: 0 4px;
	border-radius: 9px;
	background: var(--kind);
	color: var(--sage-900);
	font: 600 10px/18px var(--mono);
	text-align: center;
}
.body { min-width: 0; flex: 1; }
.before { color: var(--sage-400); text-decoration: line-through; }
.before, .after, .note-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.note-text { white-space: pre-wrap; }
.target { color: var(--sage-400); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { margin-top: 2px; font-size: 11px; color: var(--sage-400); }
.status.landed { color: var(--success-text); }
.delete {
	position: absolute;
	top: 5px;
	right: 4px;
	width: 20px;
	height: 20px;
	border: 0;
	border-radius: 4px;
	background: none;
	color: var(--sage-400);
	opacity: 0;
}
.item:hover .delete { opacity: 1; }
.delete:hover { background: var(--sage-600); color: var(--sage-100); }
.empty { padding: 4px 4px 8px; color: var(--sage-400); font-size: 12px; }
.footer { display: flex; justify-content: flex-end; gap: 6px; padding: 8px; border-top: 1px solid var(--sage-700); }
.button {
	padding: 5px 10px;
	border: 1px solid var(--sage-500);
	border-radius: 8px;
	background: none;
	color: var(--sage-200);
	font: 500 11px/16px var(--mono);
	transition: all 0.15s;
}
.button:hover { border-color: var(--sage-300); color: var(--sage-100); }
.button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.button:disabled { opacity: 0.4; cursor: not-allowed; }
.button.primary { border-color: transparent; background: var(--accent); color: var(--sage-900); }
.button.primary:hover { background: var(--accent-hover); }
.button.primary:active { background: var(--accent-active); }
.button.danger { border-color: transparent; background: var(--error); color: var(--white); }
.button.danger:hover { background: var(--error-hover); }
.button.danger:active { background: var(--error-active); }
.button.quiet { border-color: transparent; color: var(--sage-300); }
.button.quiet:hover { color: var(--sage-100); }

/* The note popover. The frame sits in the panel's shadow root, and
   pages/note.html renders .popover inside it with these same styles. */
.note-frame {
	position: absolute;
	top: 0;
	left: 0;
	box-sizing: content-box;
	width: 318px;
	height: 160px;
	border-radius: 10px;
	color-scheme: dark;
}
.popover { padding: 10px; pointer-events: auto; }
.popover-head { display: flex; align-items: center; gap: 6px; }
.popover-tag {
	flex: none;
	padding: 0 6px;
	border-radius: 4px;
	background: var(--kind);
	color: var(--sage-900);
	font: 500 11px/18px var(--mono);
}
.popover-label { min-width: 0; color: var(--sage-200); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Right to left, so a long path loses its start and keeps the file name. */
.popover-view {
	margin-top: 4px;
	direction: rtl;
	text-align: left;
	color: var(--sage-400);
	font: 11px/1.4 var(--mono);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.popover textarea {
	display: block;
	width: 100%;
	min-height: 68px;
	max-height: 260px;
	field-sizing: content;
	margin: 8px 0 10px;
	padding: 7px 9px;
	border: 1px solid var(--sage-600);
	border-radius: 8px;
	background: var(--sage-900);
	color: var(--sage-100);
	font: inherit;
	resize: none;
	outline: none;
	transition: border-color 0.15s;
}
.popover textarea::placeholder { color: var(--sage-500); }
.popover textarea:focus { border-color: var(--sage-500); }
.popover-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.popover-foot .destructive { margin-right: auto; color: var(--error-text); }
.popover-foot .destructive:hover { background: color-mix(in oklch, var(--error) 18%, transparent); color: var(--error-text); }
.button kbd { margin-left: 6px; font: 12px/16px var(--sans); opacity: 0.7; }

.bubble {
	position: absolute;
	right: 16px;
	bottom: 16px;
	width: 44px;
	height: 44px;
	border-radius: 22px;
	font-size: 18px;
}
.bubble:hover { background: var(--sage-700); }
.bubble .count {
	position: absolute;
	top: -4px;
	right: -4px;
	min-width: 18px;
	height: 18px;
	padding: 0 4px;
	border-radius: 9px;
	background: var(--accent);
	color: var(--sage-900);
	font: 600 10px/18px var(--mono);
}
`
})()

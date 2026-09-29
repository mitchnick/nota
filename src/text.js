// Shared helpers. Loads first and creates the Nota namespace that every other
// script adds to. The note page in pages/ loads it too.
;(() => {
	const Nota = (globalThis.Nota ??= {})

	// Collapses whitespace so text compares equal across reflows and re-renders.
	function normalize(text) {
		return (text ?? '').replace(/\s+/g, ' ').trim()
	}

	function snippet(text, max = 60) {
		const clean = normalize(text)
		return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
	}

	// Builds UI nodes. Children are appended as nodes or text, never parsed as
	// HTML, so page text is safe to pass in.
	function h(tag, attrs = {}, ...children) {
		const el = document.createElement(tag)
		for (const [key, value] of Object.entries(attrs)) {
			if (value == null || value === false) continue
			if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
			else if (key === 'class') el.className = value
			else el.setAttribute(key, value === true ? '' : value)
		}
		el.append(
			...children.flat().filter((child) => child != null && child !== false),
		)
		return el
	}

	Object.assign(Nota, { normalize, snippet, h })
})()

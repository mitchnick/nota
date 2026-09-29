// Describes a page element well enough to find it again after a reload, and
// well enough for an agent to find it in source.
;(() => {
	const Nota = globalThis.Nota
	const { normalize } = Nota

	const SKIP = new Set(['script', 'style', 'noscript', 'template', 'nota-root'])
	// prettier-ignore
	const BLOCKS = new Set([
		'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
		'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
		'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'option',
		'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
	])
	// Ids that frameworks generate and that change between renders.
	const GENERATED_ID = /\d{3,}|^[:«]|^(ember|react|radix|headlessui|mui|__)/i
	const READABLE_CLASS = /^[a-z][\w-]*$/i
	// Tailwind-style utilities say nothing about which component an element
	// is. Semantic classes such as "signin-card" stay in the breadcrumb.
	const UTILITY_CLASS =
		/^(-?[mp][trblxyse]?-|(min-|max-)?[wh]-|size-|text-|bg-|font-|leading-|tracking-|rounded|border|shadow|ring|outline|flex|grid|gap-|space-|items-|justify-|content-|self-|place-|order-|col-|row-|inset|top-|left-|right-|bottom-|z-|opacity-|overflow|transition|duration-|ease-|delay-|cursor-|select-|whitespace|break-|truncate|underline|uppercase|lowercase|capitalize|italic|antialiased|sr-only|hidden$|block$|inline|contents$|static$|fixed$|absolute$|relative$|sticky$|container$|aspect-|object-|fill-|stroke-|animate-|transform|translate-|scale-|rotate-|skew-|blur|backdrop-|from-|via-|to-|divide-|placeholder-|accent-|caret-|decoration-|list-|align-|visible$|invisible$|shrink|grow|basis-)/
	const TEMPLATE_COMMENT = /^\s*(BEGIN|END) (\S+)\s*$/

	// Text as it appears in source: no CSS text-transform, no hidden layout
	// effects, and a space wherever a <br> or block boundary splits words.
	function readText(el) {
		let out = ''
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE) {
					out += child.data
				} else if (
					child.nodeType === Node.ELEMENT_NODE &&
					!SKIP.has(child.localName)
				) {
					if (child.localName === 'br') {
						out += ' '
						continue
					}
					const block = BLOCKS.has(child.localName)
					if (block) out += ' '
					walk(child)
					if (block) out += ' '
				}
			}
		}
		walk(el)
		return normalize(out)
	}

	// What a person would call the element: its text, or for inputs, images,
	// and icon buttons, the label they carry.
	function textOf(el) {
		const value = el.localName === 'input' ? el.value || el.placeholder : ''
		return (
			readText(el) ||
			normalize(
				el.getAttribute('aria-label') ||
					el.getAttribute('alt') ||
					el.getAttribute('title') ||
					value,
			)
		)
	}

	function matchesOnly(selector, el) {
		try {
			const found = document.querySelectorAll(selector)
			return found.length === 1 && found[0] === el
		} catch {
			return false
		}
	}

	function stableId(el) {
		return el.id && !GENERATED_ID.test(el.id) ? `#${CSS.escape(el.id)}` : null
	}

	// Shortest chain of tag:nth-of-type steps, anchored on a stable id when one
	// exists, that matches only this element.
	function cssSelector(el) {
		const own = stableId(el)
		if (own && matchesOnly(own, el)) return own
		const steps = []
		let node = el
		while (node && node !== document.documentElement) {
			const parent = node.parentElement
			let step = node.localName
			if (parent) {
				const same = [...parent.children].filter(
					(c) => c.localName === node.localName,
				)
				if (same.length > 1) step += `:nth-of-type(${same.indexOf(node) + 1})`
			}
			steps.unshift(step)
			const selector = steps.join(' > ')
			if (matchesOnly(selector, el)) return selector
			const anchor = parent && stableId(parent)
			if (anchor && matchesOnly(`${anchor} > ${selector}`, el))
				return `${anchor} > ${selector}`
			node = parent
		}
		return steps.join(' > ')
	}

	function label(el) {
		const id = stableId(el)
		if (id) return `${el.localName}${id}`
		const classes = [...el.classList]
			.filter((c) => READABLE_CLASS.test(c) && !UTILITY_CLASS.test(c))
			.slice(0, 2)
		return el.localName + classes.map((c) => `.${c}`).join('')
	}

	// Readable breadcrumb for the prompt, e.g. "section#hero > div.cta > a.btn".
	function wherePath(el, depth = 3) {
		const steps = []
		let node = el
		while (node && node !== document.body && steps.length < depth) {
			steps.unshift(label(node))
			if (stableId(node)) break
			node = node.parentElement
		}
		return steps.join(' > ')
	}

	// Rails wraps each rendered template in <!-- BEGIN path --> / <!-- END path -->
	// when config.action_view.annotate_rendered_view_with_filenames is on. The
	// innermost template open at the element's position rendered it.
	function findTemplate(el) {
		const walker = document.createTreeWalker(
			document.documentElement,
			NodeFilter.SHOW_COMMENT,
		)
		const open = []
		let comment
		while ((comment = walker.nextNode())) {
			if (
				el.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING
			)
				break
			const match = comment.data.match(TEMPLATE_COMMENT)
			if (!match) continue
			if (match[1] === 'BEGIN') {
				open.push(match[2])
			} else {
				const index = open.lastIndexOf(match[2])
				if (index !== -1) open.length = index
			}
		}
		return open.at(-1) ?? null
	}

	function describe(el) {
		return {
			tag: el.localName,
			text: textOf(el),
			selector: cssSelector(el),
			where: wherePath(el),
			template: findTemplate(el),
			lang: el.closest('[lang]')?.getAttribute('lang') || null,
		}
	}

	// Finds a stored change's element on the current page. The selector must
	// agree with the text; when it doesn't, the first element of the same tag
	// with the expected text wins. Notes and removals trust the selector alone
	// when the text has drifted, since they never overwrite anything.
	function resolve(item) {
		const fits =
			item.kind === 'edit'
				? (el) => [item.before, item.after].includes(readText(el))
				: (el) => textOf(el) === item.text
		let bySelector = null
		try {
			bySelector = document.querySelector(item.selector)
		} catch {}
		if (bySelector?.localName !== item.tag) bySelector = null
		if (bySelector && fits(bySelector)) return bySelector
		for (const candidate of document.getElementsByTagName(item.tag)) {
			if (fits(candidate)) return candidate
		}
		return item.kind === 'edit' ? null : bySelector
	}

	Object.assign(Nota, { readText, describe, resolve })
})()

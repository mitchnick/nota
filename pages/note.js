// The note editor. src/ui.js shows this page in an iframe over the element
// you picked. It is an extension page, so the page being marked up cannot
// read what you type here, type into it, or press its buttons. It talks only
// to Nota's content script in the top frame of its own tab.
;(async () => {
	const { h, loadFonts, uiCss } = globalThis.Nota

	// src/ui.js names this frame with a secret, and only listens to a port
	// that carries it.
	const tab = await chrome.tabs.getCurrent()
	const port = chrome.tabs.connect(tab.id, {
		name: `nota-note:${window.name}`,
		frameId: 0,
	})
	let seq = 0

	function send(message) {
		port.postMessage({ ...message, seq })
	}

	const head = h('div', { class: 'popover-head' })
	const view = h('div', { class: 'popover-view' })
	const text = h('textarea', {
		placeholder:
			'What should change? e.g. tighten this, or fade it in on scroll',
		oninput: () => send({ type: 'draft', text: text.value }),
		onkeydown: (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				send({ type: 'save', text: text.value })
			} else if (event.key === 'Escape') {
				event.preventDefault()
				send({ type: 'cancel' })
			}
		},
	})
	const remove = h(
		'button',
		{ class: 'button quiet', onclick: () => send({ type: 'save', text: '' }) },
		'Delete',
	)
	const popover = h(
		'div',
		{ class: 'popover' },
		head,
		view,
		text,
		h(
			'div',
			{ class: 'popover-foot' },
			h('span', { class: 'keys' }, '⌘↵ to save'),
			remove,
			h(
				'button',
				{ class: 'button quiet', onclick: () => send({ type: 'cancel' }) },
				'Cancel',
			),
			h(
				'button',
				{
					class: 'button primary',
					onclick: () => send({ type: 'save', text: text.value }),
				},
				'Save note',
			),
		),
	)

	// The same styles as the panel, so the popover matches it.
	const host = document.createElement('nota-root')
	loadFonts()
	host.attachShadow({ mode: 'open' }).append(h('style', {}, uiCss), popover)
	document.body.append(host)

	// Chrome ignores focus() in a cross-origin frame that lacks focus, so
	// the textarea takes it once src/ui.js focuses this frame.
	addEventListener('focus', () => text.focus())

	port.onMessage.addListener((message) => {
		if (message.type === 'open') {
			seq = message.seq
			head.textContent = message.heading
			view.textContent = message.template ?? ''
			view.hidden = !message.template
			text.value = message.text
			remove.hidden = !message.existing
			text.focus()
		} else if (message.type === 'focus') {
			text.focus()
		}
	})

	// The iframe takes the popover's height, which grows when you drag the
	// textarea's corner.
	new ResizeObserver(() =>
		send({ type: 'size', height: popover.offsetHeight }),
	).observe(popover)
})()

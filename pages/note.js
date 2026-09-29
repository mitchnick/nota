// The note editor. src/ui.js shows this page in an iframe over the element
// you picked. It is an extension page, so the page being marked up cannot
// read what you type here, type into it, or press its buttons. It talks only
// to Nota's content script in the frame that shows it, in its own tab.
;(async () => {
	const { h, loadFonts, uiCss } = globalThis.Nota

	// src/ui.js names this frame with a secret, and only listens to a port
	// that carries it. The query names the tab frame that shows the popover.
	const tab = await chrome.tabs.getCurrent()
	const port = chrome.tabs.connect(tab.id, {
		name: `nota-note:${window.name}`,
		frameId: Number(new URLSearchParams(location.search).get('frame')),
	})
	let seq = 0

	function send(message) {
		port.postMessage({ ...message, seq })
	}

	const tag = h('span', { class: 'popover-tag' })
	const label = h('span', { class: 'popover-label' })
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
		{
			class: 'button quiet destructive',
			onclick: () => send({ type: 'save', text: '' }),
		},
		'Delete',
	)
	const popover = h(
		'div',
		{ class: 'popover', 'data-kind': 'note' },
		h('div', { class: 'popover-head' }, tag, label),
		view,
		text,
		h(
			'div',
			{ class: 'popover-foot' },
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
					'aria-keyshortcuts': 'Meta+Enter Control+Enter',
					onclick: () => send({ type: 'save', text: text.value }),
				},
				'Save',
				h('kbd', {}, '⌘↵'),
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
			tag.textContent = message.tag
			label.textContent = message.label
			label.hidden = !message.label
			// An isolate, so the path reads left to right in the RTL line.
			view.replaceChildren(h('bdi', {}, message.template ?? ''))
			view.hidden = !message.template
			text.value = message.text
			remove.hidden = !message.existing
			text.focus()
		} else if (message.type === 'focus') {
			text.focus()
		}
	})

	// The iframe takes the popover's height, which grows with the note.
	new ResizeObserver(() =>
		send({ type: 'size', height: popover.offsetHeight }),
	).observe(popover)
})()

// Everything Nota draws: the panel, the collapsed bubble, hover and edit
// outlines, numbered pins, and the note popover. It lives in a shadow root on
// <html>, so page CSS cannot reach it and Turbo body swaps do not remove it.
// The root is closed, so page scripts cannot read or click anything in it.
// The controller in nota.js owns all state; this module only renders it. Each
// iframe draws its own outlines, pins, and note, and only the top frame shows
// the panel.
;(() => {
	const Nota = globalThis.Nota
	const { snippet, h } = Nota

	const MODES = [
		{
			id: 'edit',
			label: 'Edit',
			key: 'E',
			hint: 'Click text to edit it. [Enter] saves, [Esc] reverts.',
		},
		{
			id: 'note',
			label: 'Note',
			key: 'N',
			hint: 'Click anything to leave a note. [↑] selects the parent, [Esc] stops.',
		},
		{
			id: 'remove',
			label: 'Remove',
			key: 'R',
			hint: 'Click anything to remove it. [↑] selects the parent, [Esc] stops.',
		},
	]
	const IDLE_HINT = 'Clicks reach the page. [M] minimizes, [⌥⇧N] reopens.'
	const TRANSLATED_HINT =
		'Chrome translated this page, and your source has the original words. Show the original to mark it up.'

	// Keeps events inside Nota away from page handlers such as global hotkeys,
	// click-outside listeners, and smooth-scroll libraries.
	// prettier-ignore
	const CONTAINED_EVENTS = [
		'keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup',
		'pointerdown', 'pointerup', 'focusin', 'focusout', 'input', 'wheel', 'touchmove',
	]

	// Turns each [key] in a hint into a key cap.
	function withKeys(text) {
		return text
			.split(/\[([^\]]+)\]/)
			.map((part, i) => (i % 2 ? h('kbd', {}, part) : part))
	}

	function place(el, rect) {
		el.style.transform = `translate(${rect.left}px, ${rect.top}px)`
		el.style.width = `${rect.width}px`
		el.style.height = `${rect.height}px`
	}

	function createUI(handlers, { frameId = 0 } = {}) {
		const host = document.createElement('nota-root')
		const root = host.attachShadow({ mode: 'closed' })
		for (const type of CONTAINED_EVENTS) {
			host.addEventListener(type, (event) => event.stopPropagation())
		}
		// Clicking Nota's buttons leaves focus where it was, so E/N/R/M and ↑
		// keep working.
		root.addEventListener('mousedown', (event) => event.preventDefault())

		const marks = h('div')
		const hover = h('div', { class: 'hover', hidden: true })
		const hoverLabel = h('div', { class: 'hover-label', hidden: true })
		const editing = h('div', { class: 'editing', hidden: true })
		const tabs = MODES.map((mode) =>
			h(
				'button',
				{
					class: 'tab',
					title: `${mode.label} (${mode.key})`,
					onclick: () => handlers.onMode(mode.id),
				},
				mode.label,
				h('kbd', {}, mode.key),
			),
		)
		const hint = h('div', { class: 'hint' })
		const error = h('div', { class: 'error', hidden: true })
		const list = h('div', { class: 'list' })
		const clear = h(
			'button',
			{ class: 'button quiet', onclick: onClearClick },
			'Clear',
		)
		const copy = h(
			'button',
			{ class: 'button primary', onclick: () => handlers.onCopy() },
			'Copy prompt',
		)
		const panel = h(
			'div',
			{ class: 'panel', hidden: true },
			h(
				'div',
				{ class: 'header' },
				h('div', { class: 'tabs' }, tabs),
				h(
					'button',
					{
						class: 'icon-button',
						title: 'Move to the other side',
						onclick: () => handlers.onFlip(),
					},
					'⇆',
				),
				h(
					'button',
					{
						class: 'icon-button',
						title: 'Minimize (M)',
						onclick: () => handlers.onCollapse(),
					},
					'▾',
				),
			),
			hint,
			error,
			list,
			h('div', { class: 'footer' }, clear, copy),
		)
		const bubbleCount = h('span', { class: 'count' })
		const bubble = h(
			'button',
			{
				class: 'bubble',
				title: 'Open Nota (⌥⇧N)',
				hidden: true,
				onclick: () => handlers.onExpand(),
			},
			'✎',
			bubbleCount,
		)

		// The note editor is an extension page in an iframe. A page can type
		// into any textarea that has focus in its own document, even inside a
		// closed shadow root, and it sees every keystroke there. It can do
		// neither inside a frame from another origin. The frame's name is a
		// secret it connects with: a page can embed pages/note.html itself, but
		// cannot read this attribute or a cross-origin frame's window.name.
		// randomUUID() needs a secure context, and plain-http pages are not one.
		// The query names the tab frame this UI lives in, for the note to
		// connect back to.
		const noteToken = [...crypto.getRandomValues(new Uint8Array(16))]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
		const noteFrame = h('iframe', {
			class: 'note-frame',
			hidden: true,
			name: noteToken,
			src: `${chrome.runtime.getURL('pages/note.html')}?frame=${frameId}`,
		})

		Nota.loadFonts()
		root.append(
			h('style', {}, Nota.uiCss),
			marks,
			hover,
			hoverLabel,
			editing,
			noteFrame,
			panel,
			bubble,
		)

		const markNodes = new Map()
		let clearTimer = null
		let copyTimer = null
		let count = 0
		let notePort = null
		let noteShown = null // the open note, resent if the frame reloads
		let noteSeq = 0
		let noteDraft = ''
		let noteRect = null

		// The note page connects each time it loads.
		chrome.runtime.onConnect.addListener((port) => {
			if (port.name !== `nota-note:${noteToken}`) return
			notePort = port
			port.onMessage.addListener(onNoteMessage)
			port.onDisconnect.addListener(() => {
				if (notePort === port) notePort = null
			})
			if (noteShown) port.postMessage(noteShown)
		})

		function onNoteMessage(message) {
			if (message.type === 'size') {
				noteFrame.style.height = `${message.height}px`
				if (noteRect) placeNote(noteRect)
			}
			// Replies from a note that has since closed are stale.
			if (!noteShown || message.seq !== noteShown.seq) return
			if (message.type === 'draft') noteDraft = message.text
			else if (message.type === 'save') handlers.onSaveNote(message.text)
			else if (message.type === 'cancel') handlers.onCancelNote()
		}

		function placeNote(rect) {
			noteRect = rect
			const width = 320
			const height = noteFrame.offsetHeight || 160
			const below = rect.bottom + 8
			const top =
				below + height < innerHeight
					? below
					: Math.max(8, rect.top - height - 8)
			const left = Math.min(Math.max(8, rect.left), innerWidth - width - 8)
			noteFrame.style.transform = `translate(${left}px, ${top}px)`
		}

		function onClearClick() {
			if (clearTimer) {
				resetClear()
				handlers.onClear()
				return
			}
			clear.textContent = 'Clear all?'
			clear.className = 'button danger'
			clearTimer = setTimeout(resetClear, 3000)
		}

		function resetClear() {
			clearTimeout(clearTimer)
			clearTimer = null
			clear.textContent = 'Clear'
			clear.className = 'button quiet'
		}

		function renderEntry({ item, number }, status, here) {
			const target = h(
				'div',
				{ class: 'target' },
				`<${item.tag}> ${snippet(item.text, 50)}`,
			)
			let body
			if (item.kind === 'edit') {
				body = [
					h('div', { class: 'before' }, item.before),
					h('div', { class: 'after' }, item.after || '(empty)'),
				]
			} else if (item.kind === 'note') {
				body = [h('div', { class: 'note-text' }, item.note), target]
			} else {
				body = [h('div', {}, 'Remove'), target]
			}
			if (status === 'landed')
				body.push(
					h('div', { class: 'status landed' }, '✓ Already in the page source'),
				)
			if (status === 'missing' && here)
				body.push(h('div', { class: 'status' }, 'Not found on this page'))
			return h(
				'div',
				{
					class: 'item',
					'data-id': item.id,
					'data-kind': item.kind,
					onclick: () => handlers.onFocusItem(item.id),
				},
				h('span', { class: 'badge' }, String(number)),
				h('div', { class: 'body' }, body),
				h(
					'button',
					{
						class: 'delete',
						title: 'Delete and revert',
						onclick: (event) => {
							event.stopPropagation()
							handlers.onDelete(item.id)
						},
					},
					'×',
				),
			)
		}

		return {
			host,

			owns(event) {
				return event.composedPath().includes(host)
			},

			mount() {
				if (!host.isConnected) document.documentElement.append(host)
			},

			setSide(side) {
				panel.classList.toggle('left', side === 'left')
				bubble.classList.toggle('left', side === 'left')
			},

			setView(view) {
				panel.hidden = view !== 'panel'
				bubble.hidden = view !== 'bubble'
				if (view !== 'panel') resetClear()
			},

			render({ mode, groups, path, statuses, translated }) {
				const current = MODES.find((m) => m.id === mode)
				tabs.forEach((tab, i) =>
					tab.setAttribute('aria-pressed', String(MODES[i].id === mode)),
				)
				hint.replaceChildren(
					...withKeys(
						translated ? TRANSLATED_HINT : (current?.hint ?? IDLE_HINT),
					),
				)
				hint.classList.toggle('warn', translated)
				count = groups.reduce((sum, group) => sum + group.entries.length, 0)
				bubbleCount.textContent = String(count)
				bubbleCount.hidden = count === 0
				copy.textContent = count ? `Copy prompt (${count})` : 'Copy prompt'
				copy.disabled = count === 0
				clear.disabled = count === 0
				list.replaceChildren(
					...groups.map((group) => {
						const here = group.path === path
						return h(
							'div',
							{ class: 'group' },
							h(
								'div',
								{ class: 'group-head' },
								h('span', {}, group.path),
								here
									? h('span', {}, 'this page')
									: h('a', { href: group.url }, 'open ↗'),
							),
							group.entries.map((entry) =>
								renderEntry(entry, statuses.get(entry.item.id), here),
							),
						)
					}),
				)
				if (!count) list.append(h('div', { class: 'empty' }, 'No changes yet.'))
			},

			showError(message) {
				error.textContent = message
				error.hidden = !message
			},

			flashCopied(ok) {
				clearTimeout(copyTimer)
				// null means every change is already in the page source.
				copy.textContent =
					ok === null ? 'All in the source ✓' : ok ? 'Copied ✓' : 'Copy failed'
				copyTimer = setTimeout(() => {
					copy.textContent = count ? `Copy prompt (${count})` : 'Copy prompt'
				}, 1500)
			},

			flashItem(id) {
				const node = list.querySelector(`[data-id="${CSS.escape(id)}"]`)
				if (!node) return
				node.scrollIntoView({ block: 'nearest' })
				node.classList.remove('flash')
				void node.offsetWidth
				node.classList.add('flash')
			},

			flashMark(id) {
				const node = markNodes.get(id)?.box
				if (!node) return
				node.classList.remove('flash')
				void node.offsetWidth
				node.classList.add('flash')
			},

			setHover(rect, text, kind) {
				hover.hidden = hoverLabel.hidden = !rect
				if (!rect) return
				hover.dataset.kind = hoverLabel.dataset.kind = kind
				place(hover, rect)
				hoverLabel.textContent = text
				const top = rect.top >= 20 ? rect.top - 19 : rect.bottom + 3
				hoverLabel.style.transform = `translate(${Math.max(0, rect.left)}px, ${top}px)`
			},

			setEditing(rect) {
				editing.hidden = !rect
				if (rect) place(editing, rect)
			},

			layoutMarks(visible) {
				const seen = new Set()
				for (const mark of visible) {
					seen.add(mark.id)
					let node = markNodes.get(mark.id)
					if (!node) {
						node = {
							box: h('div', { class: 'mark-box' }),
							pin: h('button', {
								class: 'pin',
								onclick: () => handlers.onPin(mark.id),
							}),
						}
						marks.append(node.box, node.pin)
						markNodes.set(mark.id, node)
					}
					node.box.dataset.kind = node.pin.dataset.kind = mark.kind
					node.pin.textContent = String(mark.number)
					place(node.box, mark.rect)
					node.pin.style.transform = `translate(${mark.rect.left - 9}px, ${mark.rect.top - 9}px)`
				}
				for (const [id, node] of markNodes) {
					if (seen.has(id)) continue
					node.box.remove()
					node.pin.remove()
					markNodes.delete(id)
				}
			},

			openNote({ tag, label, template, text, existing }) {
				noteShown = {
					type: 'open',
					seq: ++noteSeq,
					tag,
					label,
					template,
					text,
					existing,
				}
				noteDraft = text
				noteFrame.hidden = false
				notePort?.postMessage(noteShown)
				noteFrame.focus()
			},

			placeNote,

			noteDraft() {
				return noteShown ? noteDraft : null
			},

			focusNote() {
				noteFrame.focus()
				notePort?.postMessage({ type: 'focus' })
			},

			closeNote() {
				noteShown = null
				noteRect = null
				noteFrame.hidden = true
			},
		}
	}

	Nota.createUI = createUI
})()

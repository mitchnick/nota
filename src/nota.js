// The controller. It intercepts page clicks while a picking mode is on, runs
// inline edits, notes, and removals, re-applies stored changes after reloads
// and re-renders, and hands state to the UI.
//
// Every frame in the tab runs a copy. The top frame's copy owns the panel, the
// view, and the mode. A copy in an iframe picks, edits, and re-applies changes
// in its own document, and follows the top frame through messages that
// background.js relays. Page scripts can neither read nor send them.
;(() => {
	const Nota = globalThis.Nota
	// Reloading the extension orphans the copy already running in each open
	// tab. A fresh injection replaces an orphaned copy instead of deferring.
	if (Nota.started && Nota.alive()) return
	Nota.teardown?.()
	Object.assign(Nota, { started: true, alive, teardown })

	const {
		store,
		describe,
		resolve,
		readText,
		wherePath,
		groupByPath,
		buildPrompt,
		snippet,
	} = Nota

	const isTop = window === top
	const MODES = ['edit', 'note', 'remove']
	const MODE_KEYS = { e: 'edit', n: 'note', r: 'remove' }
	const TYPING = /^(input|textarea|select)$/
	const INTERCEPTED = [
		'pointerdown',
		'pointerup',
		'mousedown',
		'mouseup',
		'click',
		'dblclick',
		'auxclick',
	]
	// Inline elements that only style a run of text. Chrome Translate wraps
	// every run it translates in two <font>s.
	// prettier-ignore
	const WRAPPERS = new Set([
		'font', 'span', 'b', 'strong', 'i', 'em', 'small', 'mark', 'u', 's', 'sub',
		'sup',
	])
	// Elements that exist for their text. A wrapper holding all of that text
	// stands in for the whole element.
	// prettier-ignore
	const HOLDERS = new Set([
		...WRAPPERS, 'a', 'button', 'label', 'summary', 'legend', 'caption',
		'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd',
		'blockquote',
	])
	const FRAMES = new Set(['iframe', 'frame'])

	// A page is its path and query. The query often picks what the page shows,
	// such as a tab or a filter, and tells the agent which view to change.
	const currentPath = () => location.pathname + location.search

	// Tells this copy's relayed messages apart from other frames'.
	const self = newId()

	// Changes are stored under the top frame's origin, and grouped by its page.
	// An iframe learns both from the top frame.
	let origin = isTop ? location.origin : null
	let items = []
	let path = isTop ? currentPath() : null
	let pageUrl = null // the top frame's URL, in an iframe
	// Names this iframe's document on its changes. Null in the top frame.
	let frameKey = null
	let frameId = 0 // this frame's id in the tab, for the note popover
	// A fresh tab starts in Edit. With no mode (null), clicks reach the page.
	// An iframe takes the top frame's mode.
	let mode = isTop ? (session('mode') ?? 'edit') : null
	if (!MODES.includes(mode)) mode = null
	let view = 'hidden'
	let ui = null
	let hoverEl = null
	let hoverTrail = [] // elements ↑ climbed from, for ↓
	let pointed = null // the pointer's target at the last mousemove
	let edit = null // the inline edit in progress
	let note = null // the note popover's target
	let climbed = null // the hover and trail ↑ passed up to the parent frame
	let frame = 0
	let reconcileTimer = 0
	let reported = -1
	let shownTranslated = false
	let observers = []
	let joining = null // an iframe loading its changes
	let stateSeq = 0 // orders the top frame's state messages
	let shared = '' // the state the top frame last sent its iframes
	let lastReport = '[]' // the statuses an iframe last sent the top frame
	// The top frame's record of each iframe's statuses, by the iframe's copy.
	const frameStatuses = new Map()
	// Item id → { el, ours, landed, display, priority } for this page. `ours`
	// means Nota changed the DOM and may revert it.
	const live = new Map()
	// Edits applied in this document. An edit that reads as done without being
	// in here came from the page source: the agent already shipped it.
	const appliedHere = new Set()

	function session(key, value) {
		try {
			if (value === undefined) return sessionStorage.getItem(`nota:${key}`)
			sessionStorage.setItem(`nota:${key}`, value)
		} catch {
			return null
		}
	}

	function newId() {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
	}

	function ensureUI() {
		ui ??= Nota.createUI(
			{
				onMode: toggleMode,
				onCollapse: collapse,
				onFlip: flip,
				onExpand: () => setView('panel'),
				onCopy: copyPrompt,
				onClear: clearAll,
				onDelete: deleteItem,
				onFocusItem: focusItem,
				onPin: focusPin,
				onSaveNote: saveNote,
				onCancelNote: closeNote,
			},
			{ frameId },
		)
		ui.setSide(session('side'))
		ui.mount()
		return ui
	}

	function flip() {
		const side = session('side') === 'left' ? 'right' : 'left'
		session('side', side)
		ui.setSide(side)
	}

	// View and mode

	function setView(next) {
		if (next !== 'panel') {
			finishEdit()
			closeNote()
			setHover(null)
		}
		view = next
		session('view', next)
		if (next !== 'hidden' || ui) ensureUI().setView(next)
		render()
	}

	function collapse() {
		setView(items.length ? 'bubble' : 'hidden')
	}

	function toggle() {
		if (view === 'panel') collapse()
		else setView('panel')
	}

	function setMode(next) {
		finishEdit()
		closeNote()
		setHover(null)
		mode = next
		session('mode', next ?? '')
		render()
	}

	// Picking the current mode again turns it off.
	function toggleMode(next) {
		setMode(next === mode ? null : next)
	}

	// Mode keys work in every frame. The top frame owns the mode.
	function command(key) {
		if (!isTop) return relay('top', { type: 'command', key })
		if (key === 'escape') setMode(null)
		else if (key === 'm') collapse()
		else toggleMode(MODE_KEYS[key])
	}

	function picking() {
		return view === 'panel' && Boolean(mode)
	}

	function pickable(el) {
		return (
			el?.nodeType === Node.ELEMENT_NODE &&
			el !== document.documentElement &&
			el !== document.body &&
			el !== ui?.host
		)
	}

	// Chrome Translate marks <html> and swaps the page's text for text that is
	// not in its source, so Nota would quote words the agent cannot find.
	function translated() {
		const { classList } = document.documentElement
		return (
			classList.contains('translated-ltr') ||
			classList.contains('translated-rtl')
		)
	}

	// What a click on `el` means. A shape inside an icon means the icon. A
	// wrapper holding all of a link's, button's, or heading's text means that
	// element. The wrappers climbed past come back in `trail`, so ↓ can narrow.
	function intended(el) {
		while (el.ownerSVGElement) el = el.ownerSVGElement
		const trail = []
		while (
			WRAPPERS.has(el.localName) &&
			HOLDERS.has(el.parentElement?.localName) &&
			readText(el.parentElement) === readText(el)
		) {
			trail.push(el)
			el = el.parentElement
		}
		return { el, trail }
	}

	// Rendering

	function render() {
		if (!isTop) {
			report()
			return scheduleLayout()
		}
		share()
		if (items.length !== reported) {
			reported = items.length
			try {
				chrome.runtime
					.sendMessage({ type: 'count', count: items.length })
					.catch(() => {})
			} catch {}
		}
		if (!ui) return
		shownTranslated = translated()
		ui.render({
			mode,
			groups: groupByPath(items),
			path,
			statuses: statuses(),
			translated: shownTranslated,
		})
		scheduleLayout()
	}

	function statusOf(state) {
		return state.landed ? 'landed' : state.el ? 'applied' : 'missing'
	}

	// Item id → status, for this page and every iframe on it.
	function statuses() {
		const all = new Map()
		// Two iframes can show the same page. Either one finding a change counts.
		for (const reports of frameStatuses.values()) {
			for (const [id, status] of reports) {
				if ((all.get(id) ?? 'missing') === 'missing') all.set(id, status)
			}
		}
		for (const [id, state] of live) all.set(id, statusOf(state))
		return all
	}

	function scheduleLayout() {
		if (ui && !frame) frame = requestAnimationFrame(layout)
	}

	function layout() {
		frame = 0
		const marks = []
		if (view === 'panel') {
			for (const group of groupByPath(items)) {
				if (group.path !== path) continue
				for (const { item, number } of group.entries) {
					const el = live.get(item.id)?.el
					if (!el || item.kind === 'remove') continue
					const rect = el.getBoundingClientRect()
					if (rect.width || rect.height)
						marks.push({ id: item.id, number, kind: item.kind, rect })
				}
			}
		}
		ui.layoutMarks(marks)
		if (hoverEl?.isConnected) {
			ui.setHover(hoverEl.getBoundingClientRect(), hoverLabel(hoverEl), mode)
		} else {
			ui.setHover(null)
		}
		ui.setEditing(edit ? edit.el.getBoundingClientRect() : null)
		if (note) ui.placeNote(note.el.getBoundingClientRect())
	}

	function hoverLabel(el) {
		if (translated()) return 'translated · show the original first'
		if (mode === 'edit' && !readText(el)) return `${el.localName} · no text`
		// ↑ at the top of an iframe reaches the iframe itself.
		return pickable(el.parentElement) || !isTop
			? `${el.localName} · ↑ parent`
			: el.localName
	}

	function setHover(el) {
		hoverEl = el
		if (!el) {
			hoverTrail = []
			pointed = null
		}
		scheduleLayout()
	}

	// Frames

	// Sends a message through background.js to the top frame ('top') or to
	// every frame in the tab ('all'). Resolves to the first reply.
	function relay(to, message) {
		try {
			return chrome.runtime
				.sendMessage({ type: 'relay', to, message: { ...message, from: self } })
				.catch(() => undefined)
		} catch {
			return Promise.resolve()
		}
	}

	function snapshot() {
		return {
			type: 'state',
			seq: stateSeq,
			origin,
			path,
			url: location.href,
			view,
			mode,
		}
	}

	// Tells the tab's iframes when the top frame's view, mode, or page changes.
	function share() {
		const next = JSON.stringify([view, mode, path])
		if (next === shared) return
		shared = next
		stateSeq++
		relay('all', snapshot())
	}

	// An iframe follows the top frame's state and drops any that arrives late.
	function follow(state) {
		if (!state || state.seq < stateSeq) return
		stateSeq = state.seq
		joining ??= join(state.origin)
		joining.then(() => adopt(state))
	}

	// Loads the changes once the top frame names the origin they live under.
	async function join(topOrigin) {
		origin = topOrigin
		frameKey = currentFrame()
		listen()
		try {
			items = await store.load(origin)
		} catch {
			return
		}
		store.onChange(origin, onStoreChange)
		observe()
	}

	function adopt(state) {
		if (state.view !== 'panel' || state.mode !== mode) {
			finishEdit()
			closeNote()
			setHover(null)
			climbed = null
		}
		view = state.view
		mode = state.mode
		pageUrl = state.url
		// A new page in the top frame takes the old page's changes with it.
		if (state.path !== path) {
			for (const item of items) revert(item)
			live.clear()
			path = state.path
		}
		if (view === 'panel') ensureUI()
		reconcile()
		render()
	}

	// Tells the top frame's panel which of this frame's changes it found.
	function report() {
		const statuses = [...live].map(([id, state]) => [id, statusOf(state)])
		const next = JSON.stringify(statuses)
		if (next === lastReport) return
		lastReport = next
		relay('top', { type: 'status', statuses })
	}

	function leave() {
		relay('top', { type: 'status', statuses: [] })
	}

	// Names this iframe's document on its changes: its path on the top frame's
	// origin, or its URL on another. Inline content has no address of its own,
	// so it goes by the iframe's place in the parent page when Nota can see it.
	function currentFrame() {
		if (isTop) return null
		if (/^(https?|file):$/.test(location.protocol)) {
			return location.origin === origin
				? currentPath()
				: location.href.split('#')[0]
		}
		const source =
			location.protocol === 'about:'
				? location.href
				: `${location.protocol.slice(0, -1)} URL`
		return frameElement ? `${wherePath(frameElement)} (${source})` : source
	}

	// Whether a change belongs to this document.
	function mine(item) {
		return item.path === path && (item.frame ?? null) === frameKey
	}

	// Whether this document shows another page than its changes were for.
	function moved() {
		return isTop ? currentPath() !== path : currentFrame() !== frameKey
	}

	// Where this frame sits in the tab: its index among its parent's frames,
	// then the parent's, up to the top. Chrome hides which <iframe> holds a
	// frame, and a parent frame hears nothing while the pointer moves between
	// iframes, but window.frames works across origins.
	function framePath() {
		const indexes = []
		for (let w = window; w !== w.parent; w = w.parent) {
			let i = 0
			while (i < w.parent.length && w.parent[i] !== w) i++
			indexes.unshift(i)
		}
		return indexes.join('.')
	}

	// The <iframe> in this document that holds the frame at `childPath`, or on
	// the way to it.
	function frameToward(childPath) {
		const own = framePath()
		const prefix = own ? `${own}.` : ''
		if (!childPath.startsWith(prefix)) return null
		const child = frames[childPath.slice(prefix.length).split('.')[0]]
		for (const el of document.querySelectorAll('iframe, frame')) {
			if (el.contentWindow === child) return el
		}
		return null
	}

	function childPathOf(el) {
		const own = framePath()
		for (let i = 0; i < frames.length; i++) {
			if (frames[i] === el.contentWindow) return own ? `${own}.${i}` : `${i}`
		}
		return null
	}

	function onMessage(message, sender, respond) {
		if (message.from === self) return
		const { type } = message
		if (isTop && type === 'toggle') {
			toggle()
		} else if (isTop && type === 'hello') {
			respond(snapshot())
		} else if (isTop && type === 'command') {
			command(message.key)
		} else if (isTop && type === 'status') {
			if (message.statuses.length)
				frameStatuses.set(message.from, message.statuses)
			else frameStatuses.delete(message.from)
			render()
		} else if (isTop && type === 'flash') {
			ui?.flashItem(message.id)
		} else if (!isTop && type === 'state') {
			follow(message)
		} else if (type === 'finish') {
			// Saves an edit still open here, before a click elsewhere or a copy.
			const saving = finishEdit()
			if (!saving) return
			saving.then(() => respond(true))
			return true
		} else if (type === 'focus') {
			const item = items.find((i) => i.id === message.id)
			if (item && mine(item)) reveal(item)
		} else if (type === 'arrow') {
			if (picking() && hoverEl) arrow(message.key)
		} else if (type === 'climb') {
			// ↑ at the top of a child frame hovers its <iframe>.
			const el = frameToward(message.path)
			if (el && picking() && childPathOf(el) === message.path) {
				climbed = null
				hoverTrail = []
				setHover(el)
			}
		} else if (type === 'descend') {
			if (climbed && message.path === framePath()) {
				const { el, trail } = climbed
				climbed = null
				setHover(el)
				hoverTrail = trail
			}
		} else if (type === 'pick') {
			// A click inside a frame whose hover ↑ passed up to this one. Every
			// frame ↑ passed through hovers again from the next move.
			climbed = null
			const el = frameToward(message.path)
			if (el && picking() && hoverEl?.contains(el)) choose(hoverEl)
		} else if (type === 'note') {
			// One note at a time, unless the open one holds a draft.
			if (note && !ui.noteDraft().trim()) closeNote()
		}
	}

	// Page events. These listen on window in the capture phase, so they run
	// before the page's own handlers and can keep clicks from reaching them.
	// They skip events a page script dispatched, so a page cannot pick
	// elements, move the hover, or switch modes on your behalf.

	function onPointer(event) {
		if (!event.isTrusted || view !== 'panel' || orphaned() || ui.owns(event))
			return
		if (edit?.el.contains(event.target)) {
			// Let the caret move, but keep page handlers and link or submit
			// defaults out of it.
			event.stopImmediatePropagation()
			if (event.type === 'click' || event.type === 'auxclick')
				event.preventDefault()
			return
		}
		if (!mode) return
		event.preventDefault()
		event.stopImmediatePropagation()
		if (event.type === 'pointerdown') {
			// A click in one frame leaves focus in another, and with it any
			// edit open there.
			finishEdit()
			relay('all', { type: 'finish' })
		}
		if (event.type !== 'click' || event.button !== 0) return
		// ↑ passed the hover up to this iframe's <iframe>, so its frame picks.
		if (climbed) {
			climbed = null
			relay('all', { type: 'pick', path: framePath() })
			return
		}
		choose(
			hoverEl?.contains(event.target) ? hoverEl : intended(event.target).el,
			event,
		)
	}

	function onMove(event) {
		if (!event.isTrusted) return
		if (
			!picking() ||
			orphaned() ||
			ui.owns(event) ||
			edit?.el.contains(event.target)
		) {
			if (hoverEl) setHover(null)
			return
		}
		// The parent frame holds the hover until the pointer leaves.
		if (climbed) return
		// Moves within one element keep whatever ↑ or ↓ chose.
		if (event.target === pointed) return
		pointed = event.target
		// After ↑, keep the wider target while the pointer stays inside it.
		if (hoverTrail.length && hoverEl?.contains(event.target)) return
		// An iframe shows another document, and Nota runs in there too. ↑ from
		// inside reaches the iframe itself.
		const target =
			pickable(event.target) && !FRAMES.has(event.target.localName)
				? intended(event.target)
				: { el: null, trail: [] }
		hoverTrail = target.trail
		if (target.el !== hoverEl) setHover(target.el)
	}

	// A frame sees the pointer enter an iframe as a mouseover on the <iframe>,
	// and then nothing while it stays inside. The iframe's copy takes over the
	// hover.
	function onOver(event) {
		if (!event.isTrusted || !FRAMES.has(event.target.localName)) return
		if (hoverEl) setHover(null)
	}

	function onOut(event) {
		if (!event.isTrusted) return
		// The pointer left this document, for a parent frame or the desktop.
		if (!event.relatedTarget) {
			climbed = null
			if (hoverEl) setHover(null)
		}
	}

	function onKey(event) {
		if (!event.isTrusted || view !== 'panel' || orphaned()) return
		if (edit) {
			if (!edit.el.contains(event.target)) return
			event.stopImmediatePropagation()
			if (event.isComposing) return
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault()
				finishEdit()
			} else if (event.key === 'Escape') {
				event.preventDefault()
				cancelEdit()
			}
			return
		}
		const target = event.target
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
		if (target?.isContentEditable || TYPING.test(target?.localName)) return
		const key = event.key.toLowerCase()
		if (MODE_KEYS[key] || key === 'm') {
			stop(event)
			command(key)
		} else if (!picking()) {
			return
		} else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			if (arrow(event.key)) {
				stop(event)
			} else if (frames.length || !isTop) {
				// Keys go to the focused frame, and the hover may sit in another.
				stop(event)
				relay('all', { type: 'arrow', key: event.key })
			}
		} else if (event.key === 'Escape') {
			stop(event)
			command('escape')
		}
	}

	function stop(event) {
		event.preventDefault()
		event.stopImmediatePropagation()
	}

	// ↑ widens the hover to the parent element, and at the top of an iframe,
	// to the iframe in the parent frame. ↓ narrows it back.
	function arrow(key) {
		if (!hoverEl) return false
		if (key === 'ArrowUp' && pickable(hoverEl.parentElement)) {
			hoverTrail.push(hoverEl)
			hoverEl = hoverEl.parentElement
			scheduleLayout()
		} else if (key === 'ArrowUp' && !isTop) {
			climbed = { el: hoverEl, trail: hoverTrail }
			setHover(null)
			relay('all', { type: 'climb', path: framePath() })
		} else if (key === 'ArrowDown' && hoverTrail.length) {
			hoverEl = hoverTrail.pop()
			scheduleLayout()
		} else if (key === 'ArrowDown' && FRAMES.has(hoverEl.localName)) {
			relay('all', { type: 'descend', path: childPathOf(hoverEl) })
			setHover(null)
		} else {
			return false
		}
		return true
	}

	// Picks `el`, unless a note with a draft is open.
	function choose(el, point) {
		if (note) {
			if (ui.noteDraft().trim()) return ui.focusNote()
			closeNote()
		}
		pick(el, point)
	}

	function pick(el, point) {
		if (!pickable(el) || translated()) return
		if (mode === 'edit') startEdit(el, point)
		else if (mode === 'note') openNote(el)
		else if (mode === 'remove') removeElement(el)
	}

	// Edit copy

	function startEdit(el, point) {
		finishEdit()
		const item = items.find(
			(i) => i.kind === 'edit' && live.get(i.id)?.el === el,
		)
		const text = readText(el)
		if (!text && !item) return
		edit = {
			el,
			item,
			info: item ? null : describe(el),
			startHtml: el.innerHTML,
			before: item?.before ?? text,
			beforeHtml: item?.beforeHtml ?? el.innerHTML,
			editable: el.getAttribute('contenteditable'),
		}
		el.setAttribute('contenteditable', 'plaintext-only')
		el.addEventListener('blur', finishEdit)
		el.focus({ preventScroll: true })
		placeCaret(el, point)
		setHover(null)
	}

	function placeCaret(el, point) {
		const selection = getSelection()
		let range =
			point && document.caretRangeFromPoint?.(point.clientX, point.clientY)
		if (!range || !el.contains(range.startContainer)) {
			range = document.createRange()
			range.selectNodeContents(el)
			range.collapse(false)
		}
		selection.removeAllRanges()
		selection.addRange(range)
	}

	function endEdit() {
		const current = edit
		edit = null
		current.el.removeEventListener('blur', finishEdit)
		if (current.editable === null) current.el.removeAttribute('contenteditable')
		else current.el.setAttribute('contenteditable', current.editable)
		const selection = getSelection()
		if (selection.anchorNode && current.el.contains(selection.anchorNode))
			selection.removeAllRanges()
		scheduleLayout()
		return current
	}

	function finishEdit() {
		if (!edit) return
		const { el, item, info, before, beforeHtml } = endEdit()
		const after = readText(el)
		if (item) {
			if (after === item.after) return
			if (after === item.before) {
				dropItem(item)
			} else {
				item.after = after
				item.afterHtml = el.innerHTML
			}
		} else if (after !== before) {
			const created = {
				...base('edit', info),
				text: before,
				before,
				after,
				beforeHtml,
				afterHtml: el.innerHTML,
			}
			items.push(created)
			live.set(created.id, { el, ours: true })
			appliedHere.add(created.id)
		} else {
			return
		}
		return persist()
	}

	function cancelEdit() {
		if (!edit) return
		const { el, startHtml } = endEdit()
		if (el.innerHTML !== startHtml) el.innerHTML = startHtml
	}

	// Notes

	function openNote(el, item = null) {
		finishEdit()
		const info = item ?? describe(el)
		note = { el, item, info }
		ensureUI().openNote({
			tag: info.tag,
			label: snippet(info.text, 80),
			template: info.template,
			text: item?.note ?? '',
			existing: Boolean(item),
		})
		setHover(null)
		relay('all', { type: 'note' })
	}

	function saveNote(text) {
		if (!note) return
		const { el, item, info } = note
		const body = text.trim()
		closeNote()
		if (item && body) {
			item.note = body
		} else if (item) {
			dropItem(item)
		} else if (body) {
			const created = { ...base('note', info), note: body }
			items.push(created)
			live.set(created.id, { el })
		} else {
			return
		}
		persist()
	}

	function closeNote() {
		if (!note) return
		note = null
		ui.closeNote()
	}

	// Remove

	function removeElement(el) {
		const created = base('remove', describe(el))
		items.push(created)
		live.set(created.id, hide(el))
		setHover(null)
		persist()
	}

	function hide(el) {
		const state = {
			el,
			ours: true,
			display: el.style.getPropertyValue('display'),
			priority: el.style.getPropertyPriority('display'),
		}
		el.style.setProperty('display', 'none', 'important')
		return state
	}

	// Items

	function base(kind, info) {
		return {
			id: newId(),
			kind,
			path,
			url: isTop ? location.href : pageUrl,
			frame: frameKey,
			...info,
			createdAt: Date.now(),
		}
	}

	function dropItem(item) {
		items = items.filter((i) => i !== item)
		live.delete(item.id)
	}

	function deleteItem(id) {
		const item = items.find((i) => i.id === id)
		if (!item) return
		if (edit?.item === item) cancelEdit()
		if (note?.item === item) closeNote()
		revert(item)
		dropItem(item)
		persist()
	}

	function clearAll() {
		finishEdit()
		closeNote()
		for (const item of items) revert(item)
		items = []
		live.clear()
		persist()
	}

	function focusItem(id) {
		const item = items.find((i) => i.id === id)
		if (!item) return
		if (item.path !== path) {
			location.href = item.url
			return
		}
		if (mine(item)) reveal(item)
		else relay('all', { type: 'focus', id })
	}

	function reveal(item) {
		const el = live.get(item.id)?.el
		if (!el || item.kind === 'remove') return
		el.scrollIntoView({ block: 'center', behavior: 'smooth' })
		ensureUI().flashMark(item.id)
		if (item.kind === 'note') openNote(el, item)
	}

	function focusPin(id) {
		if (isTop) ui.flashItem(id)
		else relay('top', { type: 'flash', id })
		const item = items.find((i) => i.id === id)
		const el = live.get(id)?.el
		if (item?.kind === 'note' && el) openNote(el, item)
	}

	async function copyPrompt() {
		finishEdit()
		// An edit still open in an iframe saves first, and then the prompt
		// reads the saved list, which has it.
		const saved = await relay('all', { type: 'finish' })
		const all = saved ? await store.load(origin).catch(() => items) : items
		// Changes the agent already shipped stay out of the prompt.
		const landed = new Set()
		for (const [id, status] of statuses()) {
			if (status === 'landed') landed.add(id)
		}
		const prompt = buildPrompt(all, { origin, landed })
		ui.flashCopied(prompt ? await copyText(prompt) : null)
	}

	// background.js writes the clipboard from an offscreen document. A copy
	// made here fires a copy event that the page's handler could rewrite, and
	// the page's Permissions-Policy can block the async clipboard.
	async function copyText(text) {
		try {
			return (await chrome.runtime.sendMessage({ type: 'copy', text })) === true
		} catch {
			return false
		}
	}

	async function persist() {
		render()
		try {
			await store.save(origin, items)
			ui?.showError('')
		} catch {
			ui?.showError(
				'Nota was updated. Reload this page to keep saving changes.',
			)
		}
	}

	// Applying stored changes to the page

	// Swapping a lone text node's data keeps framework-owned nodes in place.
	// Anything with markup falls back to innerHTML.
	function setContent(el, text, html) {
		const lone =
			el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE
		if (lone && !/[<&]/.test(html)) el.firstChild.data = text
		else el.innerHTML = html
	}

	function apply(item, el) {
		if (item.kind === 'remove') return hide(el)
		if (item.kind === 'note') return { el }
		if (readText(el) === item.before) {
			setContent(el, item.after, item.afterHtml)
			appliedHere.add(item.id)
			return { el, ours: true }
		}
		const ours = appliedHere.has(item.id)
		return { el, ours, landed: !ours }
	}

	function revert(item) {
		const state = live.get(item.id)
		if (!state?.el || !state.ours) return
		if (item.kind === 'edit' && readText(state.el) === item.after) {
			setContent(state.el, item.before, item.beforeHtml)
		} else if (item.kind === 'remove') {
			if (state.display)
				state.el.style.setProperty('display', state.display, state.priority)
			else state.el.style.removeProperty('display')
		}
	}

	function holds(item, el) {
		if (item.kind === 'edit') return readText(el) === item.after
		if (item.kind === 'remove')
			return el.style.getPropertyValue('display') === 'none'
		return true
	}

	// Re-applies this page's changes after a reload, a framework re-render, or
	// an SPA or Turbo navigation.
	function reconcile() {
		if (edit) return
		let changed = false
		if (moved()) {
			if (isTop) path = currentPath()
			else frameKey = currentFrame()
			live.clear()
			closeNote()
			setHover(null)
			changed = true
		}
		for (const item of items) {
			if (!mine(item)) continue
			const state = live.get(item.id)
			if (state?.el?.isConnected && holds(item, state.el)) continue
			const el = resolve(item)
			if (!el && state && !state.el) continue
			live.set(item.id, el ? apply(item, el) : { el: null })
			changed = true
		}
		if (changed) render()
		else scheduleLayout()
	}

	function onStoreChange(next) {
		if (JSON.stringify(next) === JSON.stringify(items)) return
		const incoming = new Map(next.map((item) => [item.id, item]))
		for (const item of items) {
			const updated = incoming.get(item.id)
			if (updated && JSON.stringify(updated) === JSON.stringify(item)) continue
			if (edit?.item === item) cancelEdit()
			if (note?.item === item) closeNote()
			revert(item)
			live.delete(item.id)
		}
		items = next
		reconcile()
		render()
	}

	function observe() {
		const page = new MutationObserver(() => {
			if (reconcileTimer) return
			reconcileTimer = setTimeout(() => {
				reconcileTimer = 0
				if (ui && view !== 'hidden') ui.mount()
				if (items.length || moved()) reconcile()
			}, 250)
		})
		page.observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
		})
		// Translating the page, or showing the original again, toggles a class
		// on <html>.
		const html = new MutationObserver(() => {
			if (translated() !== shownTranslated) render()
		})
		html.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class'],
		})
		observers = [page, html]
	}

	function alive() {
		return Boolean(chrome.runtime?.id)
	}

	function orphaned() {
		if (alive()) return false
		teardown()
		return true
	}

	function teardown() {
		cancelEdit()
		for (const type of INTERCEPTED) removeEventListener(type, onPointer, true)
		removeEventListener('mousemove', onMove, true)
		removeEventListener('mouseover', onOver, true)
		removeEventListener('mouseout', onOut, true)
		removeEventListener('keydown', onKey, true)
		removeEventListener('scroll', scheduleLayout, true)
		removeEventListener('resize', scheduleLayout)
		removeEventListener('pagehide', leave)
		for (const observer of observers) observer.disconnect()
		clearTimeout(reconcileTimer)
		ui?.host.remove()
		ui = null
		view = 'hidden'
	}

	function listen() {
		for (const type of INTERCEPTED) addEventListener(type, onPointer, true)
		addEventListener('mousemove', onMove, true)
		addEventListener('mouseover', onOver, true)
		addEventListener('mouseout', onOut, true)
		addEventListener('keydown', onKey, true)
		addEventListener('scroll', scheduleLayout, { capture: true, passive: true })
		addEventListener('resize', scheduleLayout)
		if (!isTop) addEventListener('pagehide', leave)
	}

	async function start() {
		// An orphaned copy in another content-script world leaves its root behind.
		for (const stray of document.querySelectorAll('nota-root')) stray.remove()
		chrome.runtime.onMessage.addListener(onMessage)
		if (!isTop) {
			// The top frame answers now if it is running, and otherwise sends
			// its state once it starts.
			try {
				frameId = await chrome.runtime.sendMessage({ type: 'frame' })
			} catch {
				return
			}
			follow(await relay('top', { type: 'hello' }))
			return
		}

		listen()
		try {
			items = await store.load(origin)
		} catch {
			return
		}
		store.onChange(origin, onStoreChange)
		reconcile()
		if (session('view') === 'panel') setView('panel')
		else if (items.length) setView('bubble')
		else render()
		observe()
	}

	start()
})()

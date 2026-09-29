// The controller. It intercepts page clicks while a picking mode is on, runs
// inline edits, notes, and removals, re-applies stored changes after reloads
// and re-renders, and hands state to the UI.
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
		groupByPath,
		buildPrompt,
		snippet,
	} = Nota

	const origin = location.origin
	const MODES = ['edit', 'note', 'remove', 'browse']
	const MODE_KEYS = { e: 'edit', n: 'note', r: 'remove', b: 'browse' }
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

	let items = []
	let path = location.pathname
	let mode = MODES.includes(session('mode')) ? session('mode') : 'edit'
	let view = 'hidden'
	let ui = null
	let hoverEl = null
	let hoverTrail = [] // elements ↑ climbed from, for ↓
	let pointed = null // the pointer's target at the last mousemove
	let edit = null // the inline edit in progress
	let note = null // the note popover's target
	let frame = 0
	let reconcileTimer = 0
	let reported = -1
	let shownTranslated = false
	let observers = []
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
		ui ??= Nota.createUI({
			onMode: setMode,
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
		})
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
		session('mode', next)
		render()
	}

	function picking() {
		return view === 'panel' && mode !== 'browse'
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
		if (items.length !== reported) {
			reported = items.length
			try {
				chrome.runtime
					.sendMessage({ type: 'count', count: items.length })
					.catch(() => {})
			} catch {}
		}
		if (!ui) return
		const statuses = new Map()
		for (const [id, state] of live) {
			statuses.set(
				id,
				state.landed ? 'landed' : state.el ? 'applied' : 'missing',
			)
		}
		shownTranslated = translated()
		ui.render({
			mode,
			groups: groupByPath(items),
			path,
			statuses,
			translated: shownTranslated,
		})
		scheduleLayout()
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
		return pickable(el.parentElement)
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
		if (mode === 'browse') return
		event.preventDefault()
		event.stopImmediatePropagation()
		if (event.type === 'pointerdown') finishEdit()
		if (event.type !== 'click' || event.button !== 0) return
		if (note) {
			if (ui.noteDraft().trim()) return ui.focusNote()
			closeNote()
		}
		pick(
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
		// Moves within one element keep whatever ↑ or ↓ chose.
		if (event.target === pointed) return
		pointed = event.target
		// After ↑, keep the wider target while the pointer stays inside it.
		if (hoverTrail.length && hoverEl?.contains(event.target)) return
		const target = pickable(event.target)
			? intended(event.target)
			: { el: null, trail: [] }
		hoverTrail = target.trail
		if (target.el !== hoverEl) setHover(target.el)
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
		const next = MODE_KEYS[event.key.toLowerCase()]
		if (next) {
			stop(event)
			setMode(next)
		} else if (!picking()) {
			return
		} else if (
			event.key === 'ArrowUp' &&
			hoverEl &&
			pickable(hoverEl.parentElement)
		) {
			stop(event)
			hoverTrail.push(hoverEl)
			hoverEl = hoverEl.parentElement
			scheduleLayout()
		} else if (event.key === 'ArrowDown' && hoverTrail.length) {
			stop(event)
			hoverEl = hoverTrail.pop()
			scheduleLayout()
		} else if (event.key === 'Escape') {
			stop(event)
			setMode('browse')
		}
	}

	function stop(event) {
		event.preventDefault()
		event.stopImmediatePropagation()
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
		persist()
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
			heading: `<${info.tag}> ${snippet(info.text, 40)}`,
			template: info.template,
			text: item?.note ?? '',
			existing: Boolean(item),
		})
		setHover(null)
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
			url: location.href,
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
		const el = live.get(id)?.el
		if (!el || item.kind === 'remove') return
		el.scrollIntoView({ block: 'center', behavior: 'smooth' })
		ui.flashMark(id)
		if (item.kind === 'note') openNote(el, item)
	}

	function focusPin(id) {
		ui.flashItem(id)
		const item = items.find((i) => i.id === id)
		const el = live.get(id)?.el
		if (item?.kind === 'note' && el) openNote(el, item)
	}

	async function copyPrompt() {
		finishEdit()
		ui.flashCopied(await copyText(buildPrompt(items, { origin })))
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
		if (location.pathname !== path) {
			path = location.pathname
			live.clear()
			closeNote()
			setHover(null)
			changed = true
		}
		for (const item of items) {
			if (item.path !== path) continue
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
				if (items.length || location.pathname !== path) reconcile()
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
		removeEventListener('keydown', onKey, true)
		removeEventListener('scroll', scheduleLayout, true)
		removeEventListener('resize', scheduleLayout)
		for (const observer of observers) observer.disconnect()
		clearTimeout(reconcileTimer)
		ui?.host.remove()
		ui = null
		view = 'hidden'
	}

	async function start() {
		// An orphaned copy in another content-script world leaves its root behind.
		for (const stray of document.querySelectorAll('nota-root')) stray.remove()
		for (const type of INTERCEPTED) addEventListener(type, onPointer, true)
		addEventListener('mousemove', onMove, true)
		addEventListener('keydown', onKey, true)
		addEventListener('scroll', scheduleLayout, { capture: true, passive: true })
		addEventListener('resize', scheduleLayout)
		chrome.runtime.onMessage.addListener((message) => {
			if (message.type === 'toggle') toggle()
		})

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

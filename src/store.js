// Changes live in chrome.storage.local, one record per origin, so they survive
// reloads and show up in every tab on the same site until Clear.
;(() => {
	const Nota = globalThis.Nota
	const keyFor = (origin) => `nota:${origin}`
	// Tags this tab's writes so onChange reports only other tabs' changes.
	const writer = Math.random().toString(36).slice(2)

	async function load(origin) {
		const key = keyFor(origin)
		const data = await chrome.storage.local.get(key)
		return data[key]?.items ?? []
	}

	async function save(origin, items) {
		const key = keyFor(origin)
		if (items.length)
			await chrome.storage.local.set({ [key]: { items, writer } })
		else await chrome.storage.local.remove(key)
	}

	function onChange(origin, callback) {
		const key = keyFor(origin)
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== 'local' || !(key in changes)) return
			const record = changes[key].newValue
			if (record?.writer !== writer) callback(record?.items ?? [])
		})
	}

	Nota.store = { load, save, onChange }
})()

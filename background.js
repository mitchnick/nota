// Toolbar icon and ⌥⇧N toggle the panel. Content scripts report their change
// count so the icon badge shows it, and hand over the prompt to copy. Nota's
// copies in a tab's frames reach each other through here.

const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0].js

// Knox's Ubud accent and base background. The badge API takes hex, not oklch.
chrome.action.setBadgeBackgroundColor({ color: '#ffaa54' })
chrome.action.setBadgeTextColor({ color: '#091109' })

// The top frame owns the panel.
const TOP = { frameId: 0 }

chrome.action.onClicked.addListener(async (tab) => {
	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, TOP)
	} catch {
		// The tab loaded before Nota was installed or reloaded. Inject, then toggle.
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id, allFrames: true },
				files: CONTENT_SCRIPTS,
			})
			await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, TOP)
		} catch {
			// chrome:// pages, the Web Store, and PDFs refuse content scripts.
		}
	}
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!sender.tab) return
	if (message.type === 'count') {
		chrome.action.setBadgeText({
			tabId: sender.tab.id,
			text: message.count ? String(message.count) : '',
		})
	} else if (message.type === 'copy') {
		copy(message.text).then(sendResponse, () => sendResponse(false))
		return true
	} else if (message.type === 'frame') {
		// A frame's id, for its note popover to connect back to it.
		sendResponse(sender.frameId)
	} else if (message.type === 'relay') {
		// Passes a message to the top frame, or to every frame in the tab, and
		// returns the first reply.
		chrome.tabs
			.sendMessage(
				sender.tab.id,
				message.message,
				message.to === 'top' ? TOP : {},
			)
			.then(sendResponse, () => sendResponse())
		return true
	}
})

// Copies the prompt in an offscreen document, where the page cannot see the
// copy event or change what lands on the clipboard.
let creating = null

async function copy(text) {
	if (!(await chrome.offscreen.hasDocument())) {
		creating ??= chrome.offscreen
			.createDocument({
				url: 'pages/offscreen.html',
				reasons: ['CLIPBOARD'],
				justification: 'Copy the prompt out of the page’s reach.',
			})
			.finally(() => {
				creating = null
			})
		await creating
	}
	return chrome.runtime.sendMessage({ type: 'offscreen-copy', text })
}

// Toolbar icon and ⌥⇧N toggle the panel. Content scripts report their change
// count so the icon badge shows it, and hand over the prompt to copy.

const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0].js

// Knox's Ubud accent and base background. The badge API takes hex, not oklch.
chrome.action.setBadgeBackgroundColor({ color: '#ffaa54' })
chrome.action.setBadgeTextColor({ color: '#091109' })

chrome.action.onClicked.addListener(async (tab) => {
	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
	} catch {
		// The tab loaded before Nota was installed or reloaded. Inject, then toggle.
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				files: CONTENT_SCRIPTS,
			})
			await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
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

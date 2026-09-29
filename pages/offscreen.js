// Writes the prompt to the clipboard for background.js. A copy made in the
// page fires a copy event there, and the page's handler can swap in its own
// text. This document is out of the page's reach.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type !== 'offscreen-copy' || sender.tab) return
	const area = document.querySelector('textarea')
	area.value = message.text
	area.select()
	sendResponse(document.execCommand('copy'))
	area.value = ''
})

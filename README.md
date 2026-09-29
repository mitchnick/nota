# Nota

Mark up any web page, then hand the changes to your coding agent. Edit copy in place, leave notes on elements, and remove elements. Nota keeps every change on the page, across reloads, until you hit Clear. **Copy prompt** turns them all into one numbered prompt.

Inspired by [Jesse Hanley's extension](https://x.com/jessethanley/status/2103333210042278254). Nota adds Remove, persistence, and Rails view-file lookup.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Nota. Click its icon, or press **⌥⇧N**, to open the panel.

After you pull changes, click reload on the extension card, then reload open tabs.

## Use

| Mode   | Key | Click does                                                   |
| ------ | --- | ------------------------------------------------------------ |
| Edit   | E   | Edits the text in place. Enter saves. Esc reverts.           |
| Note   | N   | Opens a note on the element. ⌘↵ saves.                       |
| Remove | R   | Hides the element and logs a removal.                        |
| Browse | B   | Nothing. The page works normally, and your changes stay put. |

- **↑** widens the target to the parent element. **↓** narrows it back.
- A click on a styled run of text that fills a link, button, heading, or paragraph picks that whole element. A click on an icon picks the whole icon. **↓** narrows to the inner element.
- **Esc** in a picking mode switches to Browse.
- While Edit, Note, or Remove is on, clicks never reach the page. Links do not navigate, and page handlers do not fire.
- The panel lists changes by page, numbered to match the pins on the page. Click a change to scroll to it. Hover it and click **×** to delete it and revert the page. **open ↗** jumps to another page's changes.
- **⇆** moves the panel to the other corner. **▾** collapses it to a bubble.
- **Clear** takes two clicks. It reverts the page and forgets every change for the site.

Changes live in `chrome.storage.local`, one list per origin. Every tab on the site shares that list. Nota re-applies changes after reloads, framework re-renders, and Turbo visits. Once an edit reaches the page source, the panel marks it **✓ Already in the page source**. That means your agent shipped it.

## Rails view files

Turn this on in `config/environments/development.rb`:

```ruby
config.action_view.annotate_rendered_view_with_filenames = true
```

Rails then wraps each template in `<!-- BEGIN … -->` / `<!-- END … -->` comments. Nota reads them and names the template that rendered each element, ViewComponent templates included. The agent opens the right file instead of grepping.

## The prompt

```
# Page changes for http://localhost:3000

Apply each change below to the source code behind this site. …

## /

Language: en

1. Edit copy in <h1>
   View: app/views/pages/home.html.erb
   Where: section#hero > h1
   From: "Email marketing platform that people love."
   To:   "Email marketing that people love."

2. Note on <a> "Book a demo"
   View: app/views/pages/_cta.html.erb
   Where: div.cta > a.button
   Note: Remove this button.

3. Remove <section> "Trusted by 10,000 companies"
   View: app/views/pages/home.html.erb
   Where: main > section.logos
   Delete this element.
```

"Where" drops Tailwind utility classes and keeps semantic ones. "View" and "Language" appear only when Nota knows them, and the intro explains only the fields the prompt uses. "Language" comes from the page's `lang` attribute. A page marked up in more than one language names it on each change.

## Security

Nota runs on every page you open, so it treats each page as hostile.

- Page scripts cannot read or drive the panel. Its shadow root is closed, and Nota ignores keys, clicks, and pointer moves that scripts dispatch.
- You type notes in an extension iframe. The page cannot see those keystrokes or type into the note.
- **Copy prompt** writes the clipboard from an offscreen document, so no page copy handler can swap in its own text.
- A page controls its own text, and it can hide text inside an element you pick. The prompt tells your agent that only the Note lines are instructions. Still read a prompt from a site you do not control before you paste it.
- Edits happen in the page itself, so the page sees them and can change them.
- Nota makes no network requests. Your changes stay in `chrome.storage.local`.

## Limits

- Nota runs in the top frame only, so it cannot reach iframes.
- It cannot pick elements inside a page's own shadow DOM (web components).
- Edits change text only. Existing inline markup such as links stays, but you cannot add markup.
- Nota will not mark up a page while Chrome has it translated, since the translation is not in your source. Show the original first.
- Chrome blocks extensions on `chrome://` pages, the Web Store, and its PDF viewer.

## Development

There is no build step. The content scripts are plain JS files that share a `Nota` namespace. They load in the order `manifest.json` lists them. The note popover and the clipboard writer are extension pages in `pages/`.

| File                | Job                                                                       |
| ------------------- | ------------------------------------------------------------------------- |
| `background.js`     | Toolbar icon and ⌥⇧N toggle. Change-count badge. Copies the prompt.       |
| `src/text.js`       | Creates the namespace. Whitespace helpers and the `h()` DOM builder.      |
| `src/prompt.js`     | Groups, numbers, and formats changes into the prompt. Pure.               |
| `src/locate.js`     | Source-like text, selectors, breadcrumbs, Rails template lookup.          |
| `src/store.js`      | One `chrome.storage.local` record per origin. Cross-tab updates.          |
| `src/ui.js`         | Closed shadow-DOM panel, pins, outlines, and the note frame. Render only. |
| `src/ui-css.js`     | The UI's styles, in Knox's Ubud theme. Registers the bundled fonts.       |
| `src/nota.js`       | Controller: modes, click interception, apply and revert, re-apply.        |
| `pages/note.*`      | The note popover, in an iframe the page cannot read or type into.         |
| `pages/offscreen.*` | Writes the clipboard where the page cannot see the copy.                  |
| `fonts/`            | Schibsted Grotesk and Martian Mono, Knox's UI faces. Latin subset. OFL.   |

```sh
npm install
npm test          # unit tests plus Playwright tests that load the extension
npm run format    # Prettier
```

## License

MIT. See `LICENSE`. The fonts in `fonts/` are under the SIL Open Font License 1.1. See `fonts/OFL-*.txt`.

# Diario Migrante Changelog

## September 8, 2026 — Escrito en español

- Starting with tomorrow's edition, every story is written in Spanish from the first word. Until today the morning agent wrote in English and a translator turned it into Spanish at publish time, and the seams showed: "Sept. 6" for a date, "U.S." for the country, an agency's name left in English halfway down a paragraph.
- The paper has a house style now, a libro de estilo both writers follow: dates in words ("el 6 de septiembre"), "Estados Unidos" spelled out, every agency named in Spanish with its sigla on first mention, place names with their accents (Indianápolis, Filadelfia), never "ilegal" for a person. The weekly Las herramientas pages follow the same sheet.
- Every story keeps the same four parts under the same names: Datos clave, Contexto, Qué significa esto, Qué hacer ahora.
- For agents: `body_es` is the story as written; `body` carries an English version only on stories from before September 8, 2026.

## September 1, 2026 — Las herramientas

- The paper has a reference desk now. **diariomigrante.com/herramientas** holds four pages in plain Spanish, each answering one question people search: how long USCIS is taking on each form, what this month's visa bulletin means for your category, what every common form costs (and how to pay less), and where the TPS stands country by country.
- Every number on them was read from the official page the same day and says so: each page carries the date it was checked and a button to its source (USCIS, the State Department, the Federal Register). The pages are written for readers with little formal education; every term is explained once.
- They stay current on their own: every Monday morning an agent re-reads each source and rewrites the page, so the bulletin turns over with the month and a fee change lands within the week.
- The section line under the masthead now reads Portada · Ediciones · El calendario · Las herramientas · El registro on every page.
- For agents: **/herramientas.md**, **/herramientas/:slug.md**, and **/api/herramientas** (JSON, with the markdown body).

## September 1, 2026 — El calendario

- The paper has a calendar now. **diariomigrante.com/calendario** lists the dates that matter to immigrants — TPS end dates, rules taking effect, forms that change, comment deadlines, hearings — month by month, the close ones flagged "en 8 días", the past ones kept underneath. Every date came out of a story the paper ran, and each links to that story and to its source.
- Each date has its own page (**/calendario/1/termina-el-tps-de-el-salvador…**): what happens that day, who it touches, what to do, and the story behind it.
- Put it in your phone: **Añadir a mi calendario** subscribes your calendar app to the feed at **/calendario.ics**, so new dates show up on their own. Any single date can be added by itself.
- When a date falls within the week, the morning email carries an "Esta semana vence" strip under the stories.
- The morning agent keeps it current: a story that sets a concrete future date puts it on the calendar as it's written.
- Every page now carries a section line under the masthead — Portada · Ediciones · El calendario · El registro.
- For agents: **/calendario.md**, **/api/fechas** (JSON), and a new MCP tool, `proximas_fechas`.

## August 25, 2026 — Cada noticia, su propia página

- Every story now has a permanent address — **diariomigrante.com/noticia/1360/ice-reporta-1-328-arrestos…** — with the headline, the summary, the drawing, a button to the original article, and the full write-up in Spanish. Until today the 170 stories only existed inside their edition pages; now each one can be found, shared, and indexed on its own.
- Tap any headline or drawing on the front page or an edition to open the story. Under it, the rest of that day's paper, and the way back to the full edition.
- Every edition now links to the one before and after it, so no day is a dead end, and the sitemap lists all 170 stories alongside the 40 editions.
- For AI agents: every story reads as clean text at **/noticia/:id.md**, the MCP tools return a permalink with each result, and `noticia_completa` now hands back the Spanish write-up instead of the English draft.
- Plumbing: plain-http addresses redirect to https in one hop, and the text-only copies tell search engines to index the real page instead.

## August 25, 2026 — Cada noticia lleva a su fuente

- Every story in the morning email is a link now. Tap the headline, or the "Leer en …" line under it, and you land on the original article — the paper's whole stance is analysis over real sources, and the email finally shows them.
- The email no longer gets cut off at the bottom in the Gmail app on iPhone. The illustrations now declare their size up front, so the app reserves the room before they load and the last lines — the link to the full edition, the unsubscribe line — stay on screen.

## August 16, 2026 — El sombrero

- The paper has a mark now: a reporter's hat with a DM press card tucked in the band. It lives in the browser tab — look up. The masthead stays pure blackletter.

## August 16, 2026 — El diario es una herramienta

- The paper is a full MCP server now — the standard plug AI assistants use to connect to tools. Point Claude (or any MCP client) at **diariomigrante.com/mcp** and the paper answers directly: read any edition, search all past coverage by keyword, pull a full article, or subscribe a reader — five tools, no key required.
- In Claude Code, one line connects it: `claude mcp add --transport http diario https://diariomigrante.com/mcp`. On claude.ai it's a custom connector with the same address.

## August 16, 2026 — El diario habla con agentes

- The paper now serves AI agents as readers in their own right. **diariomigrante.com/llms.txt** is the guide: what the paper is, every recent edition, and the full open API.
- Any edition reads as clean text now — add **.md** to its address (`/edicion/2026-08-16.md`), or ask for **/portada.md** and get today's paper: headlines, summaries, and source links, no HTML in the way.
- An agent can even subscribe a reader through the API, and robots.txt now says plainly that search engines and AI assistants are welcome to read the news.

## August 16, 2026 — Cada edición, su dirección

- Every edition now has a permanent address: **diariomigrante.com/edicion/2026-08-16** is that morning's front page, forever. Share a day, link a day — the índice rows point there now.
- The paper prints on the server: stories arrive in the page itself instead of assembling in your browser, so search engines — and anyone with JavaScript off — finally read the news instead of a blank sheet.
- A sitemap hands Google the whole archive, edition by edition.

## August 14, 2026 — La hemeroteca

- The paper has a back-issues index now: **diariomigrante.com/ediciones** lists every edition, grouped by month — date, lead headline, and story count on each line, dot leaders and all.
- Every row opens that day's actual front page: the portada now prints any past edition, not just today's.
- **EDICIONES ANTERIORES** in the front page's dateline is the door.

## August 13, 2026 — La tarifa de suscripción

- The subscribe ad now quotes its terms like an old paper's rate card, dot leaders and all: Entrega … 7:00 de la mañana · Edición … Lunes a domingo · Precio … **Gratis**. The one-line pitch is retired.
- The whole box got quieter — pale hairlines instead of heavy rules, and a slimmer button.

## August 13, 2026 — El correo es el periódico

- The email dropped its card: it now prints edge to edge on white, like the paper itself.
- The real blackletter masthead arrived in the inbox, with the folio rules and the edition number — the same head the front page wears.
- Stories run with their drawings under hairline dividers, lead first with LO QUE IMPORTA HOY, colophon at the foot.

## August 12, 2026 — La suscripción entró al periódico

- The subscribe box moved into the page itself: it now runs as a column beside the last story, like a paper's own house ad — SUSCRÍBETE, one line, and the form right there. The footer keeps just the colophon.

## August 12, 2026 — Titulares de periódico

- Headlines got tighter: twelve words or fewer, keeping the actor and the fact. The translator condenses each title instead of carrying the whole sentence.

## August 12, 2026 — Papel blanco

- The paper prints on white now — the cream newsprint ground went clean white, on the site and in the email alike. The sheet's grain faded to a whisper, and the heavier grain moved to the desk behind the page.

## August 12, 2026 — Todas las ilustraciones, en todas partes

- The day's drawings all make the front page now — one story per column in the band, extra stories in wide bands below. The text-only stack is retired.
- The morning email carries every story's illustration too, each above its headline — it used to show only the first one.
- Email subjects got short: a few sharp words about the lead story instead of the entire headline.

## August 8, 2026 — El diario llega por correo

- Subscribing works now: leave your email on the portada and each morning's edition arrives in your inbox — the five stories that matter, with a one-click way out any time.

## August 8, 2026 — diariomigrante.com

- The paper has its own address now: **diariomigrante.com**. The temporary workers.dev URL is retired, and share previews point at the real domain.

## August 7, 2026 — La portada es un periódico

- The front page is now an actual newspaper: a sheet of grained newsprint with a blackletter Diario Migrante masthead, an edition number and date folio, ruled columns of justified text, and a quiet colophon. The card deck is retired.
- Eight stories per edition instead of five on the front — the lead with its illustration, a three-column band with two more drawings, and a wide bottom band.
- New house art style: flat editorial cartoons — bold color fields, thick outlines, deadpan characters — generated fresh for each morning's stories. The background color rotates story to story so no two mornings look alike.
- El registro got the same newsprint dressing.

## July 17, 2026 — Daily issues, new design, real research

- The site now publishes as numbered daily issues — one issue per day, with arrows to walk back through the archive.
- New look: Geist, white, quiet. Built for reading.
- Every story is now researched and written each morning by an AI agent that searches the open web for the last 24-48 hours of immigration news, writes original analysis, and links the real source. The old scraper and its broken articles are gone — the archive restarts at Issue No. 1.
- Every story gets its own editorial illustration, generated when the story is published — symbolic line art, never stock photos. The lead story carries it on the front page; every article shows it in the reading view.

import { MARKER } from "./pages.ts";

export type Step =
  | { tool: "navigate"; url: string }
  | {
      tool: "click" | "type" | "press";
      // The element's ref is read from the previous step's page state.
      find?: RegExp;
      args: Record<string, unknown>;
    };

export interface Scenario {
  name: string;
  kind: "synthetic" | "real";
  // Synthetic pages show this when their content is ready.
  marker?: string;
  steps: Step[];
}

const button = (name: string) => new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`);
const link = (name: string) => new RegExp(`link "${name}" \\[ref=(e\\d+)\\]`);

export function syntheticScenarios(url: (name: string) => string): Scenario[] {
  const nav = (name: string): Scenario => ({
    name: `nav ${name}`,
    kind: "synthetic",
    marker: MARKER,
    steps: [{ tool: "navigate", url: url(name) }],
  });
  const click = (name: string, label: string, marker: string | undefined = MARKER): Scenario => ({
    name: `click ${name}`,
    kind: "synthetic",
    ...(marker ? { marker } : {}),
    steps: [
      { tool: "navigate", url: url(name) },
      { tool: "click", find: button(label), args: {} },
    ],
  });
  const type = (name: string, find: RegExp): Scenario => ({
    name: `type ${name}`,
    kind: "synthetic",
    marker: MARKER,
    steps: [
      { tool: "navigate", url: url(name) },
      { tool: "type", find, args: { text: "abc" } },
    ],
  });
  return [
    nav("static"),
    nav("beacon-noise"),
    nav("image-stream"),
    nav("spinner-slow"),
    nav("skeleton-slow"),
    nav("longpoll"),
    nav("ticker"),
    nav("late-script"),
    nav("progressive-feed"),
    click("click-fetch-fast", "Load"),
    click("click-fetch-slow-plain", "Load"),
    click("click-fetch-slow-spinner", "Load"),
    click("autosave", "Save"),
    click("click-post-slow", "Submit"),
    click("click-noop", "Nothing", undefined),
    click("click-fetch-render", "Load"),
    click("click-fetch-own-slow", "Load"),
    nav("empty-then-render"),
    type("search-debounced", /textbox "Search" \[ref=(e\d+)\]/),
    type("filter-debounced", /searchbox "Filter by name" \[ref=(e\d+)\]/),
    click("submit-nav", "Send"),
    {
      name: "click spa-route",
      kind: "synthetic",
      marker: MARKER,
      steps: [
        { tool: "navigate", url: url("spa-route") },
        { tool: "click", find: link("Next page"), args: {} },
      ],
    },
  ];
}

const real = (name: string, ...steps: Step[]): Scenario => ({ name, kind: "real", steps });
const go = (url: string): Step => ({ tool: "navigate", url });

// Public pages only (a fresh signed-out profile), across page types.
export const REAL_SCENARIOS: Scenario[] = [
  real("example.com", go("https://example.com")),
  real("hacker news", go("https://news.ycombinator.com"), {
    tool: "click",
    find: link("More"),
    args: {},
  }),
  real("wikipedia", go("https://en.wikipedia.org/wiki/Web_browser")),
  real("wikipedia search", go("https://en.wikipedia.org/wiki/Main_Page"), {
    tool: "type",
    find: /(?:searchbox|combobox|textbox) "Search Wikipedia" \[ref=(e\d+)\]/,
    args: { text: "Rust programming language", submit: true },
  }),
  real("rust blog", go("https://blog.rust-lang.org")),
  real("python docs", go("https://docs.python.org/3/library/os.html")),
  real("mdn", go("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input")),
  real("react.dev", go("https://react.dev"), { tool: "click", find: link("Learn"), args: {} }),
  real("github repo", go("https://github.com/oven-sh/bun"), {
    tool: "click",
    find: /link "Issues[^"]*" \[ref=(e\d+)\]/,
    args: {},
  }),
  real("github issues", go("https://github.com/oven-sh/bun/issues")),
  real("npm", go("https://www.npmjs.com/package/react")),
  real("stackoverflow", go("https://stackoverflow.com/questions/tagged/javascript")),
  real("amazon search", go("https://www.amazon.in/s?k=usb+c+hub")),
  real("ebay search", go("https://www.ebay.com/sch/i.html?_nkw=usb+c+hub")),
  real("flipkart", go("https://www.flipkart.com/search?q=usb+hub")),
  real("saucedemo login", go("https://www.saucedemo.com"), {
    tool: "type",
    find: /textbox "Username" \[ref=(e\d+)\]/,
    args: { text: "standard_user" },
  }),
  real("bbc news", go("https://www.bbc.com/news")),
  real("the verge", go("https://www.theverge.com")),
  real("duckduckgo", go("https://duckduckgo.com/?q=bun+javascript+runtime")),
  real("bing", go("https://www.bing.com/search?q=bun+javascript+runtime")),
  real("youtube", go("https://www.youtube.com")),
  real("reddit", go("https://www.reddit.com/r/programming/")),
  real("timeanddate clock", go("https://www.timeanddate.com/worldclock/")),
  real("w3schools iframes", go("https://www.w3schools.com/html/html_iframe.asp")),
  real("herokuapp dynamic loading", go("https://the-internet.herokuapp.com/dynamic_loading/2"), {
    tool: "click",
    find: button("Start"),
    args: {},
  }),
  real("practice login", go("https://practicetestautomation.com/practice-test-login/")),
  real("greenhouse board", go("https://boards.greenhouse.io/vercel")),
  real("linear", go("https://linear.app")),
  real("notion", go("https://www.notion.com")),
  real("tailwind docs", go("https://tailwindcss.com/docs/installation")),
  real("hn item", go("https://news.ycombinator.com/item?id=1")),
  real("google maps", go("https://www.google.com/maps/place/Eiffel+Tower")),
  real("vercel", go("https://vercel.com")),
  real("nytimes", go("https://www.nytimes.com")),
];

const typeIn = (find: RegExp, text: string): Step => ({ tool: "type", find, args: { text } });
const tap = (find: RegExp): Step => ({ tool: "click", find, args: {} });
const field = (name: string) =>
  new RegExp(`(?:searchbox|combobox|textbox) "${name}" \\[ref=(e\\d+)\\]`);

// In-page interactions on public pages (nothing is submitted) and pages that draw late.
export const INTERACTION_SCENARIOS: Scenario[] = [
  real(
    "wikipedia typeahead",
    go("https://en.wikipedia.org/wiki/Main_Page"),
    typeIn(field("Search Wikipedia"), "Rust prog"),
  ),
  real("youtube typeahead", go("https://www.youtube.com"), typeIn(field("Search"), "lofi")),
  real(
    "amazon typeahead",
    go("https://www.amazon.in"),
    typeIn(field("Search Amazon\\.in"), "usb c"),
  ),
  real(
    "mdn search",
    go("https://developer.mozilla.org/en-US/"),
    tap(/button "Search[^"]*" \[ref=(e\d+)\]/),
    typeIn(field('[^"]*'), "flexbox"),
  ),
  real(
    "react.dev search",
    go("https://react.dev"),
    tap(/button "Search[^"]*" \[ref=(e\d+)\]/),
    typeIn(field('[^"]*'), "useEffect"),
  ),
  real("caniuse search", go("https://caniuse.com"), typeIn(field('[^"]*'), "flexbox")),
  real(
    "huggingface filter",
    go("https://huggingface.co/models"),
    typeIn(field('[^"]*(?:[Ff]ilter|[Ss]earch)[^"]*'), "llama"),
  ),
  real("crates.io search", go("https://crates.io"), {
    tool: "type",
    find: field('[^"]*'),
    args: { text: "serde", submit: true },
  }),
  real(
    "github branch picker",
    go("https://github.com/oven-sh/bun"),
    tap(/button "[^"]*(?:branch|main)[^"]*" \[ref=(e\d+)\]/i),
  ),
  real(
    "github issues closed",
    go("https://github.com/oven-sh/bun/issues"),
    tap(/link "Closed[^"]*" \[ref=(e\d+)\]/),
  ),
  real(
    "github repo tab",
    go("https://github.com/oven-sh/bun"),
    tap(/link "Pull requests[^"]*" \[ref=(e\d+)\]/),
  ),
  real(
    "github file tree",
    go("https://github.com/oven-sh/bun"),
    tap(/link "docs(?:, \(Directory\))?" \[ref=(e\d+)\]/),
  ),
  real(
    "wikipedia tools menu",
    go("https://en.wikipedia.org/wiki/Web_browser"),
    tap(/(?:button|checkbox) "Tools" \[ref=(e\d+)\]/),
  ),
  real(
    "duckduckgo images",
    go("https://duckduckgo.com/?q=bun+runtime"),
    tap(/link "Images" \[ref=(e\d+)\]/),
  ),
  real(
    "herokuapp dynamic controls",
    go("https://the-internet.herokuapp.com/dynamic_controls"),
    tap(button("Remove")),
  ),
  real(
    "herokuapp dynamic loading 1",
    go("https://the-internet.herokuapp.com/dynamic_loading/1"),
    tap(button("Start")),
  ),
  real("spotify", go("https://open.spotify.com/")),
  real("twitch", go("https://www.twitch.tv/directory")),
  real("airbnb", go("https://www.airbnb.com")),
  real("linkedin jobs", go("https://www.linkedin.com/jobs/search?keywords=engineer")),
  real("medium", go("https://medium.com/tag/programming")),
  real("producthunt", go("https://www.producthunt.com")),
  real("pinterest ideas", go("https://www.pinterest.com/ideas/")),
  real("coursera", go("https://www.coursera.org/search?query=python")),
  real("dev.to", go("https://dev.to")),
];

// Signed-in apps: pages are opened and read, one email is opened; nothing is sent or moved.
export const SIGNED_IN_SCENARIOS: Scenario[] = [
  real("gmail inbox", go("https://mail.google.com/mail/u/0/#inbox"), {
    tool: "click",
    find: /link "Starred" \[ref=(e\d+)\]/,
    args: {},
  }),
  real("gmail search", go("https://mail.google.com/mail/u/0/#search/from%3Agoogle")),
  real("gmail search box", go("https://mail.google.com/mail/u/0/#inbox"), {
    tool: "type",
    find: /(?:textbox|combobox) "Search mail" \[ref=(e\d+)\]/,
    args: { text: "invoice", submit: true },
  }),
  real("gmail open email", go("https://mail.google.com/mail/u/0/#inbox"), {
    tool: "click",
    // The first message row: row, checkbox, star button, then the link that opens it.
    find: /- row "[^\n]*\n\s+- checkbox[^\n]*\n\s+- button "[^"]*"[^\n]*\n\s+- link "[^"]*" \[ref=(e\d+)\]/,
    args: {},
  }),
  real("drive", go("https://drive.google.com/drive/my-drive")),
  real("calendar", go("https://calendar.google.com/calendar/r")),
  real("docs list", go("https://docs.google.com/document/u/0/")),
];
